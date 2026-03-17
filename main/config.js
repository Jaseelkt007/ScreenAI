'use strict';

/**
 * config.js
 *
 * Loads runtime configuration from the environment.
 * Supports a .env file in the project root for local development.
 * In packaged builds, set environment variables through the OS or
 * by creating a .env file next to the executable.
 */

const fs = require('fs');
const path = require('path');

// ─── Simple .env loader (no external dependency) ──────────────────────────

function loadEnvFile() {
  // Look for .env next to the project root (development) or executable (production).
  const candidates = [
    path.join(__dirname, '../.env'),             // dev: project root
    path.join(process.execPath, '../.env'),      // prod: next to .exe/.app
    path.join(process.resourcesPath || '', '../.env'), // packaged resources
  ];

  for (const envPath of candidates) {
    if (!fs.existsSync(envPath)) continue;

    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;

      const key   = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');

      // Never overwrite variables already set by the OS environment.
      if (key && !process.env[key]) {
        process.env[key] = value;
      }
    }

    console.log(`[Config] Loaded .env from: ${envPath}`);
    break; // Stop at the first file found.
  }
}

loadEnvFile();

// ─── Exported config object ───────────────────────────────────────────────

const config = {
  /** Gemini API key — required. */
  geminiApiKey: process.env.GEMINI_API_KEY || '',

  /**
   * Gemini model to use.
   * gemini-2.0-flash is fast and multimodal — ideal for screen analysis.
   */
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3-flash-preview',
};

module.exports = config;
