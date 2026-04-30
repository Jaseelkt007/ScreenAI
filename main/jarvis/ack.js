'use strict';

/**
 * ack.js — M4.7 acknowledgement-TTS helper.
 *
 * After the classifier returns a high-confidence pattern match, the pipeline
 * fires a short ack ("On it", "Opening Chrome", "Searching") in PARALLEL with
 * dispatch so the user hears the system within ~200 ms instead of waiting for
 * the full action + verify + result-TTS chain.
 *
 * The ack never blocks dispatch. If it fails to synthesize, the pipeline
 * carries on silently — the result-tier TTS still fires after verify.
 *
 * Pure data + tiny logic; pulls TTS lazily so this module loads in pure-Node
 * tests without Electron / network deps.
 */

// ─── Intent → ack phrase map ──────────────────────────────────────────────────

// Keep phrases short (under 4 words). The ack is an audible cue, not a status
// report — that's what the result-TTS is for.
const ACK_BY_INTENT = {
  // App / window
  'app.open':         'Opening it.',
  'app.close':        'Closing.',
  'app.focus':        'Switching.',
  'window.minimize':  'Minimizing.',
  'window.maximize':  'Maximizing.',
  'window.switch':    'Switching.',

  // Files
  'file.find':        'Searching.',
  'file.open':        'Opening.',
  'file.create':      'Creating.',
  'file.read':        'Reading.',
  'file.write':       'Writing.',
  'file.append':      'Appending.',
  'file.list':        'Listing.',
  'file.mkdir':       'Creating folder.',
  'file.delete':      null,   // wait for confirm
  'file.rename':      null,   // wait for confirm
  'file.move':        null,   // wait for confirm

  // Browser
  'browser.open':       'Opening browser.',
  'browser.goto':       'Going there.',
  'browser.search':     'Searching.',
  'browser.site':       'On it.',
  'browser.newtab':     'New tab.',
  'browser.closetab':   'Closing tab.',
  'browser.back':       'Back.',
  'browser.refresh':    'Refreshing.',
  'browser.addressbar': 'OK.',

  // Input
  'input.type':       null,   // length-based; let the result fire
  'input.key':        'OK.',
  'input.shortcut':   'OK.',

  // System
  'system.volume':     null,   // very fast — ack would overlap result
  'system.brightness': null,
  'system.lock':       null,   // wait for confirm
  'clipboard.write':   'Copied.',

  // UI control
  'ui.click':         'Clicking.',
  'ui.fill':          'Filling.',
  'ui.read':          'Reading.',
  'ui.list':          null,

  // Disambiguation / housekeeping — silent
  'system.select':    null,
  'system.cancel':    null,
  'system.unsupported': null,
};

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Decide the ack phrase for an intent. Returns null when no ack should fire.
 * @param {string} intent
 * @param {object} [params]   — optional, lets us tweak per-call (e.g. include app name)
 * @param {object} [opts]
 * @param {boolean} [opts.needsConfirm] — when true, returns null so we wait for confirm
 */
function ackPhraseFor(intent, params = {}, opts = {}) {
  if (!intent) return null;
  if (opts.needsConfirm) return null;       // wait for confirmation gate first

  const base = ACK_BY_INTENT[intent];
  if (base === undefined) return null;       // unknown intent → silent
  if (base === null) return null;            // explicitly silent

  // Per-intent enrichments — keep these tiny.
  if (intent === 'app.open' && params.appName)  return `Opening ${params.appName}.`;
  if (intent === 'app.close' && params.appName) return `Closing ${params.appName}.`;
  if (intent === 'app.focus' && params.appName) return `Switching to ${params.appName}.`;
  if (intent === 'browser.site' && params.siteName) return `Opening ${params.siteName}.`;
  if (intent === 'ui.click' && params.name)     return `Clicking ${params.name}.`;
  if (intent === 'ui.fill'  && params.name)     return `Filling ${params.name}.`;
  if (intent === 'ui.read'  && params.name)     return `Reading ${params.name}.`;

  return base;
}

/**
 * Fire a non-blocking ack TTS and emit it to the HUD. Never throws.
 *
 * Intentionally does NOT await: callers should call this and immediately
 * continue with dispatch. The promise it returns is for tests / tracing.
 *
 * @param {string}   phrase   — short ack to speak (already chosen)
 * @param {Function} hudSend  — (channel, payload) => void
 * @param {object}   [opts]
 * @param {Function} [opts.synthesizeSpeech] — DI for tests; defaults to tts.synthesizeSpeech
 * @returns {Promise<{ ok: boolean, ms: number, error?: string }>}
 */
async function fireAck(phrase, hudSend, opts = {}) {
  if (!phrase || typeof phrase !== 'string') return { ok: false, ms: 0, error: 'no phrase' };
  const t0 = Date.now();
  try {
    const synth = opts.synthesizeSpeech || (require('../tts').synthesizeSpeech);
    const result = await synth(phrase);
    const ms = Date.now() - t0;
    if (typeof hudSend === 'function') {
      try {
        hudSend('jarvis:audio-ack', {
          phrase,
          audioBase64: result.audioBuffer.toString('base64'),
          mimeType:    result.mimeType,
          latencyMs:   ms,
        });
      } catch { /* HUD failure is non-fatal */ }
    }
    return { ok: true, ms };
  } catch (err) {
    return { ok: false, ms: Date.now() - t0, error: err.message };
  }
}

module.exports = { ackPhraseFor, fireAck, ACK_BY_INTENT };
