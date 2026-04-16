'use strict';

/**
 * dispatcher.js — Routes a ClassifierResult to the appropriate tool call.
 *
 * Does NOT contain tool logic. It validates params and calls the right tool.
 * Throws DispatchError (with a user-readable message) if params are invalid.
 *
 * Tools that require Electron (apps, browser, clipboard) are required lazily
 * so that dispatcher.js itself is partially testable in plain Node for file ops.
 */

const files = require('./tools/files');

// ─── Error type ───────────────────────────────────────────────────────────────

class DispatchError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DispatchError';
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * @param {ClassifierResult} classifierResult
 * @returns {Promise<ToolResult>}
 */
async function dispatch(classifierResult) {
  const { intent, params = {} } = classifierResult;

  switch (intent) {

    // ── File ops (pure Node) ──────────────────────────────────────────────────

    case 'file.create': {
      const name = requireParam(params.name, 'filename');
      return files.createFile({ name, locationHint: params.locationHint });
    }

    case 'file.read': {
      const name = requireParam(params.name, 'filename');
      return files.readFile({ name, locationHint: params.locationHint });
    }

    case 'file.write': {
      const name    = requireParam(params.name, 'filename');
      const content = typeof params.content === 'string' ? params.content : '';
      return files.writeFile({ name, locationHint: params.locationHint, content });
    }

    case 'file.append': {
      const name    = requireParam(params.name, 'filename');
      const content = requireParam(params.content, 'content to append');
      return files.appendFile({ name, locationHint: params.locationHint, content });
    }

    case 'file.list': {
      return files.listDir({ dirHint: params.dirHint || params.locationHint });
    }

    case 'file.mkdir': {
      const name = requireParam(params.name, 'folder name');
      return files.createDir({ name, locationHint: params.locationHint });
    }

    // ── App ops (Electron / PowerShell) ──────────────────────────────────────

    case 'app.open': {
      const appName = requireParam(params.appName, 'app name');
      const { openApp } = require('./tools/apps');
      return openApp(appName);
    }

    case 'app.close': {
      const appName = requireParam(params.appName, 'app name');
      const { closeApp } = require('./tools/windows');
      return closeApp(appName);
    }

    case 'app.focus': {
      const appName = requireParam(params.appName, 'app name');
      const { focusApp } = require('./tools/windows');
      return focusApp(appName);
    }

    // ── Window ops (PowerShell) ───────────────────────────────────────────────

    case 'window.minimize': {
      // appName is optional — null means "active window"
      const { minimizeWindow } = require('./tools/windows');
      return minimizeWindow(params.appName || null);
    }

    case 'window.maximize': {
      // appName is optional — null means "active window"
      const { maximizeWindow } = require('./tools/windows');
      return maximizeWindow(params.appName || null);
    }

    case 'window.switch': {
      const { switchWindow } = require('./tools/windows');
      return switchWindow();
    }

    // ── Browser ops (Electron) ────────────────────────────────────────────────

    case 'browser.open': {
      const { openBrowser } = require('./tools/browser');
      return openBrowser();
    }

    case 'browser.goto': {
      const url = requireParam(params.url, 'URL');
      const { gotoUrl } = require('./tools/browser');
      return gotoUrl(url);
    }

    case 'browser.search': {
      const query = requireParam(params.query, 'search query');
      const { search } = require('./tools/browser');
      return search(query);
    }

    // ── Keyboard / input ops (PowerShell) ────────────────────────────────────

    case 'input.type': {
      const text = requireParam(params.text, 'text to type');
      const { typeText } = require('./tools/keyboard');
      return typeText(text);
    }

    case 'input.key': {
      const key = requireParam(params.key, 'key name');
      const { pressKey } = require('./tools/keyboard');
      return pressKey(key);
    }

    case 'input.shortcut': {
      const combo = requireParam(params.combo, 'shortcut combo');
      const { pressShortcut } = require('./tools/keyboard');
      return pressShortcut(combo);
    }

    // ── Clipboard ops (Electron) ──────────────────────────────────────────────

    case 'clipboard.write': {
      const text = requireParam(params.text, 'text to copy');
      const { writeClipboard } = require('./tools/clipboard');
      return writeClipboard(text);
    }

    // ── Unsupported ───────────────────────────────────────────────────────────

    case 'system.unsupported': {
      return {
        ok:     false,
        error:  classifierResult.reason || "I don't know how to do that yet.",
        action: '',
      };
    }

    default: {
      return {
        ok:     false,
        error:  `Unknown intent: "${intent}"`,
        action: '',
      };
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function requireParam(value, label) {
  if (value === undefined || value === null || value === '') {
    throw new DispatchError(`Missing required parameter: ${label}`);
  }
  return value;
}

module.exports = { dispatch, DispatchError };
