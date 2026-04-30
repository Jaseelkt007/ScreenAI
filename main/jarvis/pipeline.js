'use strict';

/**
 * pipeline.js — Jarvis pipeline orchestrator.
 *
 * M2 entry point: runPipelineFromText(transcript, hudSend, waitForConfirm)
 * M3 adds: runPipelineFromAudio(audioBuffer, mimeType, hudSend, waitForConfirm)
 *          which calls STT then delegates to runPipelineFromText.
 * M3.5 adds: chain detection — "open Chrome and then go to YouTube" executes
 *            both steps sequentially. Capped at 2 steps per utterance.
 *
 * All steps are sequential async/await. No shared mutable state.
 * hudSend(channel, payload) — bridge to HUD renderer (injected by index.js)
 * waitForConfirm()          — one-shot Promise<boolean> (injected by index.js)
 *
 * Imports use module-object form (not destructuring) so withPatchedExports()
 * works correctly in Tier A tests.
 */

// Module-level references (not destructured) so test patches propagate at call-time.
const classifierMod = require('./classifier');
const dispatcherMod = require('./dispatcher');
const verifierMod   = require('./verifier');
const context       = require('./context');
const agentMod      = require('./agent');
const ackMod        = require('./ack');
// M5.0 — multi-step planner/executor for classifier-misses
const executorMod   = require('./executor');

// stt/tts are required lazily so pipeline.js stays importable in Tier A tests
// without Electron. In M3, stt will be called from runPipelineFromAudio.

// ─── M4.7: Streaming pipeline state ──────────────────────────────────────────

// Cache of pre-classified partials. STT does not yet stream natively, but the
// HUD can call prewarmClassify() with an in-progress transcript to get a head
// start. Cleared on every successful run consumption or after 5s.
let _prewarm = null;   // { transcript, result, at } | null

// Current run controller, so the hotkey/HUD can fire cancelCurrent().
let _currentController = null;

function _consumePrewarm(transcript) {
  if (!_prewarm) return null;
  const stale = Date.now() - _prewarm.at > 5000;
  const sameInput = _prewarm.transcript === transcript;
  if (stale || !sameInput) { _prewarm = null; return null; }
  const out = _prewarm.result;
  _prewarm = null;
  return out;
}

/**
 * M4.7 — Pre-classify a partial transcript so the next runPipelineFromText with
 * the same transcript can skip the classifier call. Safe to call repeatedly;
 * destructive intents are NEVER cached (we can't speculate on them safely).
 *
 * @param {string} partialTranscript
 * @returns {Promise<{ cached: boolean, intent?: string, reason?: string }>}
 */
async function prewarmClassify(partialTranscript) {
  if (!partialTranscript || typeof partialTranscript !== 'string') {
    return { cached: false, reason: 'empty' };
  }
  const settings = require('../settings');
  if (!settings.getSetting('jarvisStreamingEnabled', true)) {
    return { cached: false, reason: 'streaming disabled' };
  }
  try {
    const result = await classifierMod.classify(partialTranscript);
    // Only cache solid pattern matches that are non-destructive.
    if (result.confidence !== 'pattern') {
      return { cached: false, reason: `confidence ${result.confidence}` };
    }
    if (result.needsConfirm) {
      return { cached: false, intent: result.intent, reason: 'destructive' };
    }
    _prewarm = { transcript: partialTranscript, result, at: Date.now() };
    return { cached: true, intent: result.intent };
  } catch (err) {
    return { cached: false, reason: err.message };
  }
}

/**
 * M4.7 — Abort the currently-running pipeline (if any). The in-flight tool
 * will complete, but the pipeline will skip TTS/verify and emit a cancelled
 * jarvis:done. Safe to call when no pipeline is running.
 *
 * M5.3 extends this to handle plan-level cancellation: when a multi-step plan
 * is in flight, abort() stops the executor between steps.
 */
function cancelCurrent() {
  if (_currentController && !_currentController.signal.aborted) {
    try { _currentController.abort(); } catch { /* ignore */ }
    return true;
  }
  return false;
}

// ─── M5.3: Voice-cancel keyword scanner ──────────────────────────────────────

const _CANCEL_KEYWORDS = /\b(stop|cancel|wait|never\s*mind|nevermind|abort)\b/i;

/**
 * Called by the HUD with a partial-STT transcript while a plan is running.
 * If the transcript matches a cancel keyword and voice-cancel is enabled, the
 * current pipeline is aborted (same effect as F9). Returns true on cancel.
 *
 * @param {string} partialTranscript
 * @returns {boolean}
 */
