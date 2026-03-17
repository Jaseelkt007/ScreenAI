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
    geminiApiKey: '',
    openaiApiKey: '',
    geminiModel:  'gemini-3-flash-preview',
    customHotkey: '',
    startWithOS:  true,   // Enable startup by default after install
    firstRun:     true,
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

module.exports = { loadSettings, saveSettings, getSetting, isFirstRun, getApiKey, getOpenAIKey, getModel };
