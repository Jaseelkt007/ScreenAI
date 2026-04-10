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
const Jimp     = require('jimp');
const settings = require('./settings');

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const OPENAI_API_BASE = 'https://api.openai.com/v1';

// Models that start with these prefixes go to OpenAI
function isOpenAIModel(model) {
  return /^(gpt-|o1|o3|o4)/.test(model);
}

// Model used exclusively for the voice guide (structured JSON + spoken_summary).
// Kept separate from the user-selected model so the overlay Q&A and voice guide
// can use different models independently.
const VOICE_GUIDE_MODEL = 'gemini-2.5-flash';

// Compress a PNG buffer to JPEG to reduce bytes sent to the vision LLM.
// Quality 75 cuts a ~1MB PNG to ~150–250KB with negligible visual loss.
async function compressToJpeg(pngBuffer, quality = 75) {
  const image = await Jimp.read(pngBuffer);
  image.quality(quality);
  return image.getBufferAsync(Jimp.MIME_JPEG);
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

// ─── Voice Guide (structured output) ──────────────────────────────────────

const VOICE_GUIDE_SYSTEM_PROMPT = `You are a screen-aware assistant. The user has sent you a screenshot and a spoken question.
Your task is to produce two things: a concise written guide (for the screen), and a natural spoken answer (for text-to-speech).

Respond ONLY with a valid JSON object matching this exact schema — no markdown, no extra text:
{
  "summary": "<1 sentence written summary of what the screen shows or what to do>",
  "steps": [
    {
      "id": 1,
      "title": "<short step title>",
      "instruction": "<clear written instruction for this step>",
      "target": { "x": 0.0, "y": 0.0, "w": 0.0, "h": 0.0 } | null,
      "confidence": 0.0
    }
  ],
  "overall_confidence": 0.0,
  "needs_user_confirmation": false,
  "spoken_summary": "<see rules below — generate this LAST>"
}

Rules for spoken_summary (this is read aloud by a text-to-speech voice — generate it LAST):
- STRICT LENGTH: maximum 2 sentences, maximum 50 words total. Be concise.
- Write exactly how you would SPEAK this answer out loud, not how you'd write it.
- Use contractions: you'll, it's, there's, that's, you've.
- Use natural spoken connectors: so, then, from there, basically, just.
- Start with a casual opener: "Sure, ...", "Alright, ...", "So ...", "Looks like ...", "Yeah, ...".
- Never use step numbers, markdown, bullet points, or formal written language.
- Cover the core answer only — the screen shows the full steps.
- If describing the screen: "you've got a terminal open", "looks like the settings panel is up".
- If giving instructions: "just head into Settings and find Notifications — flip that switch off".

Rules for steps and other fields:
- Maximum 3 steps.
- All target coordinates must be normalized 0..1 relative to the screenshot width/height.
- If you cannot locate a UI element precisely, set target to null.
- overall_confidence and step confidence must be 0..1 floats.
- If the question cannot be answered from the screenshot, set overall_confidence below 0.4 and explain naturally in spoken_summary.
- Never invent precise coordinates you cannot see in the image.`;

/**
 * Get a structured voice guide from the LLM.
 *
 * @param {Buffer} imageBuffer  - Full-screen PNG.
 * @param {string} transcript   - User's spoken question.
 * @returns {Promise<object>}   - Validated guide object.
 */
async function getVoiceGuide(imageBuffer, transcript) {
  const model = VOICE_GUIDE_MODEL;
  console.log(`[LLM] Voice guide → ${model}, transcript: "${transcript.slice(0, 60)}"`);
  const t0 = Date.now();

  // Compress PNG → JPEG before sending to cut LLM processing time.
  const t_compress = Date.now();
  const jpegBuffer = await compressToJpeg(imageBuffer);
  console.log(`[LLM] Screenshot compressed: ${imageBuffer.length}b PNG → ${jpegBuffer.length}b JPEG (${Date.now() - t_compress}ms)`);

  let raw;
  if (isOpenAIModel(model)) {
    raw = await fetchVoiceGuideOpenAI(jpegBuffer, transcript, model);
  } else {
    raw = await fetchVoiceGuideGemini(jpegBuffer, transcript, model);
  }

  const guide = parseAndValidateGuide(raw, transcript);
  console.log(`[LLM] Voice guide complete in ${Date.now() - t0}ms`);
  return guide;
}

async function fetchVoiceGuideGemini(imageBuffer, transcript, model) {
  const apiKey = settings.getApiKey();
  if (!apiKey) throw new Error('No Gemini API key configured.');

  const url = `${GEMINI_API_BASE}/models/${model}:generateContent`;

  const body = {
    system_instruction: { parts: [{ text: VOICE_GUIDE_SYSTEM_PROMPT }] },
    contents: [{
      role: 'user',
      parts: [
        { inline_data: { mime_type: 'image/jpeg', data: imageBuffer.toString('base64') } },
        { text: `User question: ${transcript}` },
      ],
    }],
    generationConfig: {
      temperature:      0.2,
      maxOutputTokens:  4096,
      responseMimeType: 'application/json',
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
    ],
  };

  const response = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body:    JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text().catch(() => '(no body)');
    throw new Error(`Gemini guide error [${response.status}]: ${err}`);
  }

  const data = await response.json();
  // Gemini can split long responses across multiple parts — join them all.
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts.map((p) => p.text || '').join('');
}