function maybeVoiceCancel(partialTranscript) {
  if (!partialTranscript || typeof partialTranscript !== 'string') return false;
  const settings = require('../settings');
  if (!settings.getSetting('jarvisVoiceCancelEnabled', true)) return false;
  if (!_currentController || _currentController.signal.aborted) return false;
  if (!_CANCEL_KEYWORDS.test(partialTranscript)) return false;
  console.log(`[JARVIS] Voice cancel triggered by partial: "${partialTranscript.slice(0, 60)}"`);
  return cancelCurrent();
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Run the full pipeline from a pre-transcribed string.
 * Detects 2-step command chains and executes them sequentially.
 *
 * @param {string}   transcript      — the command text
 * @param {Function} hudSend         — (channel, payload) => void
 * @param {Function} waitForConfirm  — () => Promise<boolean>
 */
async function runPipelineFromText(transcript, hudSend, waitForConfirm) {
  const t0 = Date.now();

  try {
    // ── M4.3: detect chain — bare "and" supported, capped at jarvisChainMaxSteps ─
    const maxSteps = require('../settings').getSetting('jarvisChainMaxSteps', 2);
    const { parts, wasCapped } = classifierMod.splitChainWithBareAnd(transcript, maxSteps);

    if (parts.length === 2) {
      return await _runChained(parts, wasCapped, hudSend, waitForConfirm, t0);
    }

    // ── Single-intent flow (unchanged) ─────────────────────────────────────────
    return await _runSingle(parts[0], hudSend, waitForConfirm, t0);

  } catch (err) {
    console.error('[Jarvis] Pipeline error:', err);
    const msg = err.message || 'An unexpected error occurred.';
    hudSend('jarvis:done', { ok: false, display: msg, error: msg });
  }
}

/**
 * M3 entry point: run pipeline from raw audio bytes.
 * Calls STT → then delegates to runPipelineFromText.
 *
 * @param {Buffer}   audioBuffer
 * @param {string}   mimeType
 * @param {Function} hudSend
 * @param {Function} waitForConfirm
 */
async function runPipelineFromAudio(audioBuffer, mimeType, hudSend, waitForConfirm) {
  const t0 = Date.now();

  try {
    hudSend('jarvis:status', { phase: 'transcribing' });
    const { transcribeAudio } = require('../stt');
    const t1 = Date.now();
    const sttResult = await transcribeAudio(audioBuffer, mimeType);
    const sttMs = Date.now() - t1;
    logTiming('STT', sttMs);
    console.log(`[JARVIS] STT: ${sttMs}ms — "${sttResult.text.slice(0, 60)}"`);

    await runPipelineFromText(sttResult.text, hudSend, waitForConfirm);
  } catch (err) {
    console.error('[Jarvis] STT error:', err.message);
    const msg = err.message || 'Could not transcribe audio.';
    hudSend('jarvis:done', { ok: false, display: msg, error: msg });
  }
}

// ─── Single-intent flow ───────────────────────────────────────────────────────

async function _runSingle(transcript, hudSend, waitForConfirm, t0, chainStep) {
  const timings = {};

  // ── M4.4: per-run tracking ───────────────────────────────────────────────────
  const run = {
    id:       _generateRunId(),
    rawInput: transcript,
    intent:   'unknown',
    conf:     'pattern',
    p:        null,
    ctx:      'none',
    ttl:      0,
    ctxSnap:  null,
    dispatch: 'skipped',
    verify:   'skipped',
    chainStep: chainStep || null,
    // M4.4.1 — routing path. M4.5 will set 'agent' when the agent layer routes.
    path:     'pattern',
    error:    null,
  };
  let _classifierResult = null;
  let _toolResult       = null;
  let _verifierResult   = null;
  let _ackPromise       = null;   // M4.7 — non-blocking ack TTS

  // M4.7 — per-run AbortController. Stored module-level so cancelCurrent() can
  // fire it, and reset in the finally block.
  const controller = new AbortController();
  const _prevController = _currentController;
  _currentController = controller;

  try {

  // ── 1. Classify (or consume pre-warm) ──────────────────────────────────────
  hudSend('jarvis:status', { phase: 'classifying', transcript });
  const t1 = Date.now();
  let classifierResult = _consumePrewarm(transcript);
  if (classifierResult) {
    // Speculative cache hit — flag for trace.
    classifierResult._speculative = true;
    run.speculative = true;
    logTiming('Classify', 0, `pattern (pre-warm)`);
  } else {
    classifierResult = await classifierMod.classify(transcript);
    logTiming('Classify', Date.now() - t1, classifierResult.confidence);
  }
  timings.classify = Date.now() - t1;
  _classifierResult = classifierResult;

  // Capture context state immediately after classify (M4.4)
  run.intent  = classifierResult.intent;
  run.conf    = classifierResult.confidence;
  run.p       = classifierResult._patternIndex != null ? classifierResult._patternIndex : null;
  const _snap = context.snapshot();
  run.ctx     = _computeCtxString(_snap);
  run.ttl     = _computeTtlRemaining(_snap);
  run.ctxSnap = _snap;

  // ── 2. Unsupported → M5.0 planner (or M4.5 agent fallback / fast-exit) ─────
  if (classifierResult.intent === 'system.unsupported') {
    const settingsMod    = require('../settings');
    const plannerEnabled = settingsMod.getSetting('jarvisPlannerEnabled', true);
    const agentEnabled   = settingsMod.getSetting('jarvisAgentEnabled', true);
    const apiKey         = settingsMod.getApiKey();

    if ((!plannerEnabled && !agentEnabled) || !apiKey) {
      const msg = classifierResult.reason || "I don't know how to do that yet.";
      await speakAndDone(hudSend, false, msg, msg, timings, t0);
      return;
    }

    // ── 2a. Planner path (M5.0) ───────────────────────────────────────────
    if (plannerEnabled) {
      hudSend('jarvis:status', { phase: 'thinking', transcript });
      const tPlan = Date.now();
      const planResult = await executorMod.runPlan({
        transcript,
        hudSend,
        waitForConfirm,
        signal: controller.signal,
      });
      timings.dispatch = Date.now() - tPlan;
      run.path        = 'plan';
      run.plan        = planResult.plan || null;
      run.planSteps   = planResult.planSteps || [];
      run.replans     = planResult.replans || 0;
      run.intent      = (planResult.lastClassifier && planResult.lastClassifier.intent) || 'plan.fallback';
      run.conf        = 'plan';
      run.dispatch    = planResult.ok ? 'ok' : (planResult.stopped === 'cancelled' ? 'cancelled' : 'error');
      _classifierResult = planResult.lastClassifier || classifierResult;
      _toolResult       = planResult.lastDispatch;

      // Best-effort verify of the last step (covers trace + lastAction recording).
      if (planResult.lastDispatch && planResult.lastClassifier) {
        try {
          _verifierResult = await verifierMod.verify(planResult.lastClassifier, planResult.lastDispatch);
          run.verify = _verifierResult.verified ? 'ok' : 'unverified';
        } catch { /* non-fatal */ }
      }

      _maybeEmitContextEvent(hudSend);

      // Emit any final results into the result panel (M5.4) before TTS.
      _maybeEmitResultsFromPlan(hudSend, planResult);

      // Record the last action so "do that again" / "undo" still works through the plan path.
      if (_classifierResult && _toolResult && _toolResult.ok) {
        _recordLastAction(_classifierResult, _toolResult, transcript);
      }

      hudSend('jarvis:status', { phase: 'speaking', transcript });
      const tTtsPlan = Date.now();
      let audioPlan = null, mimePlan = null;
      try {
        const { synthesizeSpeech } = require('../tts');
        const ttsRes = await synthesizeSpeech(planResult.finalSpeak || (planResult.ok ? 'Done.' : 'Sorry.'));
        audioPlan = ttsRes.audioBuffer.toString('base64');
        mimePlan  = ttsRes.mimeType;
      } catch (err) {
        console.warn(`[Jarvis] Plan TTS failed (non-fatal): ${err.message}`);
      }
      timings.tts   = Date.now() - tTtsPlan;
      timings.total = Date.now() - t0;
      logTiming('Total', timings.total);

      hudSend('jarvis:done', {
        ok:          planResult.ok,
        display:     planResult.finalDisplay || planResult.finalSpeak,
        audioBase64: audioPlan,
        mimeType:    mimePlan,
        path:        'plan',
        stopped:     planResult.stopped,
      });
      return;
    }
    // ── 2b. Fall through to legacy M4.5 agent path ────────────────────────

    // Agent route. The agent dispatches via the existing dispatcher (so all
    // confirmation gates apply). It returns finalText + the captured steps.
    hudSend('jarvis:status', { phase: 'thinking', transcript });
    const tAgent = Date.now();
    const agentResult = await agentMod.runAgent({
      transcript,
      hudSend,
      waitForConfirm,
      signal: controller.signal,   // M4.8 audit fix — let cancelCurrent() abort the agent
    });
    timings.dispatch = Date.now() - tAgent;
    run.path        = 'agent';
    run.agentSteps  = agentResult.agentSteps || [];
    run.intent      = (agentResult.lastClassifierResult && agentResult.lastClassifierResult.intent) || 'agent.fallback';
    run.conf        = 'agent';
    run.dispatch    = agentResult.ok ? 'ok' : 'error';
    if (!agentResult.ok && agentResult.error) run.error = agentResult.error;
    _classifierResult = agentResult.lastClassifierResult || classifierResult;
    _toolResult       = agentResult.lastDispatchResult;

    // Verify the LAST dispatched tool result (when present) so the trace is
    // complete and the spoken text reflects verification status.
    if (agentResult.lastDispatchResult && agentResult.lastClassifierResult) {
      try {
        const tVerify = Date.now();
        _verifierResult = await verifierMod.verify(
          agentResult.lastClassifierResult, agentResult.lastDispatchResult,
        );
        timings.verify = Date.now() - tVerify;
        run.verify = _verifierResult.verified ? 'ok' : 'unverified';
      } catch { /* non-fatal */ }
    }

    // ── M4.8 — Verify-fail retry ──────────────────────────────────────────
    // If the agent dispatched OK but verifier explicitly says the action
    // didn't take effect, give the agent one more shot. Cap is 1 retry.
    if (
      agentResult.ok &&
      agentResult.lastDispatchResult && agentResult.lastDispatchResult.ok &&
      _verifierResult && _verifierResult.verified === false
    ) {
      hudSend('jarvis:status', { phase: 'thinking', transcript, retry: true });
      const retryResult = await agentMod.retryAgent({
        originalTranscript:    transcript,
        lastClassifierResult:  agentResult.lastClassifierResult,
        lastDispatchResult:    agentResult.lastDispatchResult,
        verifierResult:        _verifierResult,
        hudSend, waitForConfirm,
      });
      run.agentSteps = [...(run.agentSteps || []), ...(retryResult.agentSteps || [])];
      if (retryResult.lastDispatchResult && retryResult.lastClassifierResult) {
        _toolResult       = retryResult.lastDispatchResult;
        _classifierResult = retryResult.lastClassifierResult;
        try {
          _verifierResult = await verifierMod.verify(_classifierResult, _toolResult);
          run.verify = _verifierResult.verified ? 'ok' : 'unverified';
        } catch { /* non-fatal */ }
        run.intent   = retryResult.lastClassifierResult.intent || run.intent;
        run.dispatch = retryResult.ok ? 'ok' : 'error';
      }
      // The retry's spoken text supersedes the original failed-verify message.
      if (retryResult.finalText) agentResult.finalText = retryResult.finalText;
      agentResult.ok      = retryResult.ok || agentResult.ok;
      agentResult.stopped = `${agentResult.stopped}+retry-${retryResult.stopped}`;
    }

    _maybeEmitContextEvent(hudSend);

    // M4.8 — record the agent's final action so "do that again" works
    // through the agent path too.
    if (_classifierResult && _toolResult) {
      _recordLastAction(_classifierResult, _toolResult, transcript);
    }

    // Synthesize TTS for the agent's spoken finalText (works for ok and error).
    hudSend('jarvis:status', { phase: 'speaking', transcript });
    const tTtsAgent = Date.now();
    let audioB64Agent = null, mimeAgent = null;
    try {
      const { synthesizeSpeech } = require('../tts');
      const ttsRes = await synthesizeSpeech(agentResult.finalText || (agentResult.ok ? 'Done.' : 'Sorry.'));
      audioB64Agent = ttsRes.audioBuffer.toString('base64');
      mimeAgent     = ttsRes.mimeType;
    } catch (err) {
      console.warn(`[Jarvis] TTS failed (non-fatal): ${err.message}`);
    }
    timings.tts   = Date.now() - tTtsAgent;
    timings.total = Date.now() - t0;
    logTiming('Total', timings.total);

    hudSend('jarvis:done', {
      ok:          agentResult.ok,
      display:     agentResult.finalText,
      audioBase64: audioB64Agent,
      mimeType:    mimeAgent,
      path:        'agent',
      stopped:     agentResult.stopped,
    });
    return;
  }

  // ── 3. Confirmation gate ─────────────────────────────────────────────────────
  // For file ops that search by name (no resolved path yet), skip confirmation
  // here — dispatch will either return ambiguous (disambiguation flow) or return
  // _resolved with the concrete filename. Confirmation fires after resolution.
  const FIND_FIRST_INTENTS = new Set(['file.delete', 'file.rename', 'file.move']);
  const deferConfirm =
    classifierResult.needsConfirm &&
    FIND_FIRST_INTENTS.has(classifierResult.intent) &&
    !classifierResult.params.path;

  if (classifierResult.needsConfirm && !deferConfirm) {
    hudSend('jarvis:confirm', {
      message:     buildConfirmMessage(classifierResult),
      actionLabel: buildActionLabel(classifierResult),
    });

    let confirmed = false;
    try {
      confirmed = await waitForConfirm();
    } catch {
      confirmed = false; // timeout treated as cancel
    }

    if (!confirmed) {
      hudSend('jarvis:done', { ok: false, display: 'Cancelled.' });
      return;
    }
  }

  // ── 3b. Inject module-level context for standalone commands ──────────────────
  // This extends the chain-context injection (_injectChainContext) to work for
  // single commands that follow a prior app.focus/file.open in a separate turn.
  // Only injects when no chain context is already set on the result.
  _injectStandaloneContext(classifierResult);

  // ── 3c. M4.7 ack TTS — disabled ─────────────────────────────────────────────
  // The ack ("Opening notepad…") immediately followed by the result
  // ("Opened notepad.") was redundant. The result-tier TTS after verify is the
  // only spoken response now. Setting plumbing left in place; flip
  // jarvisAckTtsEnabled in settings.js and the saved settings.json to revive.
  {
    const settingsMod = require('../settings');
    const ackEnabled  =
      settingsMod.getSetting('jarvisStreamingEnabled', true) &&
      settingsMod.getSetting('jarvisAckTtsEnabled', false);
    if (ackEnabled) {
      const phrase = ackMod.ackPhraseFor(classifierResult.intent, classifierResult.params, {
        needsConfirm: false,
      });
      if (phrase) {
        run.ackPhrase = phrase;
        _ackPromise   = ackMod.fireAck(phrase, hudSend);
      }
    }
  }

  // ── 4. Dispatch ──────────────────────────────────────────────────────────────
  hudSend('jarvis:status', { phase: 'executing', intent: classifierResult.intent, transcript });
  const t2 = Date.now();
  let toolResult;
  try {
    toolResult = await dispatcherMod.dispatch(classifierResult, { signal: controller.signal });
  } catch (err) {
    // DispatchError — param validation failure
    run.dispatch = 'error';
    run.error    = err.message;
    await speakAndDone(hudSend, false, err.message, err.message, timings, t0);
    return;
  }
  timings.dispatch = Date.now() - t2;
  logTiming('Dispatch', timings.dispatch);
  _toolResult = toolResult;

  // ── 4a. M4.7 — handle cancellation ─────────────────────────────────────────
  if (controller.signal.aborted || toolResult.cancelled) {
    run.dispatch = 'cancelled';
    run.error    = 'cancelled';
    hudSend('jarvis:done', { ok: false, display: 'Cancelled.', stopped: 'cancelled' });
    return;
  }

  // ── 4b. Disambiguation: file op found multiple candidates ─────────────────
  if (!toolResult.ok && toolResult.ambiguous) {
    run.dispatch = 'ambiguous';
    const list = (toolResult.candidates || [])
      .slice(0, 5)
      .map((c, i) => `${i + 1}. ${c.name}`)
      .join(' — ');
    hudSend('jarvis:disambiguate', {
      candidates: toolResult.candidates,
      original:   transcript,
      listText:   list,
    });
    await speakAndDone(hudSend, false, toolResult.action, toolResult.action, timings, t0, { disambiguating: true });
    return;
  }

  if (!toolResult.ok) {
    run.dispatch = 'error';
    run.error    = toolResult.error || null;
    await speakAndDone(hudSend, false, toolResult.error, toolResult.error, timings, t0);
    return;
  }

  run.dispatch = 'ok';

  // ── 4c. _resolved: re-dispatch with resolved target and confirmation gate ──
  // Used by system.select (ordinal selection) and by file.delete/rename/move
  // after they resolve a single match — confirmation fires with the real filename.
  if (toolResult.ok && toolResult._resolved) {
    const resolved = toolResult._resolved;

    // Confirmation gate for the resolved intent
    if (resolved.needsConfirm) {
      hudSend('jarvis:confirm', {
        message:     buildConfirmMessage(resolved),
        actionLabel: buildActionLabel(resolved),
      });
      let confirmed = false;
      try { confirmed = await waitForConfirm(); } catch { confirmed = false; }
      if (!confirmed) {
        hudSend('jarvis:done', { ok: false, display: 'Cancelled.' });
        return;
      }
    }

    // Re-dispatch the resolved intent
    hudSend('jarvis:status', { phase: 'executing', intent: resolved.intent, transcript });
    const t2b = Date.now();
    let resolvedResult;
    try {
      resolvedResult = await dispatcherMod.dispatch(resolved);
    } catch (err) {
      await speakAndDone(hudSend, false, err.message, err.message, timings, t0);
      return;
    }
    timings.dispatch += Date.now() - t2b;

    if (!resolvedResult.ok) {
      await speakAndDone(hudSend, false, resolvedResult.error, resolvedResult.error, timings, t0);
      return;
    }

    // Verify the resolved intent
    hudSend('jarvis:status', { phase: 'verifying', intent: resolved.intent, transcript });
    const t3b = Date.now();
    const resolvedVerify = await verifierMod.verify(resolved, resolvedResult);
    timings.verify = Date.now() - t3b;
    logTiming('Verify(resolved)', timings.verify);

    const resolvedDisplay = buildDisplay(resolvedResult, resolvedVerify);
    const resolvedSpoken  = buildSpoken(resolvedResult, resolvedVerify);

    // TTS for the resolved operation
    hudSend('jarvis:status', { phase: 'speaking', transcript });
    const t4b = Date.now();
    let audioBase64b = null;
    let mimeTypeb    = null;
    try {
      const { synthesizeSpeech } = require('../tts');
      const ttsResult = await synthesizeSpeech(resolvedSpoken);
      audioBase64b = ttsResult.audioBuffer.toString('base64');
      mimeTypeb    = ttsResult.mimeType;
    } catch { /* non-fatal */ }
    timings.tts   = Date.now() - t4b;
    timings.total = Date.now() - t0;
    logTiming('Total', timings.total);

    // Emit context badge after resolved dispatch
    _maybeEmitContextEvent(hudSend);

    // M4.8 — record the resolved action so "do that again" / "undo" can target it.
    _recordLastAction(resolved, resolvedResult, transcript);

    hudSend('jarvis:done', {
      ok: true,
      display: resolvedDisplay,
      audioBase64: audioBase64b,
      mimeType: mimeTypeb,
      verifiedBy: resolvedVerify.verified
        ? `${resolvedVerify.method} (${resolvedVerify.detail || 'ok'})`
        : null,
    });
    return;
  }

  // ── 5. Verify ────────────────────────────────────────────────────────────────
  hudSend('jarvis:status', { phase: 'verifying', intent: classifierResult.intent, transcript });
  const t3 = Date.now();
  const verifierResult = await verifierMod.verify(classifierResult, toolResult);
  timings.verify = Date.now() - t3;
  logTiming('Verify', timings.verify);
  _verifierResult = verifierResult;
  run.verify = verifierResult.verified ? 'ok' : 'unverified';

  // ── 6. Build spoken text ─────────────────────────────────────────────────────
  const display = buildDisplay(toolResult, verifierResult);
  const spoken  = buildSpoken(toolResult, verifierResult);

  // ── 7. TTS (non-fatal) ───────────────────────────────────────────────────────
  hudSend('jarvis:status', { phase: 'speaking', transcript });
  const t4 = Date.now();
  let audioBase64 = null;
  let mimeType    = null;

  try {
    const { synthesizeSpeech } = require('../tts');
    const ttsResult = await synthesizeSpeech(spoken);
    audioBase64 = ttsResult.audioBuffer.toString('base64');
    mimeType    = ttsResult.mimeType;
    timings.tts = Date.now() - t4;
    logTiming('TTS', timings.tts);
  } catch (err) {
    timings.tts = Date.now() - t4;
    console.warn(`[Jarvis] TTS failed (non-fatal): ${err.message}`);
  }

  timings.total = Date.now() - t0;
  logTiming('Total', timings.total);

  // ── 8. Emit context badge event if context changed ───────────────────────────
  _maybeEmitContextEvent(hudSend);

  // ── 8a. M5.4 — emit result-panel cards for result-bearing tools ────────────
  _maybeEmitResultsFromDispatch(hudSend, classifierResult, toolResult);

  // ── 8b. M4.8 — record the action for later repeat/undo ─────────────────────
  _recordLastAction(classifierResult, toolResult, transcript);

  // ── 9. Done ──────────────────────────────────────────────────────────────────
  hudSend('jarvis:done', {
    ok: true,
    display,
    audioBase64,
    mimeType,
    verifiedBy: verifierResult.verified
      ? `${verifierResult.method} (${verifierResult.detail || 'ok'})`
      : null,
  });

  } finally {
    // ── M4.4: Always emit structured run log ──────────────────────────────────
    const totalMs = timings.total || (Date.now() - t0);
    _emitStructuredRunLog(run, totalMs);
    _maybeWriteTrace(run, _classifierResult, _toolResult, _verifierResult, timings, hudSend)
      .catch(() => {});
    // ── M4.7: drain the ack TTS so its log line lands after our run log ──
    if (_ackPromise) { try { await _ackPromise; } catch { /* ignore */ } }
    // Restore previous controller (handles nested chain calls)
    if (_currentController === controller) _currentController = _prevController;
  }
}

// ─── M3.5: Two-step chained flow ─────────────────────────────────────────────

/**
 * Execute a two-part chained command sequentially.
 * If step 1 fails (unsupported, dispatch error, or tool failure), step 2 is skipped.
 * Both steps may independently require confirmation.
 *
 * @param {string[]} parts      — exactly 2 transcript parts
 * @param {boolean}  wasCapped  — true if original utterance had 3+ parts
 * @param {Function} hudSend
 * @param {Function} waitForConfirm
 * @param {number}   t0         — start timestamp
 */
async function _runChained(parts, wasCapped, hudSend, waitForConfirm, t0) {
  const actions = [];
  let   chainOk    = true;
  let   chainContext = null; // populated after step 1 for step-2 focus handoff

  for (let i = 0; i < parts.length; i++) {
    const stepLabel = `${i + 1} of 2`;
    const part = (parts[i] || '').trim();
    const stepT0 = Date.now();

    // ── Classify ──────────────────────────────────────────────────────────────
    hudSend('jarvis:status', { phase: 'classifying', transcript: part, step: stepLabel });
    const classified = await classifierMod.classify(part);

    // Capture context state and build per-step run log data (M4.4)
    const _stepSnap = context.snapshot();
    const stepRun = {
      id:       _generateRunId(),
      intent:   classified.intent,
      conf:     classified.confidence,
      p:        classified._patternIndex != null ? classified._patternIndex : null,
      ctx:      _computeCtxString(_stepSnap),
      ttl:      _computeTtlRemaining(_stepSnap),
      dispatch: 'skipped',
      verify:   'skipped',
      chainStep: stepLabel,
      // M4.4.1 — chain steps are pattern-routed today; M4.5 may override per-step.
      path:     'pattern',
    };

    if (classified.intent === 'system.unsupported') {
      const msg = classified.reason || "I don't know how to do that yet.";
      _emitStructuredRunLog(stepRun, Date.now() - stepT0);
      if (i === 0) {
        // Step 1 unrecognised — stop entirely, no second step
        hudSend('jarvis:done', { ok: false, display: msg });
        return;
      }
      // Step 2 unrecognised — record and break (step 1 already ran)
      actions.push(msg);
      chainOk = false;
      break;
    }

    // ── Confirm if needed ─────────────────────────────────────────────────────
    if (classified.needsConfirm) {
      hudSend('jarvis:confirm', {
        message:     buildConfirmMessage(classified),
        actionLabel: buildActionLabel(classified),
      });
      let confirmed = false;
      try { confirmed = await waitForConfirm(); } catch { confirmed = false; }
      if (!confirmed) {
        _emitStructuredRunLog(stepRun, Date.now() - stepT0);
        if (i === 0) {
          hudSend('jarvis:done', { ok: false, display: 'Cancelled.' });
          return;
        }
        actions.push('Second step cancelled.');
        chainOk = false;
        break;
      }
    }

    // ── Inject chain context before step 2 dispatch ───────────────────────────
    if (i === 1 && chainContext) {
      _injectChainContext(classified, chainContext);
    }

    // ── Dispatch ──────────────────────────────────────────────────────────────
    hudSend('jarvis:status', { phase: 'executing', intent: classified.intent, step: stepLabel });
    let toolResult;
    try {
      toolResult = await dispatcherMod.dispatch(classified);
    } catch (err) {
      stepRun.dispatch = 'error';
      _emitStructuredRunLog(stepRun, Date.now() - stepT0);
      if (i === 0) {
        hudSend('jarvis:done', { ok: false, display: err.message });
        return;
      }
      actions.push(`Second step failed: ${err.message}`);
      chainOk = false;
      break;
    }

    if (!toolResult.ok) {
      stepRun.dispatch = 'error';
      _emitStructuredRunLog(stepRun, Date.now() - stepT0);
      if (i === 0) {
        const errMsg = `The first step hit a problem: ${toolResult.error}. Skipped the second step.`;
        hudSend('jarvis:done', { ok: false, display: errMsg });
        return;
      }
      actions.push(`Second step failed: ${toolResult.error}`);
      chainOk = false;
      break;
    }

    stepRun.dispatch = 'ok';

    // ── Verify ────────────────────────────────────────────────────────────────
    hudSend('jarvis:status', { phase: 'verifying', intent: classified.intent, step: stepLabel });
    const verifyResult = await verifierMod.verify(classified, toolResult);
    stepRun.verify = verifyResult.verified ? 'ok' : 'unverified';
    _emitStructuredRunLog(stepRun, Date.now() - stepT0);
    const actionStr    = buildDisplay(toolResult, verifyResult);
    actions.push(actionStr);

    // M4.8 — chain steps each count as actions worth repeating/undoing.
    // The latest one wins; "do that again" repeats just step 2.
    _recordLastAction(classified, toolResult, part);

    // ── Build chain context after step 1 success ──────────────────────────────
    if (i === 0) {
      chainContext = await _buildChainContext(classified, toolResult);
    }
  }

  // ── All steps done ────────────────────────────────────────────────────────
  let display = actions.join(' ');
  if (wasCapped) display += ' I can only handle two commands at a time.';

  // TTS — speak all action strings joined
  let audioBase64 = null;
  let mimeType    = null;
  try {
    const { synthesizeSpeech } = require('../tts');
    const ttsResult = await synthesizeSpeech(display);
    audioBase64 = ttsResult.audioBuffer.toString('base64');
    mimeType    = ttsResult.mimeType;
  } catch { /* non-fatal */ }

  const totalMs = Date.now() - t0;
  console.log(`[JARVIS] Chain     : ${totalMs}ms (${actions.length} steps${wasCapped ? ', capped' : ''})`);

  hudSend('jarvis:done', {
    ok: chainOk,
    steps: actions,
    display,
    audioBase64,
    mimeType,
  });
}

// ─── Chain context helpers ────────────────────────────────────────────────────

/**
 * After step 1 succeeds, derive an execution context for step 2.
 * Only produced when step 1 is app.open or app.focus — these are the only
 * intents that change which window should own subsequent input/navigation.
 *
 * Returns { processName, hwnd, kind } or null.
 * kind: 'browser' | 'app'
 */
async function _buildChainContext(classified, toolResult) {
  const { intent, params = {} } = classified;
  if (intent !== 'app.open' && intent !== 'app.focus') return null;

  const { APP_NAMES, BROWSER_PROCESS_NAMES } = require('./tools/app-names');
  const { focusAndCaptureHwnd } = require('./tools/windows');

  let processName;
  if (intent === 'app.focus') {
    processName = toolResult.data?.processName;
  } else {
    // app.open — look up process name from the spoken app name
    const key = (params.appName || '').toLowerCase();
    processName = APP_NAMES[key]?.processName || params.appName;
    // Give the newly-launched app time to open a window before we focus it
    await new Promise((r) => setTimeout(r, 500));
  }

  if (!processName) return null;

  const hwnd = await focusAndCaptureHwnd(processName);
  const kind = BROWSER_PROCESS_NAMES.has(processName.toLowerCase()) ? 'browser' : 'app';
  console.log(`[JARVIS] Chain ctx : processName=${processName} hwnd=${hwnd} kind=${kind}`);
  return { processName, hwnd, kind };
}

/**
 * Before step 2 dispatch, route the chain context to the right mechanism:
 *
 *   input.*                    → set pending type-target HWND (typeText restores focus)
 *   browser.goto/search/site   → attach _chainContext so dispatcher uses navigateInWindowByProcess
 *   browser shortcuts          → set pending type-target HWND (dispatchBrowserShortcut restores focus)
 *
 * No-ops when chainContext has no hwnd and the intent doesn't need it.
 */
function _injectChainContext(classified, chainContext) {
  const { intent } = classified;
  const { setPendingTypeTargetWindowHandle } = require('./typing-target');

  const isInput          = intent.startsWith('input.');
  const isBrowserNav     = ['browser.goto', 'browser.search', 'browser.site'].includes(intent);
  const isBrowserShortcut = [
    'browser.newtab', 'browser.closetab', 'browser.back', 'browser.refresh', 'browser.addressbar',
  ].includes(intent);

  if (isInput && chainContext.hwnd) {
    setPendingTypeTargetWindowHandle(chainContext.hwnd);
    console.log(`[JARVIS] Chain inject: type target hwnd=${chainContext.hwnd} for ${intent}`);
  } else if (chainContext.kind === 'browser' && isBrowserNav) {
    classified._chainContext = chainContext;
    console.log(`[JARVIS] Chain inject: _chainContext processName=${chainContext.processName} for ${intent}`);
  } else if (chainContext.kind === 'browser' && isBrowserShortcut && chainContext.hwnd) {
    setPendingTypeTargetWindowHandle(chainContext.hwnd);
    console.log(`[JARVIS] Chain inject: type target hwnd=${chainContext.hwnd} for browser shortcut ${intent}`);
  }
}

// ─── M4.4: Structured run log and trace helpers ───────────────────────────────

function _generateRunId() {
  const ts   = Date.now();
  const rand = Math.random().toString(36).slice(2, 6);
  return `${ts}-${rand}`;
}

function _computeCtxString(snap) {
  const hasFile = !!(snap && snap.file);
  const hasWin  = !!(snap && snap.window);
  const hasCand = !!(snap && snap.candidates);
  if (hasCand)           return 'candidates';
  if (hasFile && hasWin) return 'both';
  if (hasFile)           return 'file';
  if (hasWin)            return 'window';
  return 'none';
}

function _computeTtlRemaining(snap) {
  if (!snap) return 0;
  let ttl = 0;
  if (snap.file)       ttl = Math.max(ttl, snap.file.ttlRemaining       || 0);
  if (snap.window)     ttl = Math.max(ttl, snap.window.ttlRemaining     || 0);
  if (snap.candidates) ttl = Math.max(ttl, snap.candidates.ttlRemaining || 0);
  return ttl;
}

function _emitStructuredRunLog(run, totalMs) {
  const pStr     = run.p != null ? run.p : '-';
  const pathStr  = run.path || 'pattern';
  const specStr  = run.speculative ? ' speculative=1' : '';
  const ackStr   = run.ackPhrase ? ` ack="${run.ackPhrase}"` : '';
  console.log(
    `[JARVIS RUN] id=${run.id} intent=${run.intent} conf=${run.conf} p=${pStr}` +
    ` path=${pathStr}${specStr}${ackStr} ctx=${run.ctx} ttl=${run.ttl}ms` +
    ` dispatch=${run.dispatch} verify=${run.verify} total=${totalMs}ms`
  );
}

async function _maybeWriteTrace(run, classifierResult, toolResult, verifierResult, timings, hudSend) {
  const s = require('../settings');
  if (!s.getSetting('jarvisTraceEnabled', false)) return;

  try {
    const traceMod = require('./trace');
    const acc = traceMod.createTrace(run.rawInput);

    if (classifierResult) {
      acc.setClassification(classifierResult, classifierResult._patternIndex);
    }
    acc.setContextUsed(run.ctxSnap || null);
    if (toolResult)   acc.setDispatch(toolResult);
    if (verifierResult) acc.setVerify(verifierResult);
    if (timings)      acc.setTimings(timings);
    if (run.chainStep) acc.setChainStep(run.chainStep);
    if (run.error)     acc.setError(run.error);
    // M4.4.1 — propagate routing path; M4.5 sets 'agent', M5.0 sets 'plan'.
    if (run.path)      acc.setPath(run.path);
    if (Array.isArray(run.agentSteps)) {
      for (const step of run.agentSteps) acc.addAgentStep(step);
    }
    // M5.0 — record the planner's plan + executed steps + replan count.
    if (run.plan)                         acc.setPlan(run.plan);
    if (Array.isArray(run.planSteps)) {
      for (const step of run.planSteps) acc.addPlanStep(step);
    }
    if (run.replans) for (let i = 0; i < run.replans; i++) acc.incReplans();

    const record = acc.build();
    traceMod.emitTrace(hudSend, record);
    await traceMod.writeTrace(record);
  } catch (err) {
    console.warn('[pipeline] Trace build failed (non-fatal):', err.message);
  }
}

// ─── M5.4: Result-panel emission helpers ─────────────────────────────────────

/**
 * Emit `jarvis:results` to the HUD when a plan produced a result-bearing tool
 * call (web.search, browser.search, browser.tabs.list, file.find). Saves the
 * active result set in context so "open the second one" works after the
 * plan finishes.
 */
function _maybeEmitResultsFromPlan(hudSend, planResult) {
  if (!planResult || !Array.isArray(planResult.planSteps)) return;
  // Walk the executed steps in reverse — the most recent result-producing step wins.
  for (let i = planResult.planSteps.length - 1; i >= 0; i--) {
    const step = planResult.planSteps[i];
    if (!step || !step.ok || !step.result) continue;
    const cards = _resultCardsFor(step);
    if (cards) {
      _emitResultCards(hudSend, cards);
      return;
    }
  }
}

/**
 * Convert the last dispatch result of a *pattern*-routed tool into a panel
 * payload, when applicable. Called from the single-intent flow.
 */
function _maybeEmitResultsFromDispatch(hudSend, classifierResult, toolResult) {
  if (!toolResult || !toolResult.ok) return;
  const fakeStep = {
    tool:   classifierResult ? classifierResult.intent : '',
    params: classifierResult ? classifierResult.params : {},
    result: toolResult,
    ok:     true,
  };
  const cards = _resultCardsFor(fakeStep, toolResult.data);
  if (cards) _emitResultCards(hudSend, cards);
}

function _resultCardsFor(step, fullData) {
  if (!step || !step.tool) return null;
  // Plan-step records carry an abbreviated `result` summary, so for the *last*
  // step we accept fullData (passed from dispatch) when present.
  const data = fullData || (step.result && step.result.data) || null;
  if (!data) return null;

  if ((step.tool === 'web.search' || step.tool === 'browser.search') && Array.isArray(data.results) && data.results.length) {
    return {
      kind:    'web',
      source:  step.tool,
      query:   data.query || (step.params && step.params.query) || '',
      cards:   data.results.slice(0, 5).map((r, i) => ({
        index:   i + 1,
        title:   r.title || r.url || '',
        url:     r.url || '',
        snippet: r.snippet || '',
      })),
    };
  }
  if (step.tool === 'browser.tabs.list' && Array.isArray(data.tabs) && data.tabs.length) {
    return {
      kind:   'tabs',
      source: step.tool,
      cards:  data.tabs.slice(0, 8).map((t, i) => ({
        index: i + 1,
        title: t.title || t.url || '',
        url:   t.url   || '',
        tabId: t.tabId,
        active: !!t.active,
      })),
    };
  }
  if (step.tool === 'file.find' && Array.isArray(data.matches) && data.matches.length > 1) {
    return {
      kind:   'files',
      source: step.tool,
      cards:  data.matches.slice(0, 5).map((m, i) => ({
        index: i + 1,
        title: m.name,
        path:  m.path,
      })),
    };
  }
  return null;
}

function _emitResultCards(hudSend, payload) {
  if (!payload || !Array.isArray(payload.cards) || payload.cards.length === 0) return;
  // Save in context so system.select / "the second one" can resolve later.
  try {
    context.setActiveResultSet({
      kind:   payload.kind,
      source: payload.source,
      cards:  payload.cards,
    });
  } catch { /* context setter optional in tests */ }
  try {
    hudSend('jarvis:results', payload);
  } catch { /* HUD optional */ }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function speakAndDone(hudSend, ok, display, spokenText, timings, t0, extraPayload = {}) {
  let audioBase64 = null;
  let mimeType    = null;

  if (!ok && spokenText) {
    try {
      const { synthesizeSpeech } = require('../tts');
      const ttsResult = await synthesizeSpeech(spokenText);
      audioBase64 = ttsResult.audioBuffer.toString('base64');
      mimeType    = ttsResult.mimeType;
    } catch { /* non-fatal */ }
  }

  timings.total = Date.now() - t0;
  logTiming('Total', timings.total);

  hudSend('jarvis:done', { ok, display, audioBase64, mimeType, ...extraPayload });
}

function buildDisplay(toolResult, verifierResult) {
  let text = toolResult.action || (toolResult.ok ? 'Done.' : toolResult.error);
  if (verifierResult && !verifierResult.verified) {
    text += ' (unverified)';
  }
  return text;
}

function buildSpoken(toolResult, verifierResult) {
  const base = toolResult.action || (toolResult.ok ? 'Done.' : toolResult.error);
  if (verifierResult && verifierResult.verified && verifierResult.detail) {
    return base; // action string is already human-readable
  }
  return base;
}

function buildConfirmMessage(classifierResult) {
  const { intent, params } = classifierResult;
  if (intent === 'file.write')  return `This will overwrite existing content in "${params.name}". Continue?`;
  if (intent === 'file.append') return `Append ${params.content?.length || 0} characters to "${params.name}"?`;
  if (intent === 'file.delete') return `Permanently delete "${params.name}"? This cannot be undone.`;
  if (intent === 'file.rename') return `Rename "${params.name}" to "${params.newName}"?`;
  if (intent === 'file.move')   return `Move "${params.name}" to ${params.targetLocationHint}?`;
  if (intent === 'system.lock') return 'Lock the screen?';
  return 'Confirm this action?';
}

function buildActionLabel(classifierResult) {
  const { intent } = classifierResult;
  if (intent === 'file.write')  return 'Overwrite';
  if (intent === 'file.append') return 'Append';
  if (intent === 'file.delete') return 'Delete';
  if (intent === 'file.rename') return 'Rename';
  if (intent === 'file.move')   return 'Move';
  if (intent === 'system.lock') return 'Lock';
  return 'Confirm';
}

function logTiming(label, ms, note) {
  const noteStr = note ? ` (${note})` : '';
  console.log(`[JARVIS] ${label.padEnd(10)}: ${ms}ms${noteStr}`);
}

// ─── M4.0: Standalone context injection ──────────────────────────────────────

/**
 * For a single (non-chain) command, inject module-level context if available.
 *
 * input.*        → set pending type-target HWND from window context
 * browser nav    → attach _chainContext from window context (kind=browser)
 *
 * Only fires when no _chainContext is already present (chain injection takes
 * priority because it captures the HWND in real-time with a settle delay).
 */
function _injectStandaloneContext(classifierResult) {
  const { intent } = classifierResult;
  if (classifierResult._chainContext) return; // chain injection already set

  const { setPendingTypeTargetWindowHandle } = require('./typing-target');

  const isInput      = intent.startsWith('input.');
  const isBrowserNav = ['browser.goto', 'browser.search', 'browser.site'].includes(intent);
  const isBrowserShortcut = [
    'browser.newtab', 'browser.closetab', 'browser.back', 'browser.refresh', 'browser.addressbar',
  ].includes(intent);

  const win = context.getWindowTarget();
  if (!win) return;

  if (isInput && win.hwnd) {
    setPendingTypeTargetWindowHandle(win.hwnd);
    console.log(`[JARVIS] Ctx inject : type target hwnd=${win.hwnd} for ${intent} (standalone)`);
  } else if (win.kind === 'browser' && isBrowserNav) {
    classifierResult._chainContext = { processName: win.processName, hwnd: win.hwnd, kind: 'browser' };
    console.log(`[JARVIS] Ctx inject : _chainContext processName=${win.processName} for ${intent} (standalone)`);
  } else if (win.kind === 'browser' && isBrowserShortcut && win.hwnd) {
    setPendingTypeTargetWindowHandle(win.hwnd);
    console.log(`[JARVIS] Ctx inject : type target hwnd=${win.hwnd} for ${intent} (standalone shortcut)`);
  }
}

// ─── M4.8: Record last action for "do that again" / "undo that" ─────────────

const _META_INTENTS = new Set([
  'system.repeat', 'system.undo',
  'system.cancel', 'system.select',
  'system.unsupported',
]);

/**
 * Record a successful action for later repeat/undo. Filters meta intents so
 * "do that again" never re-triggers itself.
 */
function _recordLastAction(classifierResult, toolResult, transcript) {
  if (!classifierResult || !classifierResult.intent) return;
  if (_META_INTENTS.has(classifierResult.intent)) return;
  if (!toolResult || !toolResult.ok) return;
  context.setLastAction({
    intent:       classifierResult.intent,
    params:       classifierResult.params || {},
    result:       toolResult,
    transcript:   transcript || classifierResult.raw || '',
    needsConfirm: classifierResult.needsConfirm === true,
  });
}

// ─── M4.5: Context badge event ────────────────────────────────────────────────

/**
 * After a successful dispatch, emit jarvis:context if any context is active.
 * Renderer uses this to show/fade the context badge.
 */
function _maybeEmitContextEvent(hudSend) {
  const fileCtx = context.getFileTarget();
  const winCtx  = context.getWindowTarget();

  if (!fileCtx && !winCtx) return;

  const ttlMs = require('../settings').getSetting('jarvisContextTtlMs', 30000);
  hudSend('jarvis:context', {
    file:   fileCtx ? fileCtx.name   : null,
    window: winCtx  ? winCtx.processName : null,
    ttlMs,
  });
}

module.exports = { runPipelineFromText, runPipelineFromAudio, prewarmClassify, cancelCurrent, maybeVoiceCancel };
