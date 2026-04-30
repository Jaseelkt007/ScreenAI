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
      // M4.4.1 — routing path: 'pattern' (default), 'agent' (M4.5), or 'plan' (M5.0).
      path:             'pattern',
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
      // M4.4.1 — agent tool calls in order; empty for pattern-routed runs
      agentSteps: [],
      // M5.0 — planner-routed runs record the full plan + per-step results.
      plan:       null,        // { goal, steps: [{tool, params, why}], expectedFinalSpeak }
      planSteps:  [],          // [{ tool, params, result, latencyMs, replan, narration }]
      replans:    0,           // number of times the plan was re-issued after a step failure
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

  /**
   * M4.4.1 / M5.0 — set the routing path:
   *   'pattern' — classifier match (Phase 1–4)
   *   'agent'   — bounded 3-call LLM tool-calling fallback (M4.5)
   *   'plan'    — multi-step planner/executor (M5.0)
   * @param {'pattern'|'agent'|'plan'} p
   */
  setPath(p) {
    if (p === 'pattern' || p === 'agent' || p === 'plan') this._r.path = p;
    return this;
  }

  /**
   * M5.0 — record the planner's emitted plan.
   * @param {object} plan — { goal, steps:[{tool,params,why}], expectedFinalSpeak }
   */
  setPlan(plan) {
    if (!plan || typeof plan !== 'object') return this;
    this._r.plan = {
      goal:               plan.goal || '',
      steps:              Array.isArray(plan.steps)
        ? plan.steps.map((s) => ({ tool: s.tool || '', params: { ...(s.params || {}) }, why: s.why || '' }))
        : [],
      expectedFinalSpeak: plan.expectedFinalSpeak || '',
    };
    return this;
  }

  /**
   * M5.0 — record one executed plan step. Append in execution order.
   * @param {object} step
   */
  addPlanStep(step) {
    if (!step || typeof step !== 'object') return this;
    this._r.planSteps.push({
      tool:      step.tool      || '',
      params:    step.params    ? { ...step.params } : {},
      result:    step.result    ? { ...step.result } : null,
      latencyMs: step.latencyMs != null ? step.latencyMs : 0,
      replan:    !!step.replan,
      narration: step.narration || null,
      ok:        step.result ? !!step.result.ok : false,
    });
    return this;
  }

  /** M5.0 — increment the replan counter when the planner re-issues a plan. */
  incReplans() {
    this._r.replans += 1;
    return this;
  }

  /**
   * M4.4.1 — record one agent tool call. Called by M4.5 agent loop per step.
   * Steps are stored in invocation order.
   * @param {object} step
   * @param {string} step.tool       — tool/intent name dispatched
   * @param {object} [step.params]   — params passed to the dispatcher
   * @param {object} [step.result]   — tool result summary { ok, error?, ambiguous? }
   * @param {number} [step.latencyMs] — wall-clock ms for this step
   * @param {boolean} [step.retry]   — true if this was a verify-fail retry (M4.8)
   */
  addAgentStep(step) {
    if (!step || typeof step !== 'object') return this;
    this._r.agentSteps.push({
      tool:      step.tool      || '',
      params:    step.params    ? { ...step.params } : {},
      result:    step.result    ? { ...step.result } : null,
      latencyMs: step.latencyMs != null ? step.latencyMs : 0,
      retry:     !!step.retry,
    });
    return this;
  }

  /** Freeze and return the completed TraceRecord. */
  build() {
    return Object.freeze({
      ...this._r,
      contextUsed: { ...this._r.contextUsed },
      agentSteps:  this._r.agentSteps.map((s) => ({ ...s, params: { ...s.params }, result: s.result ? { ...s.result } : null })),
      plan:        this._r.plan ? {
        ...this._r.plan,
        steps: this._r.plan.steps.map((s) => ({ ...s, params: { ...s.params } })),
      } : null,
      planSteps:   this._r.planSteps.map((s) => ({ ...s, params: { ...s.params }, result: s.result ? { ...s.result } : null })),
    });
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
 * Project a full TraceRecord down to a 1-line summary object.
 * Used when jarvisTraceLevel === 'summary'.
 */
function summarizeRecord(record) {
  return {
    id:         record.id,
    timestamp:  record.timestamp,
    intent:     record.intent,
    confidence: record.confidence,
    path:       record.path,
    dispatchOk: record.dispatchOk,
    verifyOk:   record.verifyOk,
    total:      record.timings && record.timings.total ? record.timings.total : 0,
    agentSteps: record.agentSteps ? record.agentSteps.length : 0,
    planSteps:  record.planSteps  ? record.planSteps.length  : 0,
    replans:    record.replans    || 0,
    chainStep:  record.chainStep,
    error:      record.error,
  };
}

/**
 * Write a completed TraceRecord to disk. No-op when jarvisTraceEnabled is false
 * or when jarvisTraceLevel is 'off'.
 *
 * jarvisTraceLevel governs format:
 *   'off'     — never write (overrides jarvisTraceEnabled)
 *   'summary' — write a single-line minimal JSON
 *   'full'    — write the full pretty-printed JSON record (default)
 *
 * Auto-prunes oldest files when count exceeds jarvisTraceMaxFiles.
 * @param {object} record — a frozen TraceRecord from accumulator.build()
 * @returns {Promise<void>}
 */
async function writeTrace(record) {
  if (!settings.getSetting('jarvisTraceEnabled', false)) return;

  const level = settings.getSetting('jarvisTraceLevel', 'full');
  if (level === 'off') return;

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
    const payload  = level === 'summary'
      ? JSON.stringify(summarizeRecord(record))           // single line
      : JSON.stringify(record, null, 2);                   // pretty-printed full record
    fs.writeFileSync(filePath, payload, 'utf8');
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

module.exports = { createTrace, writeTrace, emitTrace, summarizeRecord };
