'use strict';

/**
 * planner.js — M5.0 multi-step planner.
 *
 * The planner replaces the M4.5 bounded 3-call agent for transcripts that the
 * pattern classifier cannot handle. Given a transcript + execution context, it
 * asks the LLM to emit a STRUCTURED PLAN (a list of tool calls in order) with
 * the goal and the spoken final summary baked in.
 *
 * The executor (executor.js) consumes that plan, dispatches each step through
 * the existing dispatcher (so all confirmation gates / verifier hooks fire),
 * and on a step failure can ask the planner to RE-PLAN once with the failure
 * context seeded.
 *
 * Plan shape returned by this module:
 *   {
 *     ok:                 true,
 *     goal:               'open three tabs about tesla layoffs',
 *     steps:              [{ tool, params, why }, ...],     // length 1..jarvisPlanMaxSteps
 *     expectedFinalSpeak: 'Opened three tabs about the layoffs.',
 *   }
 *
 * On planner failure (LLM error, no JSON, empty steps): { ok: false, error }.
 *
 * Pure JS — no Electron imports — so it loads in pure-Node tests. The LLM
 * caller is injected/replaceable for tests.
 */

const settings    = require('../settings');
const toolSchemas = require('./tool-schemas');
const context     = require('./context');

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * @param {object}   opts
 * @param {string}   opts.transcript
 * @param {object}   [opts.history]            — array of last N completed turns
 * @param {object}   [opts.failure]            — when re-planning: { lastStep, error, observed }
 * @param {Function} [opts.llmCall]            — defaults to llm.callForJson
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ ok, goal?, steps?, expectedFinalSpeak?, error?, raw? }>}
 */
async function makePlan(opts = {}) {
  const {
    transcript,
    history,
    failure,
    signal,
  } = opts;

  if (!transcript || typeof transcript !== 'string') {
    return { ok: false, error: 'No transcript' };
  }

  const provider     = settings.getSetting('jarvisAgentProvider', 'gemini-2.5-flash');
  const timeoutMs    = Number(settings.getSetting('jarvisPlanTimeoutMs', 30000)) || 30000;
  const maxSteps     = Number(settings.getSetting('jarvisPlanMaxSteps',  15))     || 15;

  const llmCall = opts.llmCall || _defaultLlmCaller;

  const userPrompt = _buildUserPrompt({ transcript, history, failure, maxSteps });
  const systemPrompt = _buildSystemPrompt({ maxSteps });

  let llmResp;
  try {
    llmResp = await llmCall({
      model:        provider,
      systemPrompt,
      userPrompt,
      signal,
      timeoutMs,
      temperature:  0.2,
    });
  } catch (err) {
    return { ok: false, error: `Planner LLM error: ${err.message}` };
  }

  if (!llmResp || !llmResp.json) {
    return { ok: false, error: 'Planner returned no JSON', raw: llmResp && llmResp.text };
  }

  const plan = _normalizePlan(llmResp.json, maxSteps);
  if (!plan.ok) return plan;

  return {
    ok:                  true,
    goal:                plan.goal,
    steps:               plan.steps,
    expectedFinalSpeak:  plan.expectedFinalSpeak,
    raw:                 llmResp.json,
  };
}

// ─── Default LLM caller ───────────────────────────────────────────────────────

async function _defaultLlmCaller(args) {
  const { callForJson } = require('../llm');
  return callForJson(args);
}

// ─── Prompt construction ──────────────────────────────────────────────────────

function _buildSystemPrompt({ maxSteps }) {
  // Build the canonical tool description block from the registered schemas so
  // the planner stays in lock-step with whatever tools are currently exposed.
  const toolLines = toolSchemas.TOOL_SCHEMAS.map((s) => {
    const required = (s.parameters && s.parameters.required) || [];
    const props    = (s.parameters && s.parameters.properties) || {};
    const paramKeys = Object.keys(props);
    const paramStr  = paramKeys.length
      ? paramKeys.map((k) => required.includes(k) ? `${k}*` : k).join(', ')
      : '(none)';
    const destrTag  = s.destructive ? ' [DESTRUCTIVE - confirms]' : '';
    return `  - ${s.name}: ${s.description} Params: ${paramStr}.${destrTag}`;
  }).join('\n');

  return `You are Jarvis, a voice-controlled Windows desktop assistant. The user
just spoke a single instruction. Your job is to write a PLAN: an ordered list
of tool calls that accomplishes the user's goal end-to-end.

You DO NOT execute tools yourself — another component runs each step. You only
output the plan as a JSON object.

OUTPUT FORMAT (return strict JSON, no commentary, no code fences):
{
  "goal":               "<one short sentence summarising what the user wants>",
  "steps":              [
    { "tool": "<tool name>", "params": {<...>}, "why": "<one short clause>" },
    ...
  ],
  "expectedFinalSpeak": "<what to speak to the user when all steps succeed (max 18 words)>"
}

RULES:
- Maximum ${maxSteps} steps. Use as few as possible.
- Tool names MUST be one of those listed below. Do NOT invent tools.
- Params MUST match the listed parameter keys. Required keys are marked with *.
- For "what's happening / look up / find me X" prefer web.search over browser.*.
  web.search returns text snippets in ~300 ms; browser.search opens a tab.
- For "play <song>" with Spotify likely open: app.focus + ui.fill + ui.click on
  the Spotify desktop window. Otherwise fall back to YouTube via browser.*.
- For "show me X / open three tabs / take me to Y" use browser.* (CDP) so the
  user sees results in their actual Chrome.
- For destructive steps (file.delete, file.rename, file.move, file.write,
  system.lock) the executor enforces a confirmation gate — DO include them when
  the user clearly asked, but don't try to "skip confirmation".
- Use vision.read ONLY as a strict fallback when ui.list returned nothing AND
  the active window is not Chrome.
- expectedFinalSpeak is what the user hears when the plan succeeds. Keep it
  natural and short ("Opened the top three articles about Tesla layoffs.").
- If the request is impossible or you have no viable tool path, return:
    {"goal":"<...>","steps":[],"expectedFinalSpeak":"<short reason>"}
  An empty steps array tells the executor to just speak expectedFinalSpeak.

TOOLS AVAILABLE:
${toolLines}`;
}

