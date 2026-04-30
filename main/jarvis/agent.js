'use strict';

/**
 * agent.js — M4.5 Tool-Calling Agent Layer.
 *
 * When the pattern classifier returns system.unsupported, the pipeline calls
 * runAgent() with the original transcript. The agent uses an LLM with
 * function-calling to pick one of the tools defined in tool-schemas.js and
 * dispatches it through the existing dispatcher (so all confirmation gates,
 * verifier, and context machinery still apply).
 *
 * Bounded:
 *   - max steps:    jarvisAgentMaxSteps   (default 3)
 *   - wall-clock:   jarvisAgentTimeoutMs  (default 4000ms)
 *   - destructive intents: must pass through the same waitForConfirm() the
 *     pipeline uses for pattern-classified destructive commands.
 *
 * Returns shape:
 *   {
 *     ok:         boolean,
 *     finalText:  string,                     // what to speak / display
 *     agentSteps: Array<step>,                // captured for trace
 *     lastDispatchResult: object|null,        // last toolResult, for verifier
 *     lastClassifierResult: object|null,      // synthesized {intent, params, confidence:'agent'}
 *     stopped: 'final'|'maxSteps'|'timeout'|'cancelled'|'error'|'noToolEnabled',
 *     error?: string,
 *   }
 *
 * step shape: { tool, params, result, latencyMs, retry }
 */

const settings    = require('../settings');
const dispatcherMod = require('./dispatcher');
const toolSchemas = require('./tool-schemas');
const context     = require('./context');

// llm.js is required lazily so agent.js stays importable in pure-Node tests
// even when Electron-specific modules in llm.js (like jimp) aren't present.

// ─── Default LLM caller (real API) ────────────────────────────────────────────

async function _defaultLlmCaller(args) {
  const { callWithTools } = require('../llm');
  return callWithTools(args);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * @param {object}   opts
 * @param {string}   opts.transcript       — original user transcript
 * @param {Function} opts.hudSend          — (channel, payload) => void
 * @param {Function} opts.waitForConfirm   — () => Promise<boolean>
 * @param {Function} [opts.dispatch]       — overrides dispatcherMod.dispatch (tests)
 * @param {Function} [opts.llmCall]        — overrides callWithTools (tests)
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<AgentResult>}
 */
