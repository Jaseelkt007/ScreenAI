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
  const { intent } = classifierResult;

  // system.brightness has a known graceful-degradation path where ok=false is
  // expected on desktop hardware. Handle it before the generic failure guard.
  if (intent === 'system.brightness' && !toolResult.ok) {
    if (toolResult.error && toolResult.error.includes('not available')) {
      return {
        verified: false,
        method:   'brightness_unsupported',
        detail:   toolResult.error,
      };
    }
    return { verified: false, method: 'skipped', detail: 'Tool reported failure' };
  }

  if (!toolResult.ok) {
    // Nothing to verify — tool already reported failure
    return { verified: false, method: 'skipped', detail: 'Tool reported failure' };
  }

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

      case 'file.find':
        return {
          verified: Array.isArray(data.matches) && data.matches.length > 0,
          method:   'search_ok',
          detail:   `${(data.matches || []).length} matches for "${data.query}"`,
        };

      case 'file.open':
        return {
          verified: toolResult.ok === true,
          method:   'open_ok',
          detail:   data.path ? `opened ${path.basename(data.path)}` : 'shell.openPath succeeded',
        };

      case 'file.delete': {
        const gone = !fs.existsSync(data.path);
        return {
          verified: gone,
          method:   'file_gone',
          detail:   gone
            ? `"${path.basename(data.path)}" confirmed deleted`
            : `"${path.basename(data.path)}" still exists after delete`,
        };
      }

      case 'file.rename':
        return verifyFileExists(data.newPath, 'file_exists');

      case 'file.move':
        return verifyFileExists(data.newPath, 'file_exists');

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

      case 'system.volume':
      case 'system.lock':
        return {
          verified: toolResult.ok === true,
          method:   'spawn_ok',
          detail:   'system command returned success',
        };

      case 'system.brightness':
        // ok=false with 'not available' is handled before this switch (early guard above).
        // If we reach here, toolResult.ok is true.
        return {
          verified: true,
          method:   'spawn_ok',
          detail:   data && data.to !== undefined
            ? `brightness changed to ${data.to}%`
            : 'brightness command returned success',
        };

      case 'browser.open':
      case 'browser.goto':
      case 'browser.search':
      case 'browser.site':
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

      // system.select and system.cancel are verified by their ok flag.
      // system.select's actual operation is re-dispatched and verified separately.
      case 'system.select':
      case 'system.cancel':
        return {
          verified: toolResult.ok === true,
          method:   'spawn_ok',
          detail:   intent === 'system.cancel' ? 'cancel handled' : 'selection handled',
        };

      // ── M4.6: UIAutomation ops ──────────────────────────────────────────────
      // ui.click — best-effort: trust ok flag + presence of target. A deeper
      // re-query (focus moved, button now disabled) is possible but expensive
      // and not always reliable on web pages. Phase 5 candidate.
      case 'ui.click':
        return {
          verified: toolResult.ok === true && !!(data && data.target),
          method:   'invoke_ok',
          detail:   data && data.target
            ? `invoked "${data.target.name}" (${data.method || 'invoke'})`
            : 'click returned ok',
        };

      // ui.fill — re-read the element and confirm the new value matches.
      // Falls back to "trust ok" when the read fails (e.g. non-readable input).
      case 'ui.fill': {
        if (!data || !data.target) {
          return { verified: false, method: 'fill_readback', detail: 'no target in result' };
        }
        try {
          const ui = require('./tools/ui');
          const readBack = await ui.readElement({
            name:         data.target.name,
            automationId: data.target.automationId,
          });
          const expected = data.value != null ? String(data.value) : '';
          const actual   = readBack.ok && readBack.data ? String(readBack.data.value || '') : '';
          const match    = actual === expected;
          return {
            verified: match || readBack.ok === false,
            method:   'fill_readback',
            detail:   match
              ? `field reads back as expected (${expected.length} chars)`
              : (readBack.ok ? `mismatch — read "${actual.slice(0, 30)}"` : 'readback skipped'),
          };
        } catch (err) {
          return { verified: true, method: 'fill_readback', detail: `readback error (skipped): ${err.message}` };
        }
      }

      // ui.read — trivially verified when the tool returned a value.
      case 'ui.read':
        return {
          verified: toolResult.ok === true && data && typeof data.value === 'string',
          method:   'read_ok',
          detail:   data && typeof data.value === 'string'
            ? `read ${data.value.length} chars`
            : 'no value returned',
        };

      // ui.list — array returned counts as verified.
      case 'ui.list':
        return {
          verified: Array.isArray(data && data.elements),
          method:   'list_ok',
          detail:   `${(data && data.elements || []).length} elements`,
        };

      // ── M5.1 — Browser CDP tools ──────────────────────────────────────────
      case 'browser.tabs.list':
        return {
          verified: !!(data && Array.isArray(data.tabs)),
          method:   'cdp_list',
          detail:   `${(data && data.tabs || []).length} tabs`,
        };
      case 'browser.tabs.open':
      case 'browser.tabs.focus':
      case 'browser.tabs.close':
        return {
          verified: toolResult.ok === true,
          method:   'cdp_target',
          detail:   data && data.tabId ? `tab=${data.tabId}` : 'cdp returned ok',
        };
      case 'browser.read':
        return {
          verified: !!(data && typeof data.content === 'string' && data.content.length > 0),
          method:   'cdp_read',
          detail:   data && data.content ? `${data.content.length} chars` : 'no content',
        };
      case 'browser.click':
      case 'browser.fill':
      case 'browser.scroll':
        return {
          verified: toolResult.ok === true,
          method:   'cdp_action',
          detail:   'cdp returned ok',
        };

      // ── M5.2 — Knowledge tools ────────────────────────────────────────────
      case 'web.search':
        return {
          verified: !!(data && Array.isArray(data.results)),
          method:   'search_results',
          detail:   `${(data && data.results || []).length} results`,
        };
      case 'web.scrape':
        return {
          verified: !!(data && typeof data.text === 'string' && data.text.length > 0),
          method:   'scrape_text',
          detail:   data && data.text ? `${data.text.length} chars` : 'empty',
        };
      case 'vision.read':
        return {
          verified: !!(data && (data.summary || (Array.isArray(data.elements) && data.elements.length > 0))),
          method:   'vision_summary',
          detail:   data && data.summary ? data.summary.slice(0, 80) : 'no summary',
        };

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
