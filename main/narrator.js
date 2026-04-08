'use strict';

/**
 * narrator.js — Selective TTS for agent events
 *
 * Sits between the AgentRunner event stream and tts.js.
 * Rules:
 *   - milestone + response + error → spoken (rate-limited)
 *   - tool_call → accumulate silently, summarize after BATCH_WINDOW_MS
 *   - tool_result + thinking → always silent
 *   - Never speak two things within RATE_LIMIT_MS of each other
 */

const RATE_LIMIT_MS  = 3500;   // minimum gap between TTS calls
const BATCH_WINDOW_MS = 9000;  // debounce window before summarizing tool calls
const BATCH_SPEAK_AT = 8;      // speak batch immediately if this many silent calls pile up

class Narrator {
  /**
   * @param {(text: string) => Promise<void>} speakFn — async function to play TTS
   */
  constructor(speakFn) {
    this._speak       = speakFn;
    this._lastAt      = 0;
    this._silentCount = 0;
    this._batchTimer  = null;
  }

  /** Feed a normalized agent event into the narrator. */
  feed(event) {
    switch (event.type) {
      case 'milestone':
        this._clearBatch();
        this._trySpeak(
          event.detail
            ? `${event.label}: ${event.detail}`
            : event.label
        );
        break;

      case 'response': {
        this._clearBatch();
        // Truncate long responses for natural TTS length
        const text = (event.detail || '').trim();
        const spoken = text.length > 280
          ? text.slice(0, 280).replace(/\s+\S*$/, '') + '…'
          : text;
        if (spoken) this._trySpeak(spoken);
        break;
      }

      case 'error':
        this._clearBatch();
        this._trySpeak(`Error: ${event.label}`);
        break;

      case 'tool_call':
        this._silentCount++;
        if (this._silentCount >= BATCH_SPEAK_AT) {
          this._flushBatch();
        } else if (!this._batchTimer) {
          this._batchTimer = setTimeout(() => this._flushBatch(), BATCH_WINDOW_MS);
        }
        break;

      // Always silent
      case 'tool_result':
      case 'thinking':
      default:
        break;
    }
  }

  /** Reset narrator state (call when starting a new agent session). */
  reset() {
    this._clearBatch();
    this._silentCount = 0;
    this._lastAt      = 0;
  }

  // ── Private ───────────────────────────────────────────────────────────────

  _flushBatch() {
    const n = this._silentCount;
    this._silentCount = 0;
    this._clearBatch();
    if (n > 0) {
      this._trySpeak(
        n === 1
          ? 'Running an operation…'
          : `Running ${n} operations…`
      );
    }
  }

  _clearBatch() {
    if (this._batchTimer) {
      clearTimeout(this._batchTimer);
      this._batchTimer = null;
    }
  }

  _trySpeak(text) {
    const now = Date.now();
    if (now - this._lastAt < RATE_LIMIT_MS) return;
    this._lastAt = now;
    this._speak(text).catch((err) => {
      console.warn('[Narrator] TTS failed (non-fatal):', err.message);
    });
  }
}

module.exports = { Narrator };
