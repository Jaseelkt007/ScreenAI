'use strict';

/**
 * executor.js — M5.0 + M5.3 sequential plan runner.
 *
 * Consumes the structured plan emitted by planner.js and runs each step
 * through the existing dispatcher, so:
 *   - destructive intents still pass through the confirmation gate
 *   - the verifier still runs on every step
 *   - patterns / agent-fallback machinery is unchanged at the dispatcher level
 *
 * Per-step behaviour:
 *   1. Fire short narration TTS (M5.3)         — non-blocking
 *   2. If destructive: open the confirmation gate
 *   3. Dispatch the tool
 *   4. Verify
 *   5. Push the step into trace + emit `jarvis:plan` event for HUD
 *   6. On step failure: ask planner to re-plan ONCE, then continue with the
 *      new step list. Cap is `jarvisPlanReplanMax`.
 *
 * Cancellation:
 *   - AbortSignal threads through dispatcher → tools (Phase 4 wiring)
 *   - On abort, the executor stops scheduling new steps and returns
 *     { ok:false, stopped:'cancelled' }.
 *
 * Returns:
 *   {
 *     ok, stopped, finalSpeak, finalDisplay,
 *     planSteps:        Array<{tool,params,result,latencyMs,replan,narration,ok}>,
 *     plan:             { goal, steps, expectedFinalSpeak } | null,
 *     replans:          number,
 *     lastDispatch:     ToolResult | null,
 *     lastClassifier:   ClassifierResult | null,
 *   }
 */

const settings        = require('../settings');
const dispatcherMod   = require('./dispatcher');
const verifierMod     = require('./verifier');
const plannerMod      = require('./planner');

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {string}      opts.transcript
 * @param {Function}    opts.hudSend
 * @param {Function}    opts.waitForConfirm
 * @param {AbortSignal} [opts.signal]
 * @param {Function}    [opts.onPlanEvent]    — receives { type, ... } per executor event (tests)
 * @param {Function}    [opts.makePlan]       — DI for tests
 * @param {Function}    [opts.dispatch]       — DI for tests
 * @param {Function}    [opts.verify]         — DI for tests
 * @param {Function}    [opts.fireNarration]  — DI for tests; defaults to narrator-tier TTS
 */
