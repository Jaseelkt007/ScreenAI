'use strict';

/**
 * context.js — Bounded short-lived execution context for the Jarvis pipeline.
 *
 * Holds the most-recently-used window target, file target, and disambiguation
 * candidate list. Every getter performs a TTL check — stale entries return null.
 *
 * TTL is read from settings at call-time so changing jarvisContextTtlMs takes
 * effect immediately without a restart.
 *
 * Pure Node.js — no Electron imports. Module-level singleton (one context per
 * process). Tests must call clear() between cases to avoid state leakage.
 */

const settings = require('../settings');

// ─── Internal state ───────────────────────────────────────────────────────────

let _window = null;        // { processName, hwnd, kind, setAt }
let _file   = null;        // { name, path, setAt }
let _candidates = null;    // { candidates, classifiedResult, setAt }
let _lastAction = null;    // M4.8 — { intent, params, result, transcript, needsConfirm, setAt }
let _activeResultSet = null; // M5.4 — { kind, source, cards, setAt }

// ─── TTL helper ───────────────────────────────────────────────────────────────

function _ttlMs() {
  const v = settings.getSetting('jarvisContextTtlMs', 30000);
  return Number(v) || 30000;
}

/** Returns true if the entry is still fresh (or TTL is 0 = never expires). */
function _fresh(entry) {
  if (!entry) return false;
  const ttl = _ttlMs();
  if (ttl === 0) return true;
  return (Date.now() - entry.setAt) < ttl;
}

// ─── Setters ──────────────────────────────────────────────────────────────────

/**
 * Record the most recently opened/focused window.
 * @param {string} processName — e.g. "notepad", "msedge"
 * @param {number|null} hwnd   — Windows window handle, or null if not captured
 * @param {'app'|'browser'} kind
 */
function setWindowTarget(processName, hwnd, kind) {
  if (!processName) return;
  _window = { processName, hwnd: hwnd || null, kind: kind || 'app', setAt: Date.now() };
}

/**
 * Record the most recently found/opened file.
 * @param {string} name — display filename, e.g. "cv.pdf"
 * @param {string} path — absolute path
 */
function setFileTarget(name, path) {
  if (!name || !path) return;
  _file = { name, path, setAt: Date.now() };
}

/**
 * Store disambiguation candidates after a file op returned multiple matches.
 * @param {Array<{name,path,sizeBytes}>} candidates — up to 5
 * @param {object} classifiedResult                 — the ClassifierResult that triggered ambiguity
 */
function setCandidates(candidates, classifiedResult) {
  if (!candidates || !candidates.length) return;
  _candidates = { candidates, classifiedResult, setAt: Date.now() };
}

/**
 * M4.8 — Record the most recent successfully-dispatched action so the user can
 * say "do that again" or "undo that". Meta intents (system.repeat, system.undo,
 * system.cancel, system.select, system.unsupported) MUST be filtered out by the
 * caller — recording them here would create loops.
 *
 * @param {object} entry
 * @param {string} entry.intent
 * @param {object} entry.params
 * @param {object} [entry.result]   — abbreviated tool result for context
 * @param {string} [entry.transcript]
 * @param {boolean}[entry.needsConfirm]
 */
function setLastAction(entry) {
  if (!entry || !entry.intent) return;
  _lastAction = {
    intent:       entry.intent,
    params:       entry.params ? { ...entry.params } : {},
    result:       entry.result ? {
      ok:     !!entry.result.ok,
      action: entry.result.action || '',
      error:  entry.result.error  || null,
    } : null,
    transcript:   entry.transcript || '',
    needsConfirm: !!entry.needsConfirm,
    setAt:        Date.now(),
  };
}

// ─── Getters ──────────────────────────────────────────────────────────────────

/**
 * @returns {{ processName: string, hwnd: number|null, kind: string } | null}
 */
function getWindowTarget() {
  if (!_fresh(_window)) return null;
  const { processName, hwnd, kind } = _window;
  return { processName, hwnd, kind };
}

/**
 * @returns {{ name: string, path: string } | null}
 */
