'use strict';

/**
 * tts.js — ElevenLabs Text-to-Speech
 *
 * Converts a short text string into audio bytes using the ElevenLabs
 * TTS API and returns the raw buffer with its MIME type.
 *
 * ElevenLabs docs: https://elevenlabs.io/docs/api-reference/text-to-speech
 */

const fetch    = require('node-fetch');
const settings = require('./settings');

const TTS_BASE = 'https://api.elevenlabs.io/v1/text-to-speech';

/**
 * Synthesize speech from text.
 *
 * @param {string} text         - The text to speak (keep short — summary only).
 * @param {object} [opts]
 * @param {string} [opts.voiceId] - ElevenLabs voice ID override.
 * @returns {Promise<{audioBuffer: Buffer, mimeType: string}>}
 */
async function synthesizeSpeech(text, opts = {}) {
  const apiKey = settings.getElevenLabsKey();
  if (!apiKey) {
    throw new Error('No ElevenLabs API key configured. Open Settings to add one.');
  }

  if (!text || !text.trim()) {
    throw new Error('Cannot synthesize empty text.');
  }

  const voiceId = opts.voiceId || settings.getSetting('voiceId', 'onwK4e9ZLuTAKqWW03F9');
  const url = `${TTS_BASE}/${voiceId}`;

  console.log(`[TTS] Synthesizing ${text.length} chars with voice ${voiceId}`);
  const t0 = Date.now();

  const response = await fetch(url, {
    method:  'POST',
    headers: {
      'xi-api-key':   apiKey,
      'Content-Type': 'application/json',
      'Accept':       'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id: 'eleven_turbo_v2_5',
      voice_settings: {
        stability:        0.5,
        similarity_boost: 0.75,
      },
      speed:         1.15,
      output_format: 'mp3_44100_128',
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '(no body)');
    throw new Error(`ElevenLabs TTS error [${response.status}]: ${errorText}`);
  }

  const arrayBuf = await response.arrayBuffer();
  const audioBuffer = Buffer.from(arrayBuf);
  const durationMs = Date.now() - t0;

  console.log(`[TTS] Synthesis complete in ${durationMs}ms: ${audioBuffer.length} bytes`);

  return { audioBuffer, mimeType: 'audio/mpeg' };
}

/**
 * Stream TTS audio chunks from ElevenLabs, calling onChunk for each binary chunk.
 * Audio starts arriving after ~100–200ms, enabling playback before synthesis completes.
 *
 * @param {string}   text      - Text to synthesize.
 * @param {Function} onChunk   - Called with each Buffer chunk as it arrives.
 * @param {object}   [opts]
 * @param {string}   [opts.voiceId]
 * @returns {Promise<void>}
 */
async function streamSpeech(text, onChunk, opts = {}) {
  const apiKey = settings.getElevenLabsKey();
  if (!apiKey) throw new Error('No ElevenLabs API key configured. Open Settings to add one.');
  if (!text || !text.trim()) throw new Error('Cannot synthesize empty text.');

  const voiceId = opts.voiceId || settings.getSetting('voiceId', 'onwK4e9ZLuTAKqWW03F9');
  const url = `${TTS_BASE}/${voiceId}/stream`;

  console.log(`[TTS] Streaming ${text.length} chars with voice ${voiceId}`);

  const response = await fetch(url, {
    method:  'POST',
    headers: {
      'xi-api-key':   apiKey,
      'Content-Type': 'application/json',
      'Accept':       'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id: 'eleven_turbo_v2_5',
      voice_settings: {
        stability:        0.5,
        similarity_boost: 0.75,
      },
      speed:         1.15,
      output_format: 'mp3_44100_128',
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '(no body)');
    throw new Error(`ElevenLabs TTS stream error [${response.status}]: ${errorText}`);
  }

  for await (const rawChunk of response.body) {
    onChunk(Buffer.from(rawChunk));
  }
}

module.exports = { synthesizeSpeech, streamSpeech };
