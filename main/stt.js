'use strict';

/**
 * stt.js — ElevenLabs batch Speech-to-Text
 *
 * Accepts a raw audio Buffer + MIME type, POSTs to ElevenLabs
 * /v1/speech-to-text using the scribe_v2 model, and returns a
 * normalized transcript object.
 *
 * ElevenLabs docs: https://elevenlabs.io/docs/api-reference/speech-to-text
 */

// node-fetch v3 is ESM-only — load lazily.
let _fetchPromise = null;
function getFetch() {
  if (!_fetchPromise) _fetchPromise = import('node-fetch').then((m) => m.default);
  return _fetchPromise;
}
const FormData = require('form-data');
const settings = require('./settings');

const STT_URL = 'https://api.elevenlabs.io/v1/speech-to-text';

/**
 * Transcribe audio using ElevenLabs batch STT.
 *
 * @param {Buffer} audioBuffer  - Raw audio bytes from MediaRecorder.
 * @param {string} mimeType     - MIME type, e.g. "audio/webm;codecs=opus".
 * @param {object} [opts]
 * @param {string} [opts.languageCode] - BCP-47 language code override.
 * @returns {Promise<{text: string, languageCode: string, durationMs: number}>}
 */
async function transcribeAudio(audioBuffer, mimeType, opts = {}) {
  const apiKey = settings.getElevenLabsKey();
  if (!apiKey) {
    throw new Error('No ElevenLabs API key configured. Open Settings to add one.');
  }

  if (!audioBuffer || audioBuffer.length === 0) {
    throw new Error('Empty audio buffer — nothing to transcribe.');
  }

  console.log(`[STT] Starting transcription: ${audioBuffer.length} bytes, mime=${mimeType}`);
  const t0 = Date.now();

  // Determine file extension from MIME type
  const ext = mimeTypeToExt(mimeType);

  const form = new FormData();
  form.append('file', audioBuffer, {
    filename:    `recording.${ext}`,
    contentType: mimeType,
  });
  form.append('model_id', 'scribe_v2');

  const lang = opts.languageCode || settings.getSetting('preferredSttLanguage', '');
  if (lang) form.append('language_code', lang);

  const fetch = await getFetch();
  const response = await fetch(STT_URL, {
    method:  'POST',
    headers: {
      'xi-api-key': apiKey,
      ...form.getHeaders(),
    },
    body: form,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '(no body)');
    throw new Error(`ElevenLabs STT error [${response.status}]: ${errorText}`);
  }

  const data = await response.json();
  const durationMs = Date.now() - t0;

  const text = (data.text || '').trim();
  if (!text) {
    throw new Error('STT returned empty transcript. Try speaking more clearly or check microphone.');
  }

  const languageCode = data.language_code || data.detected_language || 'unknown';

  console.log(`[STT] Transcription complete in ${durationMs}ms: "${text.slice(0, 80)}…"`);

  return { text, languageCode, durationMs };
}

function mimeTypeToExt(mimeType) {
  if (!mimeType) return 'webm';
  const base = mimeType.split(';')[0].trim().toLowerCase();
  const MAP = {
    'audio/webm':  'webm',
    'audio/ogg':   'ogg',
    'audio/mp4':   'mp4',
    'audio/mpeg':  'mp3',
    'audio/wav':   'wav',
    'audio/flac':  'flac',
  };
  return MAP[base] || 'webm';
}

module.exports = { transcribeAudio };
