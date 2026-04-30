'use strict';

/**
 * settings.js
 *
 * Persists user settings to a JSON file in the OS user-data directory:
 *   Windows:  %APPDATA%\screen-ai-assistant\settings.json
 *   macOS:    ~/Library/Application Support/screen-ai-assistant/settings.json
 *
 * This is the right place for the API key (NOT the install directory),
 * because each user has their own settings and the install directory
 * may be read-only for non-admin users.
 *
 * Schema:
 * {
 *   geminiApiKey:  string,   // Gemini API key entered by the user
 *   geminiModel:   string,   // Model override
 *   startWithOS:   boolean,  // Launch at login
 *   firstRun:      boolean,  // True until user completes setup
 * }
 */

const { app } = require('electron');
const fs   = require('fs');
const path = require('path');

// Resolve lazily — app.getPath() needs the app module to be initialised.
function getSettingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

// ─── Read ──────────────────────────────────────────────────────────────────

// ElevenLabs voice IDs that should be auto-bumped to the current default.
// Includes the previous male defaults (Daniel, George) and a deprecated
// female ID (Rachel — no longer in the premade roster, returns 404).
const LEGACY_VOICE_IDS = new Set([
  'onwK4e9ZLuTAKqWW03F9', // Daniel — male
  'JBFqnCBsd6RMkjVDRZzb', // George — male
  '21m00Tcm4TlvDq8ikWAM', // Rachel — deprecated, 404s on TTS
]);
// Sarah — female, "Mature, Reassuring, Confident". Verified against the live
// /v1/voices premade list.
const DEFAULT_VOICE_ID = 'EXAVITQu4vr4xnSDxMaL';

