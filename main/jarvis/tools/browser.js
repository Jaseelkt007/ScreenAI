'use strict';

/**
 * tools/browser.js — URL launch and navigation tool.
 *
 * Phase 1 scope: open browser, go to URL, search Google.
 * NOT browser automation — no clicking, no page reading, no CDP.
 *
 * Uses shell.openExternal() — opens URLs in the OS default browser.
 * Requires Electron (shell) — Tier B module.
 */

const { shell } = require('electron');

// ─── URL helpers ─────────────────────────────────────────────────────────────

const ALLOWED_SCHEMES = ['http:', 'https:'];

/**
 * Normalise a raw URL from the transcript.
 * Adds https:// if the input is a bare domain (e.g. "youtube.com").
 * Returns null if the result is not a valid http/https URL.
 */
function normaliseUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;

  let url = raw.trim();

  // Add scheme if missing
  if (!/^https?:\/\//i.test(url)) {
    // Looks like a domain (contains a dot, no spaces)
    if (/^[\w.-]+\.[a-z]{2,}(\/.*)?$/i.test(url)) {
      url = 'https://' + url;
    } else {
      return null;
    }
  }

  try {
    const parsed = new URL(url);
    if (!ALLOWED_SCHEMES.includes(parsed.protocol)) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

// ─── Tool functions ───────────────────────────────────────────────────────────

/**
 * Open the system default browser at google.com.
 * Intent: "browser.open" — user said "open a browser" not a specific app.
 * @returns {Promise<ToolResult>}
 */
async function openBrowser() {
  try {
    await shell.openExternal('https://www.google.com');
    return {
      ok: true,
      data: { launched: true, url: 'https://www.google.com' },
      action: 'Opened your default browser.',
    };
  } catch (err) {
    return { ok: false, error: `Could not open browser: ${err.message}`, action: '' };
  }
}

/**
 * Navigate to a specific URL.
 * @param {string} url — URL as spoken (may be bare domain)
 * @returns {Promise<ToolResult>}
 */
async function gotoUrl(url) {
  const normalised = normaliseUrl(url);
  if (!normalised) {
    return {
      ok: false,
      error: `"${url}" is not a valid web address. Only http and https URLs are supported.`,
      action: '',
    };
  }

  try {
    await shell.openExternal(normalised);
    return {
      ok: true,
      data: { launched: true, url: normalised },
      action: `Opened ${normalised}.`,
    };
  } catch (err) {
    return { ok: false, error: `Could not open URL: ${err.message}`, action: '' };
  }
}

/**
 * Search Google for the given query.
 * @param {string} query — raw search terms from transcript
 * @returns {Promise<ToolResult>}
 */
async function search(query) {
  if (!query || !query.trim()) {
    return { ok: false, error: 'No search query provided.', action: '' };
  }

  const encodedQuery = encodeURIComponent(query.trim());
  const searchUrl = `https://www.google.com/search?q=${encodedQuery}`;

  try {
    await shell.openExternal(searchUrl);
    return {
      ok: true,
      data: { launched: true, url: searchUrl },
      action: `Searched Google for "${query.trim()}".`,
    };
  } catch (err) {
    return { ok: false, error: `Could not open search: ${err.message}`, action: '' };
  }
}

module.exports = { openBrowser, gotoUrl, search, normaliseUrl };
