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
    // ── M3.5: detect chain ─────────────────────────────────────────────────────
    const { parts, wasCapped } = classifierMod.splitChain(transcript);

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
  if (classifierResult.needsConfirm) {
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

  if (!toolResult.ok) {
    await speakAndDone(hudSend, false, toolResult.error, toolResult.error, timings, t0);
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
  let   chainOk = true;

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function speakAndDone(hudSend, ok, display, spokenText, timings, t0) {
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

  hudSend('jarvis:done', { ok, display, audioBase64, mimeType });
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

module.exports = { runPipelineFromText, runPipelineFromAudio };