function _buildUserPrompt({ transcript, history, failure, maxSteps: _maxSteps }) {
  const parts = [`User said: "${transcript}"`];

  // Active execution context
  const snap = context.snapshot();
  if (snap && (snap.file || snap.window || snap.candidates || snap.lastAction)) {
    parts.push('Current execution context:');
    if (snap.file)       parts.push(`  - recent file: ${snap.file.name} at ${snap.file.path}`);
    if (snap.window)     parts.push(`  - focused window: ${snap.window.processName} (${snap.window.kind})`);
    if (snap.candidates) parts.push(`  - pending disambiguation candidates: ${snap.candidates.candidates.length}`);
    if (snap.lastAction) {
      const la = snap.lastAction;
      let pj = '';
      try { pj = JSON.stringify(la.params).slice(0, 120); } catch { /* */ }
      parts.push(`  - last action: ${la.intent} ${pj} ("${(la.transcript || '').slice(0, 80)}")`);
    }
  }

  // Recent turn history (compact)
  if (Array.isArray(history) && history.length > 0) {
    parts.push('Recent turns:');
    for (const h of history.slice(-4)) {
      parts.push(`  - ${h.role}: ${(h.text || '').slice(0, 100)}`);
    }
  }

  // Re-plan failure context
  if (failure && (failure.lastStep || failure.error)) {
    parts.push('PREVIOUS PLAN STEP FAILED. Adjust your plan accordingly.');
    if (failure.lastStep) {
      let pj = '';
      try { pj = JSON.stringify(failure.lastStep.params || {}).slice(0, 200); } catch { /* */ }
      parts.push(`  - failed step: ${failure.lastStep.tool} ${pj}`);
    }
    if (failure.error)   parts.push(`  - error: ${String(failure.error).slice(0, 200)}`);
    if (failure.observed)parts.push(`  - observed: ${String(failure.observed).slice(0, 200)}`);
  }

  parts.push('Return the plan as JSON now.');
  return parts.join('\n');
}

// ─── Plan normalisation / validation ──────────────────────────────────────────

function _normalizePlan(raw, maxSteps) {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'planner output not an object' };
  }
  const goal               = typeof raw.goal === 'string' ? raw.goal.slice(0, 240) : '';
  const expectedFinalSpeak = typeof raw.expectedFinalSpeak === 'string' ? raw.expectedFinalSpeak.slice(0, 280) : '';
  const stepsRaw           = Array.isArray(raw.steps) ? raw.steps : [];

  // Empty plan is allowed — the executor will just speak expectedFinalSpeak.
  if (stepsRaw.length === 0) {
    return {
      ok:                  true,
      goal,
      steps:               [],
      expectedFinalSpeak:  expectedFinalSpeak || (goal ? `OK. ${goal}` : 'OK.'),
    };
  }

  const steps = [];
  for (let i = 0; i < stepsRaw.length && steps.length < maxSteps; i++) {
    const s = stepsRaw[i];
    if (!s || typeof s !== 'object') continue;
    const tool = String(s.tool || '').trim();
    if (!tool || !toolSchemas.isRegistered(tool)) {
      return { ok: false, error: `planner picked unknown tool "${tool}"` };
    }
    const params = (s.params && typeof s.params === 'object') ? { ...s.params } : {};
    steps.push({
      tool,
      params,
      why: typeof s.why === 'string' ? s.why.slice(0, 160) : '',
    });
  }

  if (steps.length === 0) {
    return { ok: false, error: 'planner produced no usable steps' };
  }

  return {
    ok:                  true,
    goal,
    steps,
    expectedFinalSpeak:  expectedFinalSpeak || (goal ? `Done — ${goal}.` : 'Done.'),
  };
}

module.exports = { makePlan };
