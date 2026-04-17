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
    ttlMs:        _ttlMs(),
  };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  setWindowTarget,
  setFileTarget,
  setCandidates,
  getWindowTarget,
  getFileTarget,
  getCandidates,
  clearCandidates,
  clear,
  snapshot,
};
