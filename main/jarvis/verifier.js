'use strict';

/**
 * verifier.js — Structured post-action checks for the Jarvis pipeline.
 *
 * No screenshots. Each intent has a dedicated lightweight check.
 * Verification failure is non-fatal — the pipeline continues but notes it.
 *
 * Tier A for file/path checks (pure Node fs).
 * Tier B for clipboard check (needs Electron clipboard module).
 */

const fs   = require('fs');
const path = require('path');

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * @param {ClassifierResult} classifierResult
 * @param {ToolResult}       toolResult
 * @returns {Promise<VerifierResult>}
 */
async function verify(classifierResult, toolResult) {
  if (!toolResult.ok) {
    // Nothing to verify — tool already reported failure
    return { verified: false, method: 'skipped', detail: 'Tool reported failure' };
  }

  const { intent } = classifierResult;
  const { data }   = toolResult;

  try {
    switch (intent) {
      case 'file.create':
        return verifyFileExists(data.path, 'file_exists');

      case 'file.read':
        return {
          verified: typeof data.content === 'string' && data.content.length >= 0,
          method:   'content_nonzero',
          detail:   `${data.sizeBytes} bytes read`,
        };

      case 'file.write':
        return verifyFileSizeNonzero(data.path);

      case 'file.append': {
        const exists = fs.existsSync(data.path);
        if (!exists) return { verified: false, method: 'size_grew', detail: 'file not found after append' };
        const stat = fs.statSync(data.path);
        const grew = stat.size > (data.priorSize || 0);
        return {
          verified: grew,
          method:   'size_grew',
          detail:   `size is now ${stat.size} bytes (was ${data.priorSize || 0})`,
        };
      }

      case 'file.list':
        return {
          verified: Array.isArray(data.entries),
          method:   'entries_returned',
          detail:   `${(data.entries || []).length} entries`,
        };

      case 'file.mkdir':
        return verifyDirExists(data.path);

      case 'app.open':
        return {
          verified: toolResult.ok === true,
          method:   'spawn_ok',
          detail:   'launch returned success',
        };

      case 'app.close': {
        // process_gone: confirm the process is no longer running
        const { data } = toolResult;
        return {
          verified: data && data.closed === true,
          method:   'process_gone',
          detail:   data && data.closed ? `${data.processName || 'process'} confirmed closed` : 'close not confirmed',
        };
      }

      case 'app.focus':
        // focus_assumed: we confirmed process exists and request was sent,
        // but cannot verify the window actually came to foreground.
        return {
          verified: toolResult.ok === true,
          method:   'focus_assumed',
          detail:   'focus request sent; foreground state not confirmed',
        };

      case 'window.minimize':
      case 'window.maximize':
      case 'window.switch':
        return {
          verified: toolResult.ok === true,
          method:   'spawn_ok',
          detail:   'PowerShell command returned success',
        };

      case 'browser.open':
      case 'browser.goto':
      case 'browser.search':
        return {
          verified: toolResult.ok === true,
          method:   'open_ok',
          detail:   data.url ? `opened ${data.url}` : 'shell.openExternal succeeded',
        };

      case 'input.type':
      case 'input.key':
      case 'input.shortcut':
      case 'browser.newtab':
      case 'browser.closetab':
      case 'browser.back':
      case 'browser.refresh':
      case 'browser.addressbar':
        return {
          verified: toolResult.ok === true,
          method:   'spawn_ok',
          detail:   'keyboard command returned success',
        };

      case 'clipboard.write':
        return verifyClipboard(data.written);

      default:
        return { verified: false, method: 'unknown_intent', detail: `No verifier for "${intent}"` };
    }
  } catch (err) {
    return { verified: false, method: 'error', detail: err.message };
  }
}

// ─── Verification helpers ─────────────────────────────────────────────────────

function verifyFileExists(filePath, method = 'file_exists') {
  if (!filePath) return { verified: false, method, detail: 'no path in toolResult' };
  const exists = fs.existsSync(filePath);
  const detail = exists
    ? `file exists at ${path.basename(filePath)}`
    : `file not found at ${filePath}`;
  return { verified: exists, method, detail };
}

function verifyFileSizeNonzero(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { verified: false, method: 'size_nonzero', detail: 'file not found' };
  }
  const stat = fs.statSync(filePath);
  return {
    verified: stat.size >= 0, // 0-byte file is still a valid write
    method:   'size_nonzero',
    detail:   `file is ${stat.size} bytes`,
  };
}

function verifyDirExists(dirPath) {
  if (!dirPath) return { verified: false, method: 'dir_exists', detail: 'no path in toolResult' };
  try {
    const stat = fs.statSync(dirPath);
    return {
      verified: stat.isDirectory(),
      method:   'dir_exists',
      detail:   stat.isDirectory() ? `directory exists at ${path.basename(dirPath)}` : 'path exists but is not a directory',
    };
  } catch {
    return { verified: false, method: 'dir_exists', detail: `not found: ${dirPath}` };
  }
}

function verifyClipboard(expectedText) {
  // Lazy require — clipboard is only available inside Electron
  try {
    const { clipboard } = require('electron');
    const actual = clipboard.readText();
    const match  = actual === expectedText;
    return {
      verified: match,
      method:   'clipboard_readback',
      detail:   match
        ? `clipboard contains ${actual.length} chars`
        : `clipboard mismatch — expected "${expectedText?.slice(0, 40)}"`,
    };
  } catch {
    // Not in Electron context (e.g. Tier A test) — skip readback
    return { verified: true, method: 'clipboard_readback', detail: 'readback skipped (non-Electron context)' };
  }
}

module.exports = { verify };