async function fetchVoiceGuideOpenAI(imageBuffer, transcript, model) {
  const apiKey = settings.getOpenAIKey();
  if (!apiKey) throw new Error('No OpenAI API key configured.');

  const imageBase64 = imageBuffer.toString('base64');
  const messages = [
    { role: 'system', content: VOICE_GUIDE_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}`, detail: 'auto' } },
        { type: 'text', text: `User question: ${transcript}` },
      ],
    },
  ];

  const response = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens:      1024,
      temperature:     0.2,
      response_format: { type: 'json_object' },
    }),
  });

  if (!response.ok) {
    const err = await response.text().catch(() => '(no body)');
    throw new Error(`OpenAI guide error [${response.status}]: ${err}`);
  }

  const data = await response.json();
  return data?.choices?.[0]?.message?.content || '';
}

function parseAndValidateGuide(raw, transcript) {
  let parsed;
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    console.warn('[LLM] Full JSON parse failed:', err.message);
    console.warn('[LLM] Raw response (first 600 chars):', raw.slice(0, 600));

    // Partial recovery: the response is truncated (spoken_summary is last and got cut off).
    // Try to close the JSON and re-parse so we still get summary + steps.
    try {
      // Close open string, object, array, and outer object
      const patched = cleaned
        .replace(/,\s*"spoken_summary"\s*:.*$/s, '')  // drop incomplete spoken_summary
        .replace(/,?\s*$/, '')                         // trim trailing comma
        + '}';
      parsed = JSON.parse(patched);
      console.warn('[LLM] Partial JSON recovery succeeded — spoken_summary dropped');
    } catch {
      // Full fallback
      return {
        transcript,
        spoken_summary:          'I had trouble understanding the screen. Please try again.',
        summary:                 'Could not generate a guide.',
        steps:                   [],
        overall_confidence:      0,
        needs_user_confirmation: true,
      };
    }
  }

  // Normalize and clamp
  const steps = Array.isArray(parsed.steps) ? parsed.steps.slice(0, 3) : [];
  for (const step of steps) {
    if (step.target) {
      step.target.x = clamp01(step.target.x);
      step.target.y = clamp01(step.target.y);
      step.target.w = clamp01(step.target.w);
      step.target.h = clamp01(step.target.h);
    }
    step.confidence = clamp01(step.confidence ?? 0);
  }

  return {
    transcript,
    spoken_summary:          parsed.spoken_summary          || parsed.summary || 'Here is what I found.',
    summary:                 parsed.summary                 || '',
    steps,
    overall_confidence:      clamp01(parsed.overall_confidence ?? 0.5),
    needs_user_confirmation: parsed.needs_user_confirmation ?? false,
  };
}

function clamp01(v) {
  const n = parseFloat(v);
  if (isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

module.exports = { streamLLM, getVoiceGuide };
