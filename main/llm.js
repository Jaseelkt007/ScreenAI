'use strict';

/**
 * llm.js
 *
 * Routes requests to either the Gemini Vision API or the OpenAI API
 * depending on the selected model.
 *
 * Gemini docs:  https://ai.google.dev/api/generate-content
 * OpenAI docs:  https://platform.openai.com/docs/api-reference/chat
 */

const fetch    = require('node-fetch');
const settings = require('./settings');

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const OPENAI_API_BASE = 'https://api.openai.com/v1';

// Models that start with these prefixes go to OpenAI
function isOpenAIModel(model) {
  return /^(gpt-|o1|o3|o4)/.test(model);
}

// ─── Main export ───────────────────────────────────────────────────────────

/**
 * Stream a screenshot + prompt to the selected AI, calling onChunk for each text piece.
 *
 * @param {Buffer}   imageBuffer - PNG image buffer of the captured region.
 * @param {string}   prompt      - User's natural-language question.
 * @param {Array}    history     - Completed turns: [{role, content}].
 * @param {Function} onChunk     - Called with each incremental text string.
 * @returns {Promise<void>}
 */
async function streamLLM(imageBuffer, prompt, history, onChunk) {
  const model = settings.getModel();

  if (isOpenAIModel(model)) {
    return streamOpenAI(imageBuffer, prompt, history, onChunk, model);
  }
  return streamGemini(imageBuffer, prompt, history, onChunk, model);
}

// ─── Gemini ────────────────────────────────────────────────────────────────

async function streamGemini(imageBuffer, prompt, history, onChunk, model) {
  const apiKey = settings.getApiKey();

  if (!apiKey) {
    throw new Error(
      'No Gemini API key found.\n' +
      'Click the tray icon → Settings to enter your key.'
    );
  }

  const url = `${GEMINI_API_BASE}/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;
  const body = buildGeminiBody(imageBuffer, prompt, history);

  console.log(`[LLM] Gemini stream → ${model}`);

  const response = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '(no body)');
    throw new Error(`Gemini API error [${response.status}]: ${errorText}`);
  }

  let buffer = '';
  let charCount = 0;

  for await (const rawChunk of response.body) {
    buffer += rawChunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const jsonStr = line.slice(6).trim();
      if (!jsonStr || jsonStr === '[DONE]') continue;

      let data;
      try { data = JSON.parse(jsonStr); } catch { continue; }

      const text = extractGeminiText(data);
      if (text) { charCount += text.length; onChunk(text); }
    }
  }

  if (charCount === 0) throw new Error('Gemini returned an empty response. Try a different question.');
  console.log(`[LLM] Gemini stream complete (${charCount} chars).`);
}

function buildGeminiBody(imageBuffer, prompt, history = []) {
  const imageData = {
    inline_data: { mime_type: 'image/png', data: imageBuffer.toString('base64') },
  };

  const contents = [];

  if (history.length === 0) {
    contents.push({ role: 'user', parts: [imageData, { text: prompt }] });
  } else {
    for (let i = 0; i < history.length; i++) {
      const h          = history[i];
      const geminiRole = h.role === 'user' ? 'user' : 'model';
      const parts      = i === 0 ? [imageData, { text: h.content }] : [{ text: h.content }];
      contents.push({ role: geminiRole, parts });
    }
    contents.push({ role: 'user', parts: [{ text: prompt }] });
  }

  return {
    contents,
    generationConfig: { temperature: 0.4, maxOutputTokens: 2048 },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
    ],
  };
}

function extractGeminiText(data) {
  return (
    data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || ''
  );
}

// ─── OpenAI ────────────────────────────────────────────────────────────────

async function streamOpenAI(imageBuffer, prompt, history, onChunk, model) {
  const apiKey = settings.getOpenAIKey();

  if (!apiKey) {
    throw new Error(
      'No OpenAI API key found.\n' +
      'Click the tray icon → Settings to enter your OpenAI key.'
    );
  }

  const messages = buildOpenAIMessages(imageBuffer, prompt, history);
  const url = `${OPENAI_API_BASE}/chat/completions`;

  console.log(`[LLM] OpenAI stream → ${model}`);

  const response = await fetch(url, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, messages, stream: true, max_tokens: 2048 }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '(no body)');
    throw new Error(`OpenAI API error [${response.status}]: ${errorText}`);
  }

  let buffer = '';
  let charCount = 0;

  for await (const rawChunk of response.body) {
    buffer += rawChunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const jsonStr = line.slice(6).trim();
      if (!jsonStr || jsonStr === '[DONE]') continue;

      let data;
      try { data = JSON.parse(jsonStr); } catch { continue; }

      const text = data?.choices?.[0]?.delta?.content;
      if (text) { charCount += text.length; onChunk(text); }
    }
  }

  if (charCount === 0) throw new Error('OpenAI returned an empty response. Try a different question.');
  console.log(`[LLM] OpenAI stream complete (${charCount} chars).`);
}

function buildOpenAIMessages(imageBuffer, prompt, history = []) {
  const imageBase64 = imageBuffer.toString('base64');
  const imageContent = {
    type:      'image_url',
    image_url: { url: `data:image/png;base64,${imageBase64}`, detail: 'auto' },
  };

  const messages = [];

  if (history.length === 0) {
    messages.push({
      role:    'user',
      content: [imageContent, { type: 'text', text: prompt }],
    });
  } else {
    // Prepend screenshot to first history message
    for (let i = 0; i < history.length; i++) {
      const h    = history[i];
      const role = h.role === 'user' ? 'user' : 'assistant';
      messages.push({
        role,
        content: i === 0 && role === 'user'
          ? [imageContent, { type: 'text', text: h.content }]
          : h.content,
      });
    }
    messages.push({ role: 'user', content: prompt });
  }

  return messages;
}

module.exports = { streamLLM };