async function runAgent(opts = {}) {
  const {
    transcript,
    hudSend = () => {},
    waitForConfirm = async () => true,
    llmCall  = _defaultLlmCaller,
    signal,
  } = opts;
  // M4.8 audit fix — default dispatch threads the signal through to dispatcher
  // so cancelCurrent() propagates into agent-routed tool calls.
  const dispatch = opts.dispatch || ((cr) => dispatcherMod.dispatch(cr, { signal }));

  const maxSteps    = Number(settings.getSetting('jarvisAgentMaxSteps', 3))   || 3;
  const timeoutMs   = Number(settings.getSetting('jarvisAgentTimeoutMs', 4000)) || 4000;
  const provider    = settings.getSetting('jarvisAgentProvider', 'gemini-2.5-flash');

  const t0          = Date.now();
  const agentSteps  = [];
  let lastResult    = null;
  let lastClassifierResult = null;

  // Build initial Gemini "contents" array. The LLM gets the transcript plus a
  // compact context summary so it can use file/window/candidate state.
  const contents = [{
    role:  'user',
    parts: [{ text: _buildUserPrompt(transcript) }],
  }];

  const functionDeclarations = toolSchemas.toGeminiFunctionDeclarations();
  if (functionDeclarations.length === 0) {
    return {
      ok: false,
      finalText: 'No agent tools registered.',
      agentSteps,
      lastDispatchResult:   null,
      lastClassifierResult: null,
      stopped: 'noToolEnabled',
      error:   'no tools',
    };
  }

  for (let step = 0; step < maxSteps; step++) {
    const remainingMs = timeoutMs - (Date.now() - t0);
    if (remainingMs <= 50) {
      return _result(false, 'Agent timed out before completing.', agentSteps, lastResult, lastClassifierResult, 'timeout');
    }
    if (signal && signal.aborted) {
      return _result(false, 'Agent cancelled.', agentSteps, lastResult, lastClassifierResult, 'cancelled');
    }

    let llmResp;
    const tCall = Date.now();
    try {
      llmResp = await llmCall({
        model:                provider,
        systemPrompt:         SYSTEM_PROMPT,
        contents,
        functionDeclarations,
        signal,
        timeoutMs:            Math.min(remainingMs, timeoutMs),
      });
    } catch (err) {
      return _result(false, `Agent LLM error: ${err.message}`,
        agentSteps, lastResult, lastClassifierResult, 'error', err.message);
    }
    const callLatency = Date.now() - tCall;

    // Final answer (no tool call) — agent is done.
    if (!llmResp.functionCall) {
      const finalText = (llmResp.text || '').trim();
      if (!finalText) {
        return _result(false, "I'm not sure how to do that.",
          agentSteps, lastResult, lastClassifierResult, 'final');
      }
      return _result(true, finalText, agentSteps, lastResult, lastClassifierResult, 'final');
    }

    // Tool call requested.
    const { name, args } = llmResp.functionCall;

    if (!toolSchemas.isRegistered(name)) {
      // Tell the model the tool is invalid and let it try again.
      contents.push({ role: 'model', parts: [{ functionCall: { name, args: args || {} } }] });
      contents.push({
        role: 'function',
        parts: [{ functionResponse: { name, response: { ok: false, error: `Unknown tool "${name}".` } } }],
      });
      agentSteps.push({
        tool: name, params: args || {}, result: { ok: false, error: 'unknown tool' }, latencyMs: callLatency, retry: false,
      });
      continue;
    }

    // Build a synthesized ClassifierResult for the dispatcher.
    const params = (args && typeof args === 'object') ? args : {};
    const classifierResult = {
      intent:        name,
      confidence:    'agent',
      params,
      raw:           transcript,
      needsConfirm:  toolSchemas.needsConfirmFor(name, params),
    };
    lastClassifierResult = classifierResult;

    // Confirmation gate (same machinery as the pipeline uses for patterns).
    if (classifierResult.needsConfirm) {
      try {
        hudSend('jarvis:confirm', {
          message:     _buildConfirmMessage(classifierResult),
          actionLabel: _buildActionLabel(classifierResult),
        });
      } catch { /* hud failure is non-fatal */ }
      let confirmed = false;
      try { confirmed = await waitForConfirm(); } catch { confirmed = false; }
      if (!confirmed) {
        agentSteps.push({
          tool: name, params, result: { ok: false, error: 'cancelled by user' }, latencyMs: Date.now() - tCall, retry: false,
        });
        return _result(false, 'Cancelled.', agentSteps, lastResult, classifierResult, 'cancelled');
      }
    }

    // Dispatch the tool.
    const tDispatch = Date.now();
    let toolResult;
    try {
      toolResult = await dispatch(classifierResult);
    } catch (err) {
      const errResult = { ok: false, error: err.message || 'dispatch threw' };
      agentSteps.push({
        tool: name, params, result: errResult, latencyMs: Date.now() - tCall, retry: false,
      });
      // Surface to the model so it can recover.
      contents.push({ role: 'model', parts: [{ functionCall: { name, args: params } }] });
      contents.push({ role: 'function', parts: [{ functionResponse: { name, response: errResult } }] });
      lastResult = errResult;
      continue;
    }
    const dispatchLatency = Date.now() - tDispatch;

    lastResult = toolResult;
    agentSteps.push({
      tool: name,
      params,
      result: _summarizeToolResult(toolResult),
      latencyMs: callLatency + dispatchLatency,
      retry: false,
    });

    // Push the tool exchange into the conversation so the LLM can decide whether
    // it's done or wants to call another tool.
    contents.push({ role: 'model', parts: [{ functionCall: { name, args: params } }] });
    contents.push({
      role: 'function',
      parts: [{ functionResponse: { name, response: _summarizeToolResult(toolResult, /*includeData=*/true) } }],
    });

    // If the dispatch result is fully satisfying and the user instruction maps
    // 1:1 to one tool call, the LLM is likely to answer with finalText next
    // turn. We continue the loop.
  }

  // Hit max steps without a final answer. Synthesize a reasonable finalText
  // from the last tool result so we still say something useful.
  const fallback = (lastResult && lastResult.action) ||
                   (lastResult && lastResult.error)  ||
                   'Reached step limit without finishing.';
  const ok = !!(lastResult && lastResult.ok);
  return _result(ok, fallback, agentSteps, lastResult, lastClassifierResult, 'maxSteps');
}

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Jarvis, a voice-controlled desktop agent on Windows.
The user speaks short commands. You translate each command into one or more
tool calls. Tools are exposed as functions you can call directly.

RULES:
- Always prefer calling a tool over answering with text.
- For multi-step tasks, call tools one at a time. After each result, decide
  the next call. You can call up to 3 tools per turn.
- For ambiguous file commands (delete/rename/move) without an absolute path,
  call file.find FIRST. If file.find returns a single match, you may then call
  the destructive tool with the resolved "path".
- When you have completed the user's request OR cannot proceed, reply with a
  short spoken confirmation/explanation (one sentence) and DO NOT call further
  tools.
