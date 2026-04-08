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

function loadSettings() {
  try {
    const raw = fs.readFileSync(getSettingsPath(), 'utf8');
    return JSON.parse(raw);
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
    geminiModel:         'gemini-3-flash-preview',
    customHotkey:        '',
    startWithOS:         true,
    firstRun:            true,
    // Voice Guide (Phase 1)
    elevenlabsApiKey:    '',
    voiceEnabled:        false,
    voiceHotkey:         '',
    voiceId:             'onwK4e9ZLuTAKqWW03F9', // ElevenLabs "Daniel" — deep, authoritative
    maxVoiceDurationMs:  20000,
    preferredSttLanguage: '',
    // Agent Subsystem
    agentEnabled:        false,
    agentBackend:        'codex', // 'codex' | 'vibe'
    mistralApiKey:       '',
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
  return getSetting('geminiModel', '') || process.env.GEMINI_MODEL || 'gemini-3-flash-preview';
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

module.exports = {
  loadSettings, saveSettings, getSetting,
  isFirstRun, getApiKey, getOpenAIKey, getModel, getElevenLabsKey,
  isAgentEnabled, getAgentBackend, getMistralKey,
};
