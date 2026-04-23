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

// stt/tts are required lazily so pipeline.js stays importable in Tier A tests
// without Electron. In M3, stt will be called from runPipelineFromAudio.

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

async function _runSingle(transcript, hudSend, waitForConfirm, t0) {
  const timings = {};

  // ── 1. Classify ─────────────────────────────────────────────────────────────
  hudSend('jarvis:status', { phase: 'classifying', transcript });
  const t1 = Date.now();
  const classifierResult = await classifierMod.classify(transcript);
  timings.classify = Date.now() - t1;
  logTiming('Classify', timings.classify, classifierResult.confidence);

  // ── 2. Unsupported fast-exit ─────────────────────────────────────────────────
  if (classifierResult.intent === 'system.unsupported') {
    const msg = classifierResult.reason || "I don't know how to do that yet.";
    await speakAndDone(hudSend, false, msg, msg, timings, t0);
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

  // ── 4. Dispatch ──────────────────────────────────────────────────────────────
  hudSend('jarvis:status', { phase: 'executing', intent: classifierResult.intent, transcript });
  const t2 = Date.now();
  let toolResult;
  try {
    toolResult = await dispatcherMod.dispatch(classifierResult);
  } catch (err) {
    // DispatchError — param validation failure
    await speakAndDone(hudSend, false, err.message, err.message, timings, t0);
    return;
  }
  timings.dispatch = Date.now() - t2;
  logTiming('Dispatch', timings.dispatch);

  // ── 4b. Disambiguation: file op found multiple candidates ─────────────────
  if (!toolResult.ok && toolResult.ambiguous) {
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
    await speakAndDone(hudSend, false, toolResult.error, toolResult.error, timings, t0);
    return;
  }

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

  // ── 8. Done ──────────────────────────────────────────────────────────────────
  hudSend('jarvis:done', {
    ok: true,
    display,
    audioBase64,
    mimeType,
    verifiedBy: verifierResult.verified
      ? `${verifierResult.method} (${verifierResult.detail || 'ok'})`
      : null,
  });
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

    // ── Classify ──────────────────────────────────────────────────────────────
    hudSend('jarvis:status', { phase: 'classifying', transcript: part, step: stepLabel });
    const classified = await classifierMod.classify(part);

    if (classified.intent === 'system.unsupported') {
      const msg = classified.reason || "I don't know how to do that yet.";
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
      if (i === 0) {
        hudSend('jarvis:done', { ok: false, display: err.message });
        return;
      }
      actions.push(`Second step failed: ${err.message}`);
      chainOk = false;
      break;
    }

    if (!toolResult.ok) {
      if (i === 0) {
        const errMsg = `The first step hit a problem: ${toolResult.error}. Skipped the second step.`;
        hudSend('jarvis:done', { ok: false, display: errMsg });
        return;
      }
      actions.push(`Second step failed: ${toolResult.error}`);
      chainOk = false;
      break;
    }

    // ── Verify ────────────────────────────────────────────────────────────────
    hudSend('jarvis:status', { phase: 'verifying', intent: classified.intent, step: stepLabel });
    const verifyResult = await verifierMod.verify(classified, toolResult);
    const actionStr    = buildDisplay(toolResult, verifyResult);
    actions.push(actionStr);

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

module.exports = { runPipelineFromText, runPipelineFromAudio };
