'use strict';

/**
 * llm.js
 *
 * Handles communication with the Gemini Vision API.
 *
 * The Gemini multimodal API accepts an interleaved array of image parts and
 * text parts. We send:
 *   1. The cropped screenshot as an inline base64-encoded PNG.
 *   2. The user's text question.
 *
 * Gemini returns a candidates array; we extract the first candidate's text.
 *
 * Docs: https://ai.google.dev/api/generate-content
 */

const fetch    = require('node-fetch');
const settings = require('./settings');

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

// ─── Main export ───────────────────────────────────────────────────────────

/**
 * Stream a screenshot + prompt to Gemini, calling onChunk for each text piece.
 *
 * @param {Buffer}   imageBuffer - PNG image buffer of the captured region.
 * @param {string}   prompt      - User's natural-language question.
 * @param {Function} onChunk     - Called with each incremental text string.
 * @returns {Promise<void>}      - Resolves when the stream ends.
 */
async function streamLLM(imageBuffer, prompt, history, onChunk) {
  const apiKey = settings.getApiKey();

  if (!apiKey) {
    throw new Error(
      'No Gemini API key found.\n' +
      'Click the tray icon → Settings to enter your key.'
    );
  }

  const model = settings.getModel();
  const url   = `${GEMINI_API_BASE}/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;

  const body = buildRequestBody(imageBuffer, prompt, history);

  console.log(`[LLM] Starting stream request to ${model}...`);

  const response = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '(no body)');
    throw new Error(`Gemini API error [${response.status}]: ${errorText}`);
  }

  // Parse the SSE stream: each line is either "data: {...}" or blank.
  let buffer   = '';
  let charCount = 0;

  for await (const rawChunk of response.body) {
    buffer += rawChunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep any incomplete trailing line

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const jsonStr = line.slice(6).trim();
      if (!jsonStr || jsonStr === '[DONE]') continue;

      let data;
      try { data = JSON.parse(jsonStr); } catch { continue; }

      const text = extractText(data);
      if (text) {
        charCount += text.length;
        onChunk(text);
      }
    }
  }

  if (charCount === 0) {
    throw new Error('Gemini returned an empty response. Try a different question.');
  }

  console.log(`[LLM] Stream complete (${charCount} chars).`);
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Build the Gemini generateContent request body.
 *
 * The screenshot is always prepended to the first user message so the model
 * retains visual context across all turns in the conversation.
 *
 * @param {Buffer} imageBuffer - PNG image of the captured region.
 * @param {string} prompt      - The current user question (not yet in history).
 * @param {Array}  history     - Completed turns: [{role:'user'|'model', content:'...'}].
 */
function buildRequestBody(imageBuffer, prompt, history = []) {
  const imageData = {
    inline_data: { mime_type: 'image/png', data: imageBuffer.toString('base64') },
  };

  const contents = [];

  if (history.length === 0) {
    // First turn: image + question in a single user message.
    contents.push({ role: 'user', parts: [imageData, { text: prompt }] });
  } else {
    // Prepend screenshot to the very first historical user message.
    for (let i = 0; i < history.length; i++) {
      const h          = history[i];
      const geminiRole = h.role === 'user' ? 'user' : 'model';
      const parts      = i === 0
        ? [imageData, { text: h.content }]
        : [{ text: h.content }];
      contents.push({ role: geminiRole, parts });
    }
    // Append the new user question.
    contents.push({ role: 'user', parts: [{ text: prompt }] });
  }

  return {
    contents,
    generationConfig: {
      temperature:     0.4,   // Low temperature for factual screen analysis.
      maxOutputTokens: 2048,
    },
    safetySettings: [
      // Relax some safety filters that can trigger on developer content
      // (code errors, stack traces, etc.).
      { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
    ],
  };
}

/**
 * Extract the text string from a Gemini API response object.
 * Navigates the nested candidates → content → parts → text structure.
 */
function extractText(data) {
  return (
    data?.candidates?.[0]?.content?.parts
      ?.map((p) => p.text || '')
      .join('') || ''
  );
}

module.exports = { streamLLM };