async function runPlan(opts = {}) {
  const {
    transcript,
    hudSend         = () => {},
    waitForConfirm  = async () => true,
    signal,
    onPlanEvent     = () => {},
  } = opts;

  const makePlan      = opts.makePlan      || plannerMod.makePlan;
  const dispatch      = opts.dispatch      || ((cr) => dispatcherMod.dispatch(cr, { signal }));
  const verify        = opts.verify        || verifierMod.verify;
  const fireNarration = opts.fireNarration || _defaultFireNarration;

  const replanMax = Number(settings.getSetting('jarvisPlanReplanMax', 1)) || 1;
  const maxSteps  = Number(settings.getSetting('jarvisPlanMaxSteps',  15)) || 15;

  const planSteps   = [];
  let   replansDone = 0;
  let   lastDispatch    = null;
  let   lastClassifier  = null;

  const emit = (ev) => {
    try { onPlanEvent(ev); } catch { /* tests only */ }
    try { hudSend('jarvis:plan', ev); } catch { /* HUD optional */ }
  };

  const t0 = Date.now();

  // ── 1. Initial plan ────────────────────────────────────────────────────────
  let plan;
  try {
    plan = await makePlan({ transcript, signal });
  } catch (err) {
    return _result({
      ok: false, stopped: 'planner_error',
      finalSpeak:   `Sorry, I couldn't plan that. ${err.message}`,
      finalDisplay: `Planner failed: ${err.message}`,
      planSteps, plan: null, replans: 0,
      lastDispatch, lastClassifier,
    });
  }
  if (!plan || !plan.ok) {
    const reason = plan && plan.error ? plan.error : 'planner failed';
    return _result({
      ok: false, stopped: 'planner_error',
      finalSpeak:   `Sorry, I couldn't plan that.`,
      finalDisplay: reason,
      planSteps, plan: null, replans: 0,
      lastDispatch, lastClassifier,
    });
  }

  emit({
    type:               'plan',
    goal:               plan.goal,
    steps:              plan.steps.map((s) => ({ tool: s.tool, params: s.params, why: s.why })),
    expectedFinalSpeak: plan.expectedFinalSpeak,
  });

  // Empty plan = the planner believes nothing needs to happen; just speak.
  if (plan.steps.length === 0) {
    return _result({
      ok: true, stopped: 'final',
      finalSpeak:   plan.expectedFinalSpeak,
      finalDisplay: plan.expectedFinalSpeak,
      planSteps, plan, replans: 0,
      lastDispatch, lastClassifier,
    });
  }

  // ── 2. Step loop ───────────────────────────────────────────────────────────
  let cursor = 0;
  let liveSteps = plan.steps.slice(0); // mutable; replan replaces the tail
  let _abortedReason = null;

  while (cursor < liveSteps.length && cursor < maxSteps) {
    if (signal && signal.aborted) { _abortedReason = 'cancelled'; break; }

    const step  = liveSteps[cursor];
    const stepT0 = Date.now();

    // Narration before dispatch — non-blocking.
    const narration = _narrationFor(step);
    if (narration) {
      try { fireNarration(narration, hudSend); } catch { /* non-fatal */ }
    }

    emit({
      type:     'step.start',
      index:    cursor,
      total:    liveSteps.length,
      tool:     step.tool,
      params:   step.params,
      why:      step.why,
      narration,
    });

    // Synthesize a ClassifierResult for the dispatcher.
    const classifierResult = {
      intent:        step.tool,
      params:        step.params || {},
      raw:           transcript,
      confidence:    'plan',
      needsConfirm:  _planStepNeedsConfirm(step),
      _planStep:     true,
    };
    lastClassifier = classifierResult;

    // Confirmation gate (uses the same machinery as the pattern path).
    if (classifierResult.needsConfirm) {
      try {
        hudSend('jarvis:confirm', {
          message:     _buildConfirmMessage(classifierResult),
          actionLabel: _buildActionLabel(classifierResult),
        });
      } catch { /* */ }
      let confirmed = false;
      try { confirmed = await waitForConfirm(); } catch { confirmed = false; }
      if (!confirmed) {
        const result = { ok: false, error: 'cancelled by user', action: '' };
        planSteps.push({
          tool:   step.tool, params: step.params, result,
          latencyMs: Date.now() - stepT0,
          replan: false, narration, ok: false,
        });
        emit({ type: 'step.fail', index: cursor, tool: step.tool, error: 'cancelled by user' });
        return _result({
          ok: false, stopped: 'cancelled',
          finalSpeak:   'Cancelled.',
          finalDisplay: 'Cancelled.',
          planSteps, plan, replans: replansDone,
          lastDispatch: result, lastClassifier,
        });
      }
    }

    // Dispatch.
    let toolResult;
    try {
      toolResult = await dispatch(classifierResult);
    } catch (err) {
      toolResult = { ok: false, error: err.message || 'dispatch threw', action: '' };
    }
    if (signal && signal.aborted) { _abortedReason = 'cancelled'; break; }
    if (toolResult && toolResult.cancelled) { _abortedReason = 'cancelled'; break; }
    lastDispatch = toolResult;

    // Verify (non-fatal — failure feeds replan but doesn't break the loop).
    let verifierResult = null;
    try { verifierResult = await verify(classifierResult, toolResult); } catch { /* */ }

    const latencyMs = Date.now() - stepT0;
    const stepRecord = {
      tool:      step.tool,
      params:    step.params,
      result:    _summarizeResult(toolResult),
      latencyMs,
      replan:    false,
      narration,
      ok:        !!(toolResult && toolResult.ok),
    };
    planSteps.push(stepRecord);

    emit({
      type:     toolResult && toolResult.ok ? 'step.done' : 'step.fail',
      index:    cursor,
      tool:     step.tool,
      ok:       !!(toolResult && toolResult.ok),
      result:   stepRecord.result,
      verified: verifierResult ? verifierResult.verified !== false : null,
      latencyMs,
    });

    // ── On step failure: try to re-plan once.
    const stepFailed   = !toolResult || !toolResult.ok;
    const stepUnverified = toolResult && toolResult.ok && verifierResult && verifierResult.verified === false;

    if ((stepFailed || stepUnverified) && replansDone < replanMax) {
      replansDone += 1;
      emit({
        type:         'replan',
        index:        cursor,
        reason:       stepFailed ? 'step_failed' : 'verify_failed',
        error:        toolResult && toolResult.error || (verifierResult && verifierResult.detail) || null,
      });
      let newPlan;
      try {
        newPlan = await makePlan({
          transcript,
          signal,
          failure: {
            lastStep: { tool: step.tool, params: step.params },
            error:    toolResult && toolResult.error || null,
            observed: verifierResult && verifierResult.detail || null,
          },
        });
      } catch (err) {
        newPlan = { ok: false, error: err.message };
      }

      if (newPlan && newPlan.ok && Array.isArray(newPlan.steps) && newPlan.steps.length > 0) {
        // Replace the remainder of the plan with the replanned steps.
        liveSteps = liveSteps.slice(0, cursor + 1).concat(newPlan.steps);
        // Mark the *next* batch as replan steps for trace.
        const replanStartIdx = cursor + 1;
        for (let k = replanStartIdx; k < liveSteps.length; k++) liveSteps[k]._isReplan = true;
        emit({
          type:               'plan',
          goal:               newPlan.goal,
          steps:              newPlan.steps.map((s) => ({ tool: s.tool, params: s.params, why: s.why })),
          expectedFinalSpeak: newPlan.expectedFinalSpeak,
          replan:             true,
        });
        // expectedFinalSpeak from the replanned plan supersedes the original.
        plan = {
          goal:               newPlan.goal || plan.goal,
          steps:              liveSteps,
          expectedFinalSpeak: newPlan.expectedFinalSpeak || plan.expectedFinalSpeak,
        };
      } else if (stepFailed) {
        // Replan failed and the original step also failed — give up.
        return _result({
          ok: false, stopped: 'step_failed',
          finalSpeak:   _shortError(toolResult),
          finalDisplay: _shortError(toolResult),
          planSteps, plan, replans: replansDone,
          lastDispatch, lastClassifier,
        });
      }
      // If verify failed but step itself was ok, we proceed even if replan came back empty.
    } else if (stepFailed) {
      return _result({
        ok: false, stopped: 'step_failed',
        finalSpeak:   _shortError(toolResult),
        finalDisplay: _shortError(toolResult),
        planSteps, plan, replans: replansDone,
        lastDispatch, lastClassifier,
      });
    }

    cursor += 1;
  }

  if (_abortedReason === 'cancelled') {
    return _result({
      ok: false, stopped: 'cancelled',
      finalSpeak:   'Cancelled.',
      finalDisplay: 'Cancelled.',
      planSteps, plan, replans: replansDone,
      lastDispatch, lastClassifier,
    });
  }

  if (cursor >= maxSteps && cursor < liveSteps.length) {
    return _result({
      ok: false, stopped: 'maxSteps',
      finalSpeak:   'I hit the step limit before finishing.',
      finalDisplay: `Stopped after ${cursor} steps (cap=${maxSteps}).`,
      planSteps, plan, replans: replansDone,
      lastDispatch, lastClassifier,
    });
  }

  // ── 3. Done — speak the planner's expectedFinalSpeak ────────────────────────
  const finalSpeak = (plan.expectedFinalSpeak || 'Done.').slice(0, 280);
  void t0; // satisfy linter; latency captured per step
  return _result({
    ok: true, stopped: 'final',
    finalSpeak,
    finalDisplay: finalSpeak,
    planSteps, plan, replans: replansDone,
    lastDispatch, lastClassifier,
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const _NARRATION_TEMPLATES = {
  'browser.search':     (p) => `Searching for ${(p && p.query) || 'that'}…`,
  'browser.tabs.open':  (p) => `Opening ${(p && p.url) || 'a tab'}…`,
  'browser.tabs.close': () => 'Closing the tab…',
  'browser.tabs.focus': () => 'Switching tabs…',
  'browser.tabs.list':  () => 'Checking tabs…',
  'browser.read':       () => 'Reading the page…',
  'browser.click':      (p) => `Clicking ${(p && (p.text || p.selector)) || 'it'}…`,
  'browser.fill':       () => 'Filling that in…',
  'browser.scroll':     () => 'Scrolling…',
  'web.search':         () => 'Searching the web…',
  'web.scrape':         () => 'Pulling that page…',
  'vision.read':        () => 'Looking at the screen…',
  'ui.click':           (p) => `Clicking ${(p && p.name) || 'it'}…`,
  'ui.fill':            (p) => `Filling ${(p && p.name) || 'that'}…`,
  'ui.read':            () => 'Reading…',
  'ui.list':            () => 'Looking around…',
  'app.open':           (p) => `Opening ${(p && p.appName) || 'it'}…`,
  'app.close':          (p) => `Closing ${(p && p.appName) || 'it'}…`,
  'app.focus':          (p) => `Switching to ${(p && p.appName) || 'it'}…`,
  'window.minimize':    () => 'Minimizing…',
  'window.maximize':    () => 'Maximizing…',
  'window.switch':      () => 'Switching windows…',
  'file.find':          () => 'Searching files…',
  'file.open':          () => 'Opening that file…',
  'input.type':         () => 'Typing…',
  'input.key':          () => null,
  'input.shortcut':     () => null,
  'system.volume':      () => null,
  'system.brightness':  () => null,
  'clipboard.write':    () => null,
};

function _narrationFor(step) {
  if (!step || !step.tool) return null;
  const fn = _NARRATION_TEMPLATES[step.tool];
  if (!fn) return `Running ${step.tool}…`;
  try { return fn(step.params); } catch { return null; }
}

async function _defaultFireNarration(phrase, hudSend) {
  // Lazy require — narrator.js imports tts.js which needs Electron settings.
  try {
    const narrator = require('./narrate');
    return narrator.fireNarration(phrase, hudSend);
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function _planStepNeedsConfirm(step) {
  if (!step || !step.tool) return false;
  const toolSchemas = require('./tool-schemas');
  return toolSchemas.needsConfirmFor(step.tool, step.params || {});
}

function _summarizeResult(toolResult) {
  if (!toolResult || typeof toolResult !== 'object') return { ok: false, error: 'no result' };
  const out = { ok: !!toolResult.ok };
  if (toolResult.error)  out.error  = String(toolResult.error).slice(0, 300);
  if (toolResult.action) out.action = String(toolResult.action).slice(0, 300);
  if (toolResult.ambiguous) out.ambiguous = true;
  return out;
}

function _shortError(toolResult) {
  if (!toolResult) return 'Something went wrong.';
  if (toolResult.error) return String(toolResult.error).slice(0, 240);
  return 'Something went wrong.';
}

function _buildConfirmMessage(cr) {
  const { intent, params } = cr;
  if (intent === 'file.write')  return `This will overwrite existing content in "${params.name}". Continue?`;
  if (intent === 'file.append') return `Append ${(params.content && params.content.length) || 0} characters to "${params.name}"?`;
  if (intent === 'file.delete') return `Permanently delete "${params.name || params.path}"? This cannot be undone.`;
  if (intent === 'file.rename') return `Rename "${params.name || params.path}" to "${params.newName}"?`;
  if (intent === 'file.move')   return `Move "${params.name || params.path}" to ${params.targetLocationHint}?`;
  if (intent === 'system.lock') return 'Lock the screen?';
  return 'Confirm this action?';
}

function _buildActionLabel(cr) {
  const { intent } = cr;
  if (intent === 'file.write')  return 'Overwrite';
  if (intent === 'file.append') return 'Append';
  if (intent === 'file.delete') return 'Delete';
  if (intent === 'file.rename') return 'Rename';
  if (intent === 'file.move')   return 'Move';
  if (intent === 'system.lock') return 'Lock';
  return 'Confirm';
}

function _result(payload) { return payload; }

module.exports = { runPlan };