function getFileTarget() {
  if (!_fresh(_file)) return null;
  const { name, path } = _file;
  return { name, path };
}

/**
 * @returns {{ candidates: Array, classifiedResult: object } | null}
 */
function getCandidates() {
  if (!_fresh(_candidates)) return null;
  const { candidates, classifiedResult } = _candidates;
  return { candidates, classifiedResult };
}

/**
 * M4.8 — Return the most recent recorded action, or null if expired.
 * @returns {{ intent, params, result, transcript, needsConfirm } | null}
 */
function getLastAction() {
  if (!_fresh(_lastAction)) return null;
  const { intent, params, result, transcript, needsConfirm } = _lastAction;
  return { intent, params: { ...params }, result, transcript, needsConfirm };
}

// ─── M5.4 — Active result set ─────────────────────────────────────────────────

/**
 * Store the most recent voice-pickable result list (search results, files,
 * tabs) so a follow-up "open the second one" can target it without a fresh
 * disambiguation. Only one active set is held at a time.
 *
 * @param {object} entry
 * @param {'web'|'tabs'|'files'} entry.kind
 * @param {string} entry.source
 * @param {Array<{index, title, url?, path?, tabId?}>} entry.cards
 */
function setActiveResultSet(entry) {
  if (!entry || !Array.isArray(entry.cards) || entry.cards.length === 0) {
    _activeResultSet = null;
    return;
  }
  _activeResultSet = {
    kind:   entry.kind || 'web',
    source: entry.source || '',
    cards:  entry.cards.slice(0, 8),
    setAt:  Date.now(),
  };
}

/**
 * @returns {{ kind, source, cards } | null}
 */
function getActiveResultSet() {
  if (!_activeResultSet) return null;
  // Result panels expire on jarvisResultPanelTimeoutMs, defaulting to 30s — we
  // reuse the standard TTL helper since the value is bounded and reasonable.
  const settings = require('../settings');
  const panelTtl = Number(settings.getSetting('jarvisResultPanelTimeoutMs', 30000)) || 30000;
  if (panelTtl > 0 && (Date.now() - _activeResultSet.setAt) >= panelTtl) {
    _activeResultSet = null;
    return null;
  }
  const { kind, source, cards } = _activeResultSet;
  return { kind, source, cards: cards.map((c) => ({ ...c })) };
}

function clearActiveResultSet() {
  _activeResultSet = null;
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

/** Remove only the disambiguation candidates (after resolution or cancel). */
function clearCandidates() {
  _candidates = null;
}

/** Full reset — clears all context entries immediately. */
function clear() {
  _window     = null;
  _file       = null;
  _candidates = null;
  _lastAction = null;
  _activeResultSet = null;
}

// ─── Diagnostics ─────────────────────────────────────────────────────────────

/**
 * Returns a snapshot of the raw internal state (including setAt timestamps).
 * Used by trace.js and tests.
 */
function snapshot() {
  const now = Date.now();
  return {
    window:       _window     ? { ..._window,     ttlRemaining: Math.max(0, _ttlMs() - (now - _window.setAt))     } : null,
    file:         _file       ? { ..._file,        ttlRemaining: Math.max(0, _ttlMs() - (now - _file.setAt))       } : null,
    candidates:   _candidates ? { ..._candidates,  ttlRemaining: Math.max(0, _ttlMs() - (now - _candidates.setAt)) } : null,
    lastAction:   _lastAction ? { ..._lastAction,  ttlRemaining: Math.max(0, _ttlMs() - (now - _lastAction.setAt)) } : null,
    activeResults: _activeResultSet ? { ..._activeResultSet, count: _activeResultSet.cards.length } : null,
    ttlMs:        _ttlMs(),
  };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  setWindowTarget,
  setFileTarget,
  setCandidates,
  setLastAction,
  setActiveResultSet,
  getWindowTarget,
  getFileTarget,
  getCandidates,
  getLastAction,
  getActiveResultSet,
  clearCandidates,
  clearActiveResultSet,
  clear,
  snapshot,
};
