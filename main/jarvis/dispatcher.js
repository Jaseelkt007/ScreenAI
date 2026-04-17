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

// ─── Destructive-match config ────────────────────────────────────────────────

// Minimum score a findFiles candidate must reach for a destructive op (delete/
// rename/move) to proceed. The scoring system awards +10 for exact token match,
// +5 for substring, +2 for matching extension — so a single solid token match
// hits 10. Requiring ≥ 10 blocks pure-fuzzy guesses while allowing confident ones.
const MIN_DESTRUCTIVE_SCORE = 10;

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

    case 'file.find': {
      const query = params.query || params.extension;
      if (!query) throw new DispatchError('No search query or extension provided for file search.');
      return files.findFiles({
        query:        params.query,
        extension:    params.extension,
        locationHint: params.locationHint,
      });
    }

    case 'file.open': {
      if (params.path) {
        return files.openFile({ path: params.path });
      }
      if (params.name) {
        const findResult = await files.findFiles({
          query:        params.name,
          locationHint: params.locationHint,
        });
        if (!findResult.ok || !findResult.data || findResult.data.matches.length === 0) {
          return { ok: false, error: `Couldn't find a file named "${params.name}".`, action: '' };
        }
        return files.openFile({ path: findResult.data.matches[0].path });
      }
      throw new DispatchError('No filename or path provided for file open.');
    }

    // ── Destructive file ops — find-first pattern ─────────────────────────────
    //
    // These use the same find-first pattern as file.open: call findFiles to
    // get the real absolute path (OneDrive-aware via PS GetFolderPath), then
    // pass that path directly to the tool function. This avoids the LOCATION_MAP
    // static-path bug where ~/Desktop ≠ actual Desktop on OneDrive-backed systems.

    case 'file.delete': {
      const name = requireParam(params.name, 'filename to delete');
      console.log(`[Jarvis] file.delete: spoken="${name}" locationHint="${params.locationHint}"`);

      const findResult = await files.findFiles({ query: name, locationHint: params.locationHint, _includeScores: true });
      console.log(`[Jarvis] file.delete: findFiles ok=${findResult.ok} matches=${findResult.data?.matches?.length ?? 0}`);
      if (findResult.ok && findResult.data?.matches?.length) {
        findResult.data.matches.forEach((m, i) => console.log(`[Jarvis] file.delete:   candidate[${i}] score=${m.score ?? '?'} ${m.path}`));
      }

      const matchResult = strictDestructiveMatch(findResult, name, 'file.delete');
      if (!matchResult.ok) return { ok: false, error: matchResult.error, action: '' };

      const match = matchResult.match;
      console.log(`[Jarvis] file.delete: chosen path=${match.path} (score=${match.score})`);
      return files.deleteFile({ path: match.path });
    }

    case 'file.rename': {
      const name    = requireParam(params.name,    'filename to rename');
      const newName = requireParam(params.newName, 'new filename');
      console.log(`[Jarvis] file.rename: spoken="${name}" newName="${newName}" locationHint="${params.locationHint}"`);

      const findResult = await files.findFiles({ query: name, locationHint: params.locationHint, _includeScores: true });
      console.log(`[Jarvis] file.rename: findFiles ok=${findResult.ok} matches=${findResult.data?.matches?.length ?? 0}`);
      if (findResult.ok && findResult.data?.matches?.length) {
        findResult.data.matches.forEach((m, i) => console.log(`[Jarvis] file.rename:   candidate[${i}] score=${m.score ?? '?'} ${m.path}`));
      }

      const matchResult = strictDestructiveMatch(findResult, name, 'file.rename');
      if (!matchResult.ok) return { ok: false, error: matchResult.error, action: '' };

      const match = matchResult.match;
      console.log(`[Jarvis] file.rename: chosen path=${match.path} (score=${match.score}) → new="${newName}"`);
      return files.renameFile({ path: match.path, newName });
    }

    case 'file.move': {
      const name               = requireParam(params.name,               'filename to move');
      const targetLocationHint = requireParam(params.targetLocationHint, 'destination location');
      // locationHint is intentionally NOT passed for source search. extractLocation() picks
      // up the destination keyword too ("move X to Desktop" → locationHint='desktop'),
      // which would constrain findFiles to the wrong directory.
      console.log(`[Jarvis] file.move: spoken="${name}" → dest="${targetLocationHint}" (source search: all default roots)`);

      const findResult = await files.findFiles({ query: name, locationHint: undefined, _includeScores: true });
      console.log(`[Jarvis] file.move: findFiles ok=${findResult.ok} matches=${findResult.data?.matches?.length ?? 0}`);
      if (findResult.ok && findResult.data?.matches?.length) {
        findResult.data.matches.forEach((m, i) => console.log(`[Jarvis] file.move:   candidate[${i}] score=${m.score ?? '?'} ${m.path}`));
      }

      const matchResult = strictDestructiveMatch(findResult, name, 'file.move');
      if (!matchResult.ok) return { ok: false, error: matchResult.error, action: '' };

      const match = matchResult.match;
      console.log(`[Jarvis] file.move: chosen path=${match.path} (score=${match.score}) → dest="${targetLocationHint}"`);
      return files.moveFile({ path: match.path, targetLocationHint });
    }

    // ── System ops (PowerShell / rundll32) ───────────────────────────────────

    case 'system.volume': {
      const validActions = ['mute', 'unmute', 'up', 'down', 'set'];
      const action = params.action;
      if (!action || !validActions.includes(action)) {
        throw new DispatchError(`Invalid volume action: "${action}". Expected one of: ${validActions.join(', ')}`);
      }
      const volumeParams = { ...params };
      if (action === 'set') {
        const raw = Number(params.level);
        if (isNaN(raw)) throw new DispatchError('Missing or invalid level for volume set.');
        // Clamp 0–100 before dispatching
        volumeParams.level = Math.max(0, Math.min(100, raw));
      }
      const system = require('./tools/system');
      return system.setVolume(volumeParams);
    }

    case 'system.brightness': {
      const action = params.action;
      if (action !== 'up' && action !== 'down') {
        throw new DispatchError(`Invalid brightness action: "${action}". Expected 'up' or 'down'.`);
      }
      const system = require('./tools/system');
      return system.setBrightness(action);
    }

    case 'system.lock': {
      const system = require('./tools/system');
      return system.lockScreen();
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

    case 'browser.site': {
      const siteName = requireParam(params.siteName, 'site name');
      const sites    = require('./tools/sites');
      const url      = sites.resolveSiteUrl(siteName);
      if (!url) {
        return {
          ok:     false,
          error:  `I don't have a shortcut for "${siteName}" yet.`,
          action: '',
        };
      }
      const { shell } = require('electron');
      await shell.openExternal(url);
      return {
        ok:     true,
        data:   { launched: true, url },
        action: `Opened ${siteName}.`,
      };
    }

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

    // Phase 2.3: browser keyboard control. These are guarded because they send
    // shortcuts to the already-focused browser window. Do NOT apply this guard
    // to browser.open/goto/search — those are Phase 1 navigation intents.

    case 'browser.newtab':
      return dispatchBrowserShortcut('ctrl+t');

    case 'browser.closetab':
      return dispatchBrowserShortcut('ctrl+w');

    case 'browser.back':
      return dispatchBrowserShortcut('alt+left');

    case 'browser.refresh':
      return dispatchBrowserShortcut('ctrl+r');

    case 'browser.addressbar':
      return dispatchBrowserShortcut('ctrl+l');

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

/**
 * Validate findFiles result for destructive ops (delete/rename/move).
 *
 * Requires scores via _includeScores:true. Returns { ok, match } on success
 * or { ok: false, error } when the match is missing, too fuzzy, or ambiguous.
 *
 * @param {ToolResult}  findResult  — result from files.findFiles({ _includeScores:true })
 * @param {string}      spokenName  — normalized spoken filename (for error messages)
 * @param {string}      opName      — 'file.delete' | 'file.rename' | 'file.move'
 * @returns {{ ok: true, match: object } | { ok: false, error: string }}
 */
function strictDestructiveMatch(findResult, spokenName, opName) {
  if (!findResult.ok || !findResult.data?.matches?.length) {
    const hint = findResult.error ? ` (${findResult.error})` : ' — check the filename and location.';
    return { ok: false, error: `Couldn't find a file named "${spokenName}"${hint}` };
  }

  const matches  = findResult.data.matches;
  const top      = matches[0];
  const topScore = top.score || 0;

  console.log(`[Jarvis] ${opName}: strictMatch top="${top.name}" score=${topScore} threshold=${MIN_DESTRUCTIVE_SCORE}`);

  if (topScore < MIN_DESTRUCTIVE_SCORE) {
    return {
      ok:    false,
      error: `No confident match for "${spokenName}". Best candidate was "${top.name}" but the match score (${topScore}) is below the required threshold.`,
    };
  }

  const highScorers = matches.filter((m) => (m.score || 0) >= MIN_DESTRUCTIVE_SCORE);
  if (highScorers.length >= 2) {
    const names = highScorers.slice(0, 3).map((m) => `"${m.name}"`).join(', ');
    console.log(`[Jarvis] ${opName}: ambiguous — ${highScorers.length} candidates ≥ ${MIN_DESTRUCTIVE_SCORE}: ${names}`);
    return {
      ok:    false,
      error: `Found multiple files matching "${spokenName}": ${names}. Please be more specific.`,
    };
  }

  return { ok: true, match: top };
}

async function dispatchBrowserShortcut(combo) {
  const { isBrowserFocused, restoreWindowAndCheckBrowser } = require('./tools/windows');
  const { pressShortcut } = require('./tools/keyboard');
  const { consumePendingTypeTargetWindowHandle } = require('./typing-target');

  // The stored window handle was captured before the Jarvis HUD was shown
  // (via rememberTypeTargetWindow in index.js). By dispatch time the HUD
  // has foreground focus, so isBrowserFocused() would incorrectly see the
  // Electron process. When we have the stored handle we restore focus to
  // the user's previous window first, then verify it is a browser.
  const storedHandle = consumePendingTypeTargetWindowHandle();
  console.log(`[Jarvis] browserShortcut: combo=${combo} storedHandle=${storedHandle}`);

  let focusState;
  if (storedHandle) {
    focusState = await restoreWindowAndCheckBrowser(storedHandle);
  } else {
    // No stored handle (e.g. text-command path or non-Windows). Fall back to
    // checking the current foreground window — works correctly when the HUD
    // has not stolen focus.
    focusState = await isBrowserFocused();
  }

  console.log(`[Jarvis] browserShortcut: focusState=${JSON.stringify(focusState)}`);

  if (!focusState || focusState.focused !== true) {
    return {
      ok: false,
      error: 'No browser is focused. Switch to a browser window first.',
      action: '',
    };
  }

  return pressShortcut(combo);
}

module.exports = { dispatch, DispatchError };