function loadSettings() {
  try {
    const raw = fs.readFileSync(getSettingsPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (LEGACY_VOICE_IDS.has(parsed.voiceId)) {
      parsed.voiceId = DEFAULT_VOICE_ID;
    }
    return parsed;
  } catch {
    // File doesn't exist yet (first run) or is corrupt — return defaults.
    return getDefaults();
  }
}

function getSetting(key, fallback) {
  const settings = loadSettings();
  return key in settings ? settings[key] : fallback;
}

function getDefaults() {
  return {
    geminiApiKey:        '',
    openaiApiKey:        '',
    geminiModel:         'gemini-3.1-flash-lite-preview',
    customHotkey:        '',
    startWithOS:         true,
    firstRun:            true,
    // Voice Guide (Phase 1)
    elevenlabsApiKey:    '',
    voiceEnabled:        false,
    voiceHotkey:         '',
    voiceId:             DEFAULT_VOICE_ID, // ElevenLabs "Sarah" — mature, reassuring female
    maxVoiceDurationMs:  20000,
    preferredSttLanguage: '',
    // Agent Subsystem
    agentEnabled:        false,
    agentBackend:        'codex', // 'codex' | 'vibe'
    mistralApiKey:       '',
    // Jarvis pipeline
    jarvisEnabled:       true,
    jarvisHotkey:        '',     // custom override; default is F9 / Shift+Command+J
    jarvisLlmFallback:   true,   // false = pattern-only mode, no API call on miss
    // Jarvis input.type confirmation policy
    // 'always'    — confirm before every typeText call
    // 'long_only' — confirm only when text.length >= 80 (default)
    // 'never'     — never confirm (use with care)
    jarvisInputConfirmMode: 'long_only',
    // Phase 3 — File search
    jarvisFileSearchDepth: 3,         // Get-ChildItem -Depth value for file.find
    // Phase 3 — Destructive operations
    jarvisDestructiveConfirm: 'always', // 'always' | 'never' (never only applies to Jarvis workspace)
    // Phase 4 — Execution context
    jarvisContextTtlMs:    30000,       // ms before context entries expire; 0 = never
    // Phase 4 — Performance
    jarvisPsMode:          'persistent', // 'persistent' | 'spawn'
    jarvisFocusSettleMs:   300,          // ms to wait after app.open before HWND capture
    // Phase 4 — Chains
    jarvisChainMaxSteps:   2,            // max chain steps; lift to 3 for power users
    // Phase 4 — Trace / Debug
    jarvisTraceEnabled:    false,
    jarvisTraceDir:        '',           // '' → ~/Documents/Jarvis/traces
    jarvisTraceMaxFiles:   200,
    // M4.4.1 — controls trace output format when jarvisTraceEnabled is true.
    // 'off'     — never write (overrides jarvisTraceEnabled)
    // 'summary' — single-line minimal JSON per run (id, intent, path, ok, total)
    // 'full'    — full pretty-printed TraceRecord (default)
    jarvisTraceLevel:      'full',
    // M4.5 — Tool-Calling Agent layer (LLM function-calling fallback)
    jarvisAgentEnabled:    true,
    jarvisAgentProvider:   'gemini-2.5-flash',
    jarvisAgentMaxSteps:   3,
    jarvisAgentTimeoutMs:  4000,
    // M4.7 — Streaming pipeline (ack TTS, cancellation, speculative classify)
    jarvisStreamingEnabled: true,
    // Off by default: the ack ("Opening notepad…") immediately followed by the
    // result ("Opened notepad.") felt redundant. Flip to true to bring the
    // pre-warm-the-ears ack back.
    jarvisAckTtsEnabled:    false,
    // ── Phase 5 ──────────────────────────────────────────────────────────────
    // M5.0 — Planner / Executor (replaces the M4.5 3-call agent for misses)
    jarvisPlannerEnabled:   true,
    jarvisPlanMaxSteps:     15,
    jarvisPlanTimeoutMs:    30000,
    jarvisPlanReplanMax:    1,
    // M5.1 — Browser tools (Playwright + CDP attach to user's Chrome)
    jarvisChromeDebugPort:  9222,
    jarvisChromeAutoLaunch: true,
    jarvisChromePath:       '',
    // M5.2 — Knowledge tools
    // jarvisWebSearchProvider: 'tavily' | 'brave'
    //   tavily — 1000 queries/month free, no credit card required (default)
    //   brave  — 2000 queries/month free but requires a card on signup
    jarvisWebSearchProvider: 'tavily',
    jarvisTavilyApiKey:      '',
    jarvisBraveApiKey:       '',
    jarvisApifyToken:        '',
    jarvisApifyActor:        'apify/web-scraper',
    jarvisVisionEnabled:     true,
    jarvisVisionModel:       'gemini-2.5-flash',
    jarvisWebSearchPerMinute: 10,
    jarvisWebScrapePerMinute: 3,
    // M5.3 — Live narration & plan-level cancellation
    jarvisNarrationEnabled:    true,
    jarvisNarrationVolume:     0.6,
    jarvisVoiceCancelEnabled:  true,
    // M5.4 — Result panel HUD
    jarvisResultPanelEnabled:    true,
    jarvisResultPanelTimeoutMs:  30000,
  };
}

// ─── Write ─────────────────────────────────────────────────────────────────

function saveSettings(partial) {
  const current = loadSettings();
  const updated = { ...current, ...partial };

  // Ensure the directory exists (it may not on the very first run).
  const dir = path.dirname(getSettingsPath());
  fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(getSettingsPath(), JSON.stringify(updated, null, 2), 'utf8');
  return updated;
}

// ─── Convenience ───────────────────────────────────────────────────────────

/** True if the user has not yet completed first-run setup. */
function isFirstRun() {
  return getSetting('firstRun', true);
}

/** Get the effective Gemini API key (settings file takes priority over .env). */
function getApiKey() {
  return getSetting('geminiApiKey', '') || process.env.GEMINI_API_KEY || '';
}

/** Get the effective OpenAI API key. */
function getOpenAIKey() {
  return getSetting('openaiApiKey', '') || process.env.OPENAI_API_KEY || '';
}

/** Get the effective model name. */
function getModel() {
  const model = getSetting('geminiModel', '') || process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite-preview';
  return model === 'gemini-2.5-flash-preview-04-17'
    ? 'gemini-3.1-flash-lite-preview'
    : model;
}

/** Get ElevenLabs API key. */
function getElevenLabsKey() {
  return getSetting('elevenlabsApiKey', '') || process.env.ELEVENLABS_API_KEY || '';
}

/** True if the agent subsystem is enabled. */
function isAgentEnabled() {
  return getSetting('agentEnabled', false) === true;
}

/** Get the active agent backend ('codex' | 'vibe'). */
function getAgentBackend() {
  return getSetting('agentBackend', 'codex');
}

/** Get Mistral API key (for Vibe). */
function getMistralKey() {
  return getSetting('mistralApiKey', '') || process.env.MISTRAL_API_KEY || '';
}

/** True if the Jarvis pipeline is enabled. */
function isJarvisEnabled() {
  return getSetting('jarvisEnabled', true) === true;
}

/** True if the classifier may call the LLM when no pattern fires. */
function isJarvisLlmFallbackEnabled() {
  return getSetting('jarvisLlmFallback', true) === true;
}

/** Get the file search recursion depth (1–10). */
function getFileSearchDepth() {
  const d = getSetting('jarvisFileSearchDepth', 3);
  return Math.max(1, Math.min(10, Number(d) || 3));
}

/**
 * Returns true if a confirmation is required before a destructive file op.
 * Files outside the Jarvis workspace always require confirmation, even when
 * jarvisDestructiveConfirm is set to 'never'.
 */
function isDestructiveConfirmRequired(locationHint) {
  if (locationHint && locationHint !== 'jarvis') return true;
  return getSetting('jarvisDestructiveConfirm', 'always') !== 'never';
}

module.exports = {
  loadSettings, saveSettings, getSetting,
  isFirstRun, getApiKey, getOpenAIKey, getModel, getElevenLabsKey,
  isAgentEnabled, getAgentBackend, getMistralKey,
  isJarvisEnabled, isJarvisLlmFallbackEnabled,
  getFileSearchDepth, isDestructiveConfirmRequired,
};