- Do not invent file names, app names, URLs, or paths the user did not state.
- Keep "text" arguments to input.type LITERAL — do not paraphrase.`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _buildUserPrompt(transcript) {
  const snap = context.snapshot();
  const parts = [`User said: "${transcript}"`];

  if (snap && (snap.file || snap.window || snap.candidates || snap.lastAction)) {
    parts.push('Current execution context:');
    if (snap.file)       parts.push(`- recent file: ${snap.file.name} at ${snap.file.path}`);
    if (snap.window)     parts.push(`- focused window: ${snap.window.processName} (${snap.window.kind})`);
    if (snap.candidates) parts.push(`- pending disambiguation candidates: ${snap.candidates.candidates.length}`);
    if (snap.lastAction) {
      // M4.8 — let the agent reason about "now make it bold", "again", "undo" etc.
      const la = snap.lastAction;
      const paramsBrief = (() => {
        try { return JSON.stringify(la.params).slice(0, 120); } catch { return '{}'; }
      })();
      parts.push(`- last action: ${la.intent} ${paramsBrief} ("${(la.transcript || '').slice(0, 80)}")`);
    }
  }
  return parts.join('\n');
}

function _summarizeToolResult(toolResult, includeData = false) {
  if (!toolResult || typeof toolResult !== 'object') return { ok: false, error: 'no result' };
  const out = { ok: !!toolResult.ok };
  if (toolResult.error)  out.error  = String(toolResult.error).slice(0, 300);
  if (toolResult.action) out.action = String(toolResult.action).slice(0, 300);
  if (toolResult.ambiguous) {
    out.ambiguous = true;
    out.candidates = (toolResult.candidates || []).slice(0, 5).map((c) => ({
      name: c.name, path: c.path,
    }));
  }
  if (includeData && toolResult.data && typeof toolResult.data === 'object') {
    // Trim heavy data shapes — keep only small primitive/array fields.
    out.data = {};
    for (const [k, v] of Object.entries(toolResult.data)) {
      if (v == null) continue;
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        out.data[k] = v;
      } else if (Array.isArray(v) && v.length <= 10) {
        out.data[k] = v.slice(0, 10).map((x) => (typeof x === 'object' ? { name: x.name, path: x.path } : x));
      }
    }
  }
  return out;
}

// Confirmation message helpers (mirror pipeline.js so the prompt looks the
// same to the user whether the gate fires from a pattern or from the agent).
function _buildConfirmMessage(cr) {
  const { intent, params } = cr;
  if (intent === 'file.write')  return `This will overwrite existing content in "${params.name}". Continue?`;
  if (intent === 'file.append') return `Append ${params.content ? params.content.length : 0} characters to "${params.name}"?`;
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

function _result(ok, finalText, agentSteps, lastDispatchResult, lastClassifierResult, stopped, error) {
  return { ok, finalText, agentSteps, lastDispatchResult, lastClassifierResult, stopped, error: error || null };
}

// ─── M4.8 — Verify-fail retry ────────────────────────────────────────────────

/**
 * Run ONE more agent turn after a verify failure, with the failure context
 * seeded into the prompt. Cap is 1 — if this also fails verify, the pipeline
 * gives up. Returns the same shape as runAgent(), with every step stamped
 * `retry: true` for trace correlation.
 *
 * @param {object} opts
 * @param {string} opts.originalTranscript
 * @param {object} opts.lastClassifierResult
 * @param {object} opts.lastDispatchResult
 * @param {object} opts.verifierResult
 * @param {Function} [opts.hudSend]
 * @param {Function} [opts.waitForConfirm]
 * @param {Function} [opts.dispatch]
 * @param {Function} [opts.llmCall]
 * @param {AbortSignal} [opts.signal]
 */
async function retryAgent(opts = {}) {
  const {
    originalTranscript,
    lastClassifierResult,
    lastDispatchResult,
    verifierResult,
    hudSend, waitForConfirm, dispatch, llmCall, signal,
  } = opts;

  if (!originalTranscript) {
    return { ok: false, finalText: 'No transcript to retry.', agentSteps: [], lastDispatchResult: null, lastClassifierResult: null, stopped: 'error' };
  }

  const failureLines = [
    `Previous attempt failed verification.`,
    `Tool you called: ${lastClassifierResult ? lastClassifierResult.intent : 'unknown'}`,
  ];
  if (lastClassifierResult && lastClassifierResult.params) {
    try { failureLines.push(`Params: ${JSON.stringify(lastClassifierResult.params).slice(0, 200)}`); } catch { /* ignore */ }
  }
  if (lastDispatchResult) {
    failureLines.push(`Tool result: ok=${!!lastDispatchResult.ok}${lastDispatchResult.error ? ' error="' + String(lastDispatchResult.error).slice(0, 120) + '"' : ''}`);
  }
  if (verifierResult) {
    failureLines.push(`Verifier said: ${verifierResult.detail || 'unverified'}`);
  }
  failureLines.push('Pick a different approach (different element name, different tool, refine params).');

  const seededTranscript = `${originalTranscript}\n\n[RETRY]\n${failureLines.join('\n')}`;

  const result = await runAgent({
    transcript:     seededTranscript,
    hudSend, waitForConfirm, dispatch, llmCall, signal,
  });
  // Stamp retry:true on every step from this attempt for trace correlation.
  result.agentSteps = (result.agentSteps || []).map((s) => ({ ...s, retry: true }));
  result.isRetry = true;
  return result;
}

module.exports = { runAgent, retryAgent, SYSTEM_PROMPT };
