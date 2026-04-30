'use strict';

/**
 * tools/vision.js — M5.2 strict-fallback screen vision.
 *
 * Captures a screenshot (full screen) and asks Gemini Vision what's there.
 * Used by the planner ONLY when ui.list returned 0 elements AND CDP isn't
 * available — heavy custom-canvas apps, games, dialogs without UIA names.
 *
 * The screenshot is JPEG-compressed before being sent to keep latency under
 * ~1.5 s end-to-end on a typical Gemini Flash call.
 *
 * Pure Node — relies on screenshot-desktop + jimp + node-fetch (already
 * dependencies for the existing screenshot/ask flow).
 */

const settings = require('../../settings');

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

const SYSTEM_PROMPT = `You are an assistant looking at a Windows desktop screenshot to help a voice agent.
Return STRICT JSON of the shape:
{
  "summary": "<one sentence on what is visible>",
  "elements": [
    { "label": "<short label>", "kind": "button|link|text|icon|input|image", "approxBounds": { "x":0..1, "y":0..1, "w":0..1, "h":0..1 } | null }
  ]
}
- Maximum 8 elements.
- approxBounds are normalised 0..1 of screen width/height. Set to null when uncertain.
- No markdown, no commentary — only the JSON.`;

/**
 * @param {object} opts
 * @param {'focused'|'screen'} [opts.scope='focused']  — best-effort; we capture full screen and tell the model which window is active
 * @param {string} [opts.question]
 * @returns {Promise<ToolResult>}
 */
async function read({ scope = 'focused', question } = {}) {
  if (!settings.getSetting('jarvisVisionEnabled', true)) {
    return { ok: false, error: 'Vision tool disabled in settings.', action: '' };
  }
  const apiKey = settings.getApiKey();
  if (!apiKey) return { ok: false, error: 'No Gemini API key configured.', action: '' };

  // Capture screenshot. screenshot-desktop is the same module main/screenshot.js uses.
  let pngBuffer;
  try {
    const screenshotDesktop = require('screenshot-desktop');
    pngBuffer = await screenshotDesktop({ format: 'png' });
  } catch (err) {
    return { ok: false, error: `Screenshot failed: ${err.message}`, action: '' };
  }

  // JPEG-compress to keep payload small (Gemini accepts JPEG natively).
  let jpegBuffer;
  try {
    const Jimp = require('jimp');
    const image = await Jimp.read(pngBuffer);
    image.quality(70);
    jpegBuffer = await image.getBufferAsync(Jimp.MIME_JPEG);
  } catch (err) {
    return { ok: false, error: `Image compress failed: ${err.message}`, action: '' };
  }

  const model    = settings.getSetting('jarvisVisionModel', 'gemini-2.5-flash');
  const userText = question
    ? `Window scope: ${scope}. User question: ${question}`
    : `Window scope: ${scope}. What controls and elements are visible?`;

  const url = `${GEMINI_BASE}/models/${model}:generateContent?key=${apiKey}`;
  const body = {
    system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{
      role: 'user',
      parts: [
        { inline_data: { mime_type: 'image/jpeg', data: jpegBuffer.toString('base64') } },
        { text: userText },
      ],
    }],
    generationConfig: {
      temperature:      0.2,
      maxOutputTokens:  1024,
      responseMimeType: 'application/json',
    },
  };

  let res;
  try {
    const fetch = (await import('node-fetch')).default;
    res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, error: `Gemini Vision network: ${err.message}`, action: '' };
  }
  if (!res.ok) {
    let raw = '';
    try { raw = await res.text(); } catch { /* */ }
    return { ok: false, error: `Gemini Vision [${res.status}]: ${raw.slice(0, 200)}`, action: '' };
  }
  let data;
  try { data = await res.json(); } catch { return { ok: false, error: 'Gemini Vision: bad JSON', action: '' }; }

  const text = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
  let parsed = null;
  if (text) {
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    try { parsed = JSON.parse(cleaned); } catch { /* */ }
  }
  if (!parsed) {
    return { ok: false, error: 'Vision returned no usable JSON.', action: '', data: { raw: text.slice(0, 400) } };
  }

  const summary  = String(parsed.summary || '').slice(0, 280);
  const elements = Array.isArray(parsed.elements) ? parsed.elements.slice(0, 8).map((e) => ({
    label:        String(e.label || '').slice(0, 80),
    kind:         String(e.kind  || '').slice(0, 16),
    approxBounds: (e.approxBounds && typeof e.approxBounds === 'object')
      ? {
          x: _clamp01(e.approxBounds.x), y: _clamp01(e.approxBounds.y),
          w: _clamp01(e.approxBounds.w), h: _clamp01(e.approxBounds.h),
        }
      : null,
  })) : [];

  return {
    ok:     true,
    data:   { summary, elements, scope },
    action: summary || `Saw ${elements.length} elements on screen.`,
  };
}

function _clamp01(v) {
  const n = Number(v);
  if (!isFinite(n)) return null;
  return Math.min(1, Math.max(0, n));
}

module.exports = { read };
