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

// node-fetch v3 is ESM-only — import lazily inside async functions.
let _fetchPromise = null;
function getFetch() {
  if (!_fetchPromise) _fetchPromise = import('node-fetch').then((m) => m.default);
  return _fetchPromise;
}
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

  const url = `${GEMINI_API_BASE}/models/${model}:streamGenerateContent?alt=sse`;
  const body = buildGeminiBody(imageBuffer, prompt, history);

  console.log(`[LLM] Gemini stream → ${model}`);

  const fetch = await getFetch();
  const response = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
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

  const fetch = await getFetch();
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

// ─── M4.5: Tool-calling helper for the agent ─────────────────────────────────

/**
 * Call a Gemini-family LLM with function-calling enabled. Used by the M4.5
 * agent layer in main/jarvis/agent.js.
 *
 * Supports:
 *   - Initial user-only prompt
 *   - Multi-turn function-calling loops (caller appends tool responses)
 *
 * @param {object}  args
 * @param {string}  args.model              — e.g. 'gemini-2.5-flash'
 * @param {string}  args.systemPrompt       — system instruction text
 * @param {Array}   args.contents           — Gemini "contents" array (role/parts)
 * @param {Array}   args.functionDeclarations — array from toolSchemas.toGeminiFunctionDeclarations()
 * @param {string}  [args.apiKey]           — overrides settings.getApiKey()
 * @param {AbortSignal} [args.signal]
 * @param {number}  [args.timeoutMs=4000]
 * @param {number}  [args.temperature=0.1]
 * @param {Function}[args.fetchImpl]        — for tests; defaults to global fetch
 * @returns {Promise<{ functionCall: {name,args}|null, text: string|null, raw: object }>}
 */
async function callWithTools({
  model = 'gemini-2.5-flash',
  systemPrompt,
  contents,
  functionDeclarations,
  apiKey,
  signal,
  timeoutMs = 4000,
  temperature = 0.1,
  fetchImpl,
} = {}) {
  const key  = apiKey || settings.getApiKey();
  if (!key) throw new Error('No Gemini API key configured.');
  if (!Array.isArray(contents)) throw new Error('callWithTools: contents must be an array');

  const url  = `${GEMINI_API_BASE}/models/${model}:generateContent?key=${key}`;
  const body = {
    contents,
    generationConfig: { temperature, maxOutputTokens: 512 },
  };
  if (systemPrompt) {
    body.system_instruction = { parts: [{ text: systemPrompt }] };
  }
  if (Array.isArray(functionDeclarations) && functionDeclarations.length > 0) {
    body.tools = [{ function_declarations: functionDeclarations }];
    body.tool_config = { function_calling_config: { mode: 'AUTO' } };
  }

  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), timeoutMs);
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : await getFetch());

  try {
    const res = await doFetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
      signal:  controller.signal,
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '(no body)');
      throw new Error(`Gemini tool-call error [${res.status}]: ${errBody.slice(0, 200)}`);
    }
    const data = await res.json();
    return parseGeminiToolResponse(data);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse a Gemini generateContent response into either a functionCall or text.
 * Exported separately so tests can drive the parser directly without HTTP.
 */
function parseGeminiToolResponse(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  for (const p of parts) {
    if (p.functionCall && p.functionCall.name) {
      return {
        functionCall: {
          name: p.functionCall.name,
          args: p.functionCall.args || {},
        },
        text: null,
        raw:  data,
      };
    }
  }
  const text = parts.map((p) => p.text || '').join('').trim();
  return { functionCall: null, text: text || null, raw: data };
}

// ─── M5.0: Structured-JSON helper for the planner ────────────────────────────

/**
 * Call a Gemini-family LLM with a system prompt + user prompt and ask it to
 * return JSON matching a given (informal) shape. Used by the planner in
 * main/jarvis/planner.js.
 *
 * @param {object}  args
 * @param {string}  args.model
 * @param {string}  args.systemPrompt
 * @param {string}  args.userPrompt
 * @param {string}  [args.apiKey]
 * @param {AbortSignal} [args.signal]
 * @param {number}  [args.timeoutMs=8000]
 * @param {number}  [args.temperature=0.2]
 * @param {Function}[args.fetchImpl]
 * @returns {Promise<{ json: object|null, text: string, raw: object }>}
 */
async function callForJson({
  model = 'gemini-2.5-flash',
  systemPrompt,
  userPrompt,
  apiKey,
  signal,
  timeoutMs = 8000,
  temperature = 0.2,
  fetchImpl,
} = {}) {
  const key = apiKey || settings.getApiKey();
  if (!key) throw new Error('No Gemini API key configured.');
  if (!userPrompt) throw new Error('callForJson: userPrompt required');

  const url  = `${GEMINI_API_BASE}/models/${model}:generateContent?key=${key}`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: {
      temperature,
      maxOutputTokens:  1536,
      responseMimeType: 'application/json',
    },
  };
  if (systemPrompt) body.system_instruction = { parts: [{ text: systemPrompt }] };

  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), timeoutMs);
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : await getFetch());

  try {
    const res = await doFetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
      signal:  controller.signal,
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '(no body)');
      throw new Error(`Gemini JSON error [${res.status}]: ${errBody.slice(0, 200)}`);
    }
    const data  = await res.json();
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const text  = parts.map((p) => p.text || '').join('').trim();
    let json    = null;
    if (text) {
      const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
      try { json = JSON.parse(cleaned); } catch { json = null; }
    }
    return { json, text, raw: data };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { streamLLM, callWithTools, callForJson, parseGeminiToolResponse };
