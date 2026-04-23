'use strict';

/**
 * trace.js — Structured trace accumulator and writer for the Jarvis pipeline.
 *
 * Disabled by default (jarvisTraceEnabled: false). When enabled, writes JSON
 * trace files to jarvisTraceDir and emits jarvis:trace HUD events.
 *
 * Pure Node.js — no Electron imports.
 */

const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const settings = require('../settings');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateId() {
  const ts   = Date.now();
  const rand = Math.random().toString(36).slice(2, 6);
  return `${ts}-${rand}`;
}

function getTraceDir() {
  const configured = settings.getSetting('jarvisTraceDir', '');
  if (configured) return configured;
  return path.join(os.homedir(), 'Documents', 'Jarvis', 'traces');
}

// ─── TraceAccumulator ─────────────────────────────────────────────────────────

class TraceAccumulator {
  constructor(rawInput) {
    this._r = {
      id:               generateId(),
      timestamp:        new Date().toISOString(),
      rawInput:         rawInput || '',
      normalized:       rawInput || '',
      tier:             'unsupported',
      patternIndex:     null,
      intent:           'system.unsupported',
      confidence:       'pattern',
      params:           {},
      needsConfirm:     false,
      contextUsed: {
        windowTarget:  null,
        fileTarget:    null,
        hadCandidates: false,
      },
      ambiguousCount:    null,
      selectedCandidate: null,
      dispatchOk:        false,
      verifyOk:          null,
      timings: {
        classify: 0,
        dispatch: 0,
        verify:   0,
        tts:      0,
        total:    0,
      },
      error:     null,
      chainStep: null,
    };
  }

  setNormalized(t) {
    this._r.normalized = t;
    return this;
  }

  /**
   * @param {object} result       — ClassifierResult
   * @param {number} [patternIndex] — index in COMPILED; overrides result._patternIndex
   */
  setClassification(result, patternIndex) {
    const r = this._r;
    r.intent       = result.intent       || 'system.unsupported';
    r.confidence   = result.confidence   || 'pattern';
    r.params       = result.params       || {};
    r.needsConfirm = result.needsConfirm || false;

    const idx = (patternIndex != null) ? patternIndex
              : (result._patternIndex  != null ? result._patternIndex : null);
    r.patternIndex = idx;

    if (result.confidence === 'llm') {
      r.tier = 'llm';
    } else if (result.intent === 'system.unsupported') {
      r.tier = 'unsupported';
    } else {
      r.tier = 'pattern';
    }
    return this;
  }

  /**
   * @param {object|null} contextSnapshot — from context.snapshot()
   */
  setContextUsed(contextSnapshot) {
    if (!contextSnapshot) {
      this._r.contextUsed = { windowTarget: null, fileTarget: null, hadCandidates: false };
      return this;
    }
    this._r.contextUsed = {
      windowTarget:  contextSnapshot.window     ? { ...contextSnapshot.window }     : null,
      fileTarget:    contextSnapshot.file       ? { ...contextSnapshot.file }       : null,
      hadCandidates: !!(contextSnapshot.candidates),
    };
    return this;
  }

  /** @param {object} toolResult — ToolResult from dispatcher */
  setDispatch(toolResult) {
    if (!toolResult) return this;
    this._r.dispatchOk = !!toolResult.ok;
    if (toolResult.ambiguous && toolResult.candidates) {
      this._r.ambiguousCount = toolResult.candidates.length;
    }
    if (!toolResult.ok && toolResult.error) {
      this._r.error = toolResult.error;
    }
    return this;
  }

  /** @param {object} verifyResult — VerifierResult */
  setVerify(verifyResult) {
    if (!verifyResult) return this;
    this._r.verifyOk = verifyResult.verified !== false;
    return this;
  }

  /** @param {object} timings — { classify, dispatch, verify, tts, total } */
  setTimings(timings) {
    if (!timings) return this;
    this._r.timings = {
      classify: timings.classify || 0,
      dispatch: timings.dispatch || 0,
      verify:   timings.verify   || 0,
      tts:      timings.tts      || 0,
      total:    timings.total    || 0,
    };
    return this;
  }

  /** @param {string|null} label — e.g. '1 of 2' | '2 of 2' */
  setChainStep(label) {
    this._r.chainStep = label || null;
    return this;
  }

  /** @param {string|null} msg */
  setError(msg) {
    this._r.error = msg || null;
    return this;
  }

  /** Freeze and return the completed TraceRecord. */
  build() {
    return Object.freeze({ ...this._r, contextUsed: { ...this._r.contextUsed } });
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Create a new TraceAccumulator for a single pipeline run.
 * @param {string} rawInput — the original transcript
 * @returns {TraceAccumulator}
 */
function createTrace(rawInput) {
  return new TraceAccumulator(rawInput);
}

/**
 * Write a completed TraceRecord to disk. No-op when jarvisTraceEnabled is false.
 * Auto-prunes oldest files when count exceeds jarvisTraceMaxFiles.
 * @param {object} record — a frozen TraceRecord from accumulator.build()
 * @returns {Promise<void>}
 */
async function writeTrace(record) {
  if (!settings.getSetting('jarvisTraceEnabled', false)) return;

  const dir = getTraceDir();
  try {
    fs.mkdirSync(dir, { recursive: true });

    const maxFiles = settings.getSetting('jarvisTraceMaxFiles', 200);
    const existing = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => a.mtime - b.mtime);

    if (existing.length >= maxFiles) {
      for (const f of existing.slice(0, 50)) {
        try { fs.unlinkSync(path.join(dir, f.name)); } catch { /* ignore */ }
      }
    }

    const filePath = path.join(dir, `${record.id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf8');
  } catch (err) {
    console.warn('[trace] Failed to write trace file:', err.message);
  }
}

/**
 * Emit a jarvis:trace HUD event. No-op when jarvisTraceEnabled is false.
 * @param {Function} hudSend — (channel, payload) => void
 * @param {object}   record  — a frozen TraceRecord
 */
function emitTrace(hudSend, record) {
  if (!settings.getSetting('jarvisTraceEnabled', false)) return;
  if (typeof hudSend !== 'function') return;
  try {
    hudSend('jarvis:trace', record);
  } catch { /* non-fatal */ }
}

module.exports = { createTrace, writeTrace, emitTrace };
