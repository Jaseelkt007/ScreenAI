'use strict';

/**
 * narrate.js — M5.3 narration TTS helper.
 *
 * Mirrors ack.js, but for *plan-step* narration. The executor (executor.js)
 * fires a short narration phrase before each step (e.g. "Searching the web…",
 * "Opening the page…"). It's a separate audio tier from ack and result so a
 * long plan doesn't cut its own narration off mid-word.
 *
 * Routes to a dedicated `jarvis:audio-narration` channel — the HUD plays it
 * in its own audio slot.
 *
 * Pure JS — TTS is required lazily so this module loads in pure-Node tests.
 */

const settings = require('../settings');

/**
 * Speak a short narration phrase. Non-blocking — the executor calls this and
 * immediately moves on to dispatch the step. Never throws.
 *
 * @param {string}   phrase
 * @param {Function} hudSend
 * @param {object}   [opts]
 * @param {Function} [opts.synthesizeSpeech] — DI for tests
 * @returns {Promise<{ ok: boolean, ms: number, error?: string }>}
 */
async function fireNarration(phrase, hudSend, opts = {}) {
  if (!phrase || typeof phrase !== 'string') return { ok: false, ms: 0, error: 'no phrase' };
  if (!settings.getSetting('jarvisNarrationEnabled', true)) return { ok: false, ms: 0, error: 'narration disabled' };

  const t0 = Date.now();
  try {
    const synth = opts.synthesizeSpeech || (require('../tts').synthesizeSpeech);
    const result = await synth(phrase);
    const ms = Date.now() - t0;
    const volume = Number(settings.getSetting('jarvisNarrationVolume', 0.6)) || 0.6;
    if (typeof hudSend === 'function') {
      try {
        hudSend('jarvis:audio-narration', {
          phrase,
          audioBase64: result.audioBuffer.toString('base64'),
          mimeType:    result.mimeType,
          latencyMs:   ms,
          volume,
        });
      } catch { /* HUD failure is non-fatal */ }
    }
    return { ok: true, ms };
  } catch (err) {
    return { ok: false, ms: Date.now() - t0, error: err.message };
  }
}

module.exports = { fireNarration };
