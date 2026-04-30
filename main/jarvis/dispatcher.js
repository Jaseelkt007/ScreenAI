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

const files   = require('./tools/files');
const context = require('./context');

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
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal]   — M4.7 cancellation signal. When aborted,
 *                                        the dispatcher returns a cancellation
 *                                        result instead of running the tool.
 *                                        Tools that support abort (file.find,
 *                                        ui.*) will themselves check the signal.
 * @returns {Promise<ToolResult>}
 */
async function dispatch(classifierResult, opts = {}) {
  const { intent, params = {} } = classifierResult;
  const signal = opts && opts.signal;

  // M4.7 — pre-check: if already aborted before we even start, fast-exit.
  if (signal && signal.aborted) {
    return { ok: false, error: 'cancelled', action: '', cancelled: true };
  }

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
      const findResult = await files.findFiles({
        query:        params.query,
        extension:    params.extension,
        locationHint: params.locationHint,
      });
      // Write file context for the top match (best-scored result), even when multiple exist
      if (findResult.ok && findResult.data?.matches?.length >= 1) {
        const m = findResult.data.matches[0];
        context.setFileTarget(m.name, m.path);
      }
      return findResult;
    }

    case 'file.open': {
      // M4.3: resolve pronoun reference ("open it") from context
      let openParams = params;
      if (params.useContext) {
        const fileTarget = context.getFileTarget();
        if (!fileTarget) {
          return { ok: false, error: 'No recent file in context. Please say the filename explicitly.', action: '' };
        }
        openParams = { ...params, name: fileTarget.name, path: fileTarget.path };
      }
      if (openParams.path) {
        const openResult = await files.openFile({ path: openParams.path });
        if (openResult.ok && openParams.name) context.setFileTarget(openParams.name, openParams.path);
        return openResult;
      }
      if (openParams.name) {
        const findResult = await files.findFiles({
          query:        openParams.name,
          locationHint: openParams.locationHint,
        });
        if (!findResult.ok || !findResult.data || findResult.data.matches.length === 0) {
          return { ok: false, error: `Couldn't find a file named "${openParams.name}".`, action: '' };
        }
        const matches = findResult.data.matches;
        if (matches.length > 1) {
          return buildAmbiguousResult(matches, openParams.name, classifierResult);
        }
        const openResult = await files.openFile({ path: matches[0].path });
        if (openResult.ok) context.setFileTarget(matches[0].name, matches[0].path);
        return openResult;
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
      // M4.3: resolve pronoun reference ("delete it") from context
      if (params.useContext) {
        const fileTarget = context.getFileTarget();
        if (!fileTarget) {
          return { ok: false, error: 'No recent file in context. Please say the filename explicitly.', action: '' };
        }
        return {
          ok:        true,
          _resolved: { ...classifierResult, params: { ...params, path: fileTarget.path, name: fileTarget.name, useContext: false } },
          data:      { resolvedPath: fileTarget.path },
          action:    '',
        };
      }
      // If caller already resolved a path (e.g. from system.select re-dispatch), skip find
      if (params.path) {
        return files.deleteFile({ path: params.path });
      }
      const name = requireParam(params.name, 'filename to delete');
      console.log(`[Jarvis] file.delete: spoken="${name}" locationHint="${params.locationHint}"`);

      const findResult = await files.findFiles({ query: name, locationHint: params.locationHint, _includeScores: true });
      console.log(`[Jarvis] file.delete: findFiles ok=${findResult.ok} matches=${findResult.data?.matches?.length ?? 0}`);
      if (findResult.ok && findResult.data?.matches?.length) {
        findResult.data.matches.forEach((m, i) => console.log(`[Jarvis] file.delete:   candidate[${i}] score=${m.score ?? '?'} ${m.path}`));
      }

      const matchResult = strictDestructiveMatchOrAmbiguous(findResult, name, 'file.delete');
      if (matchResult.ambiguous) return buildAmbiguousResult(matchResult.candidates, name, classifierResult);
      if (!matchResult.ok) return { ok: false, error: matchResult.error, action: '' };

      const match = matchResult.match;
      console.log(`[Jarvis] file.delete: chosen path=${match.path} (score=${match.score}) — deferring to confirm gate`);
      return {
        ok:        true,
        _resolved: { ...classifierResult, params: { ...params, path: match.path, name: match.name } },
        data:      { resolvedPath: match.path },
        action:    '',
      };
    }

    case 'file.rename': {
      // M4.3: resolve pronoun reference ("rename it to X") from context
      if (params.useContext) {
        const fileTarget = context.getFileTarget();
        if (!fileTarget) {
          return { ok: false, error: 'No recent file in context. Please say the filename explicitly.', action: '' };
        }
        const newName = requireParam(params.newName, 'new filename');
        return files.renameFile({ path: fileTarget.path, newName });
      }
      // If caller already resolved a path, skip find
      if (params.path) {
        const newName = requireParam(params.newName, 'new filename');
        return files.renameFile({ path: params.path, newName });
      }
      const name    = requireParam(params.name,    'filename to rename');
      const newName = requireParam(params.newName, 'new filename');
      console.log(`[Jarvis] file.rename: spoken="${name}" newName="${newName}" locationHint="${params.locationHint}"`);

      const findResult = await files.findFiles({ query: name, locationHint: params.locationHint, _includeScores: true });
      console.log(`[Jarvis] file.rename: findFiles ok=${findResult.ok} matches=${findResult.data?.matches?.length ?? 0}`);
      if (findResult.ok && findResult.data?.matches?.length) {
        findResult.data.matches.forEach((m, i) => console.log(`[Jarvis] file.rename:   candidate[${i}] score=${m.score ?? '?'} ${m.path}`));
      }

      const matchResult = strictDestructiveMatchOrAmbiguous(findResult, name, 'file.rename');
      if (matchResult.ambiguous) return buildAmbiguousResult(matchResult.candidates, name, classifierResult);
      if (!matchResult.ok) return { ok: false, error: matchResult.error, action: '' };

      const match = matchResult.match;
      console.log(`[Jarvis] file.rename: chosen path=${match.path} (score=${match.score}) — deferring to confirm gate`);
      return {
        ok:        true,
        _resolved: { ...classifierResult, params: { ...params, path: match.path, name: match.name } },
        data:      { resolvedPath: match.path },
        action:    '',
      };
    }

    case 'file.move': {
      // M4.3: resolve pronoun reference ("move it to Desktop") from context
      if (params.useContext) {
        const fileTarget = context.getFileTarget();
        if (!fileTarget) {
          return { ok: false, error: 'No recent file in context. Please say the filename explicitly.', action: '' };
        }
        const targetLocationHint = requireParam(params.targetLocationHint, 'destination location');
        return {
          ok:        true,
          _resolved: { ...classifierResult, params: { ...params, path: fileTarget.path, name: fileTarget.name, useContext: false } },
          data:      { resolvedPath: fileTarget.path },
          action:    '',
        };
      }
      // If caller already resolved a path, skip find
      if (params.path) {
        const targetLocationHint = requireParam(params.targetLocationHint, 'destination location');
        return files.moveFile({ path: params.path, targetLocationHint });
      }
      const name               = requireParam(params.name,               'filename to move');
      const targetLocationHint = requireParam(params.targetLocationHint, 'destination location');
      console.log(`[Jarvis] file.move: spoken="${name}" → dest="${targetLocationHint}" (source search: all default roots)`);

      const findResult = await files.findFiles({ query: name, locationHint: undefined, _includeScores: true });
      console.log(`[Jarvis] file.move: findFiles ok=${findResult.ok} matches=${findResult.data?.matches?.length ?? 0}`);
      if (findResult.ok && findResult.data?.matches?.length) {
        findResult.data.matches.forEach((m, i) => console.log(`[Jarvis] file.move:   candidate[${i}] score=${m.score ?? '?'} ${m.path}`));
      }

      const matchResult = strictDestructiveMatchOrAmbiguous(findResult, name, 'file.move');
      if (matchResult.ambiguous) return buildAmbiguousResult(matchResult.candidates, name, classifierResult);
      if (!matchResult.ok) return { ok: false, error: matchResult.error, action: '' };

      const match = matchResult.match;
      console.log(`[Jarvis] file.move: chosen path=${match.path} (score=${match.score}) — deferring to confirm gate`);
      return {
        ok:        true,
        _resolved: { ...classifierResult, params: { ...params, path: match.path, name: match.name } },
        data:      { resolvedPath: match.path },
        action:    '',
      };
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
      const openResult = await openApp(appName);
      if (openResult.ok) {
        const { APP_NAMES, BROWSER_PROCESS_NAMES } = require('./tools/app-names');
        const procName = APP_NAMES[appName]?.processName || appName;
        const kind     = BROWSER_PROCESS_NAMES.has(procName.toLowerCase()) ? 'browser' : 'app';
        context.setWindowTarget(procName, openResult.data?.hwnd || null, kind);
      }
      return openResult;
    }

    case 'app.close': {
      const appName = requireParam(params.appName, 'app name');
      const { closeApp } = require('./tools/windows');
      return closeApp(appName);
    }

    case 'app.focus': {
      const appName = requireParam(params.appName, 'app name');
      const { focusApp } = require('./tools/windows');
      const focusResult = await focusApp(appName);
      if (focusResult.ok) {
        const procName = focusResult.data?.processName || appName;
        const { BROWSER_PROCESS_NAMES } = require('./tools/app-names');
        const kind     = BROWSER_PROCESS_NAMES.has(procName.toLowerCase()) ? 'browser' : 'app';
        context.setWindowTarget(procName, focusResult.data?.hwnd || null, kind);
      }
      return focusResult;
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
      // M4.3: browserHint — "go to YouTube in Edge" routes to that browser
      const browserHint = params.browserHint;
      const chainCtx    = classifierResult._chainContext;
      const targetProcess = browserHint
        ? _resolveBrowserHintProcess(browserHint)
        : (chainCtx?.kind === 'browser' ? chainCtx.processName : null);

      if (targetProcess) {
        const { navigateInWindowByProcess } = require('./tools/browser');
        const navResult = await navigateInWindowByProcess(url, targetProcess);
        if (navResult.ok) {
          context.setWindowTarget(targetProcess, chainCtx?.hwnd || null, 'browser');
        }
        return navResult;
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
      // M4.3: browserHint — "go to youtube.com in Edge" routes to that browser
      const browserHintGoto = params.browserHint;
      const chainCtxGoto    = classifierResult._chainContext;
      const targetProcessGoto = browserHintGoto
        ? _resolveBrowserHintProcess(browserHintGoto)
        : (chainCtxGoto?.kind === 'browser' ? chainCtxGoto.processName : null);

      if (targetProcessGoto) {
        const { navigateInWindowByProcess } = require('./tools/browser');
        const navResult = await navigateInWindowByProcess(url, targetProcessGoto);
        if (navResult.ok) {
          context.setWindowTarget(targetProcessGoto, chainCtxGoto?.hwnd || null, 'browser');
        }
        return navResult;
      }
      const { gotoUrl } = require('./tools/browser');
      return gotoUrl(url);
    }

    case 'browser.search': {
      const query  = requireParam(params.query, 'search query');
      const engine = params.engine || 'google';

      // M5.1 — when CDP is enabled, prefer browser-cdp.search (returns parsed
      // results so the planner can chain). Falls back to the Phase 1 path on
      // CDP failure so Tier B tests and pattern paths keep working.
      const settingsMod = require('../settings');
      if (settingsMod.getSetting('jarvisChromeAutoLaunch', true)) {
        try {
          const cdp = require('./tools/browser-cdp');
          const r   = await cdp.search({ query, engine });
          if (r && r.ok) return r;
          // Fall through to legacy on a CDP failure
          console.warn(`[Jarvis] browser.search CDP failed: ${r && r.error}; falling back to shell.openExternal`);
        } catch (err) {
          console.warn(`[Jarvis] browser.search CDP error: ${err.message}; falling back`);
        }
      }

      // Legacy Phase 1 path
      if (classifierResult._chainContext?.kind === 'browser' && classifierResult._chainContext.processName) {
        const encodedQuery = encodeURIComponent(query.trim());
        const searchUrl    = `https://www.google.com/search?q=${encodedQuery}`;
        const { navigateInWindowByProcess } = require('./tools/browser');
        return navigateInWindowByProcess(searchUrl, classifierResult._chainContext.processName);
      }
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

    // ── UI ops (M4.6 — Windows UIAutomation) ──────────────────────────────────

    case 'ui.list': {
      const ui = require('./tools/ui');
      return ui.listElements({
        scope: params.scope || 'focused',
        role:  params.role,
      });
    }

    case 'ui.click': {
      if (!params.name && !params.automationId) {
        throw new DispatchError('No element name or automationId provided.');
      }
      const ui = require('./tools/ui');
      const r = await ui.clickElement({
        scope:        params.scope || 'focused',
        name:         params.name,
        automationId: params.automationId,
        role:         params.role,
      });
      _maybeStoreUiCandidates(r, classifierResult);
      return r;
    }

    case 'ui.fill': {
      if (!params.name && !params.automationId) {
        throw new DispatchError('No field name or automationId provided.');
      }
      if (typeof params.value !== 'string') {
        throw new DispatchError('No value to fill.');
      }
      const ui = require('./tools/ui');
      const r = await ui.fillElement({
        scope:        params.scope || 'focused',
        name:         params.name,
        automationId: params.automationId,
        value:        params.value,
      });
      _maybeStoreUiCandidates(r, classifierResult);
      return r;
    }

    case 'ui.read': {
      if (!params.name && !params.automationId) {
        throw new DispatchError('No element name or automationId provided.');
      }
      const ui = require('./tools/ui');
      const r = await ui.readElement({
        scope:        params.scope || 'focused',
        name:         params.name,
        automationId: params.automationId,
      });
      _maybeStoreUiCandidates(r, classifierResult);
      return r;
    }

    // ── M5.1 — Browser CDP tools (Playwright-style, attached to user's Chrome) ─

    case 'browser.tabs.list': {
      const cdp = require('./tools/browser-cdp');
      return cdp.listTabs();
    }

    case 'browser.tabs.open': {
      const url = requireParam(params.url, 'URL');
      const cdp = require('./tools/browser-cdp');
      return cdp.openTab({ url, focus: params.focus !== false });
    }

    case 'browser.tabs.close': {
      const cdp = require('./tools/browser-cdp');
      return cdp.closeTab({ tabId: params.tabId });
    }

    case 'browser.tabs.focus': {
      const tabId = requireParam(params.tabId, 'tabId');
      const cdp = require('./tools/browser-cdp');
      return cdp.focusTab({ tabId });
    }

    case 'browser.read': {
      const cdp = require('./tools/browser-cdp');
      return cdp.readPage({
        tabId:    params.tabId,
        mode:     params.mode || 'main',
        selector: params.selector,
        max:      params.max,
      });
    }

    case 'browser.click': {
      if (!params.selector && !params.text) {
        throw new DispatchError('Provide selector or text for browser.click.');
      }
      const cdp = require('./tools/browser-cdp');
      return cdp.click({ tabId: params.tabId, selector: params.selector, text: params.text });
    }

    case 'browser.fill': {
      if (typeof params.value !== 'string') {
        throw new DispatchError('No value to fill.');
      }
      if (!params.selector && !params.label) {
        throw new DispatchError('Provide selector or label for browser.fill.');
      }
      const cdp = require('./tools/browser-cdp');
      return cdp.fill({ tabId: params.tabId, selector: params.selector, label: params.label, value: params.value });
    }

    case 'browser.scroll': {
      const direction = params.direction || 'down';
      const cdp = require('./tools/browser-cdp');
      return cdp.scroll({ tabId: params.tabId, direction, amount: params.amount });
    }

    // ── M5.2 — Knowledge tools ────────────────────────────────────────────────

    case 'web.search': {
      const query = requireParam(params.query, 'search query');
      const ws = require('./tools/web-search');
      return ws.search({ query, count: params.count });
    }

    case 'web.scrape': {
      const url = requireParam(params.url, 'url to scrape');
      const wsc = require('./tools/web-scrape');
      return wsc.scrape({ url, instructions: params.instructions });
    }

    case 'vision.read': {
      const v = require('./tools/vision');
      return v.read({ scope: params.scope || 'focused', question: params.question });
    }

    // ── Disambiguation intents (M4.1) ─────────────────────────────────────────

    case 'system.select': {
      const state = context.getCandidates();
      // M5.4 — when no disambiguation is pending, fall back to the active
      // result panel ("open the second one" after a search).
      if (!state) {
        const active = context.getActiveResultSet ? context.getActiveResultSet() : null;
        if (active && Array.isArray(active.cards) && active.cards.length) {
          const ord = Number(params.ordinal);
          if (!ord || ord < 1 || ord > active.cards.length) {
            return {
              ok:    false,
              error: `Only ${active.cards.length} result${active.cards.length !== 1 ? 's' : ''}. Say a number from 1 to ${active.cards.length}.`,
              action:'',
            };
          }
          const card = active.cards[ord - 1];
          // Pick a re-dispatch shape based on the panel kind.
          if (active.kind === 'web' && card.url) {
            const resolved = {
              intent: 'browser.tabs.open',
              params: { url: card.url, focus: true },
              raw:    classifierResult.raw || '',
              confidence:   'pattern',
              needsConfirm: false,
            };
            context.clearActiveResultSet();
            return { ok: true, _resolved: resolved, data: { selected: card }, action: `Opening "${card.title || card.url}".` };
          }
          if (active.kind === 'tabs' && card.tabId) {
            const resolved = {
              intent: 'browser.tabs.focus',
              params: { tabId: card.tabId },
              raw:    classifierResult.raw || '',
              confidence:   'pattern',
              needsConfirm: false,
            };
            context.clearActiveResultSet();
            return { ok: true, _resolved: resolved, data: { selected: card }, action: `Focusing "${card.title}".` };
          }
          if (active.kind === 'files' && card.path) {
            const resolved = {
              intent: 'file.open',
              params: { path: card.path, name: card.title },
              raw:    classifierResult.raw || '',
              confidence:   'pattern',
              needsConfirm: false,
            };
            context.clearActiveResultSet();
            return { ok: true, _resolved: resolved, data: { selected: card }, action: `Opening "${card.title}".` };
          }
        }
        return { ok: false, error: 'No pending selection. Please repeat your original command.', action: '' };
      }
      const { ordinal } = params;
      if (!ordinal || ordinal < 1 || ordinal > state.candidates.length) {
        return {
          ok:     false,
          error:  `Only ${state.candidates.length} option${state.candidates.length !== 1 ? 's' : ''}. Say a number from 1 to ${state.candidates.length}.`,
          action: '',
        };
      }
      const selected = state.candidates[ordinal - 1];
      context.clearCandidates();
      // Build a resolved classifierResult with the confirmed selector injected.
      // For file ops we inject path+name; for ui.* ops we also inject
      // automationId when the candidate carried one (M4.6 follow-up).
      const resolvedParams = {
        ...state.classifiedResult.params,
        path: selected.path,
        name: selected.name,
      };
      if (selected.automationId) resolvedParams.automationId = selected.automationId;
      const resolved = {
        ...state.classifiedResult,
        params: resolvedParams,
      };
      return {
        ok:               true,
        _resolved:        resolved,
        data:             { selectedCandidate: selected },
        action:           `Selected "${selected.name}".`,
      };
    }

    case 'system.cancel': {
      const hadCandidates = !!context.getCandidates();
      context.clearCandidates();
      return {
        ok:     true,
        action: hadCandidates ? 'Cancelled. Selection cleared.' : 'OK, cancelled.',
        data:   { cancelled: true },
      };
    }

    // ── M4.8 — Conversational continuation ────────────────────────────────────

    case 'system.repeat': {
      const last = context.getLastAction();
      if (!last) {
        return { ok: false, error: 'Nothing to repeat yet.', action: '' };
      }
      // Belt-and-suspenders: caller already filters meta intents from
      // setLastAction, but guard here in case anything slipped through.
      if (META_INTENTS.has(last.intent)) {
        return { ok: false, error: "I can't repeat that.", action: '' };
      }
      const resolved = {
        intent:       last.intent,
        params:       { ...last.params },
        raw:          last.transcript || '',
        confidence:   'pattern',
        needsConfirm: !!last.needsConfirm,
      };
      return {
        ok:        true,
        _resolved: resolved,
        data:      { repeated: last.intent },
        action:    `Repeating ${last.intent}.`,
      };
    }

    case 'system.undo': {
      const last = context.getLastAction();
      if (!last) {
        return { ok: false, error: 'Nothing to undo.', action: '' };
      }
      const inverse = _buildUndoFor(last);
      if (!inverse) {
        return {
          ok:     false,
          error:  `I don't know how to undo "${last.intent}" yet.`,
          action: '',
        };
      }
      return {
        ok:        true,
        _resolved: inverse,
        data:      { undid: last.intent },
        action:    `Undoing ${last.intent}.`,
      };
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
 * Requires scores via _includeScores:true.
 * Returns:
 *   { ok: true, match }               — single confident match; proceed
 *   { ok: false, error }              — no match or confidence too low
 *   { ok: false, ambiguous, candidates } — multiple confident matches; caller should disambiguate
 *
 * @param {ToolResult}  findResult  — result from files.findFiles({ _includeScores:true })
 * @param {string}      spokenName  — normalized spoken filename (for error messages)
 * @param {string}      opName      — 'file.delete' | 'file.rename' | 'file.move'
 */
function strictDestructiveMatchOrAmbiguous(findResult, spokenName, opName) {
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
    return { ok: false, ambiguous: true, candidates: highScorers.slice(0, 5) };
  }

  return { ok: true, match: top };
}

/**
 * Build the ambiguous ToolResult returned to the pipeline when a destructive op
 * finds multiple candidates. Also calls context.setCandidates so system.select
 * can resolve the pending choice.
 */
function buildAmbiguousResult(candidates, spokenName, classifiedResult) {
  context.setCandidates(candidates, classifiedResult);
  const list = candidates.slice(0, 5).map((m, i) => `${i + 1}. ${m.name}`).join(', ');
  return {
    ok:         false,
    ambiguous:  true,
    candidates: candidates.slice(0, 5),
    action:     `I found ${candidates.length} files matching "${spokenName}". Say one, two, or three: ${list}`,
  };
}

/**
 * M4.3: Map a browser hint string to a process name for navigateInWindowByProcess.
 */
function _resolveBrowserHintProcess(hint) {
  const MAP = {
    'edge':    'msedge',
    'chrome':  'chrome',
    'firefox': 'firefox',
    'brave':   'brave',
  };
  return MAP[hint] || null;
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

// ─── M4.6 follow-up: surface ui.* ambiguous candidates to context ───────────
// Without this, system.select ("the second one") can't resolve a UI ambiguity
// because the candidate list never reaches context.getCandidates().
function _maybeStoreUiCandidates(toolResult, classifierResult) {
  if (!toolResult || !toolResult.ambiguous || !Array.isArray(toolResult.candidates)) return;
  // Map UI candidates into the same {name, path, sizeBytes} shape file ops use,
  // so the existing system.select re-dispatch path works uniformly.
  const candidates = toolResult.candidates.map((c) => ({
    name:         c.name || c.automationId || 'unnamed',
    path:         c.automationId || c.name || '',   // re-dispatch uses this as automationId
    sizeBytes:    0,
    automationId: c.automationId,
    role:         c.role,
  }));
  context.setCandidates(candidates, classifierResult);
}

// ─── M4.8: meta intents (never recorded as lastAction; never repeatable) ─────

const META_INTENTS = new Set([
  'system.repeat', 'system.undo',
  'system.cancel', 'system.select',
  'system.unsupported',
]);

/**
 * Derive a ClassifierResult that undoes the given lastAction, or null if no
 * known inverse. Conservative on purpose — better to refuse than to undo the
 * wrong thing.
 *
 * Supported today:
 *   - input.type      → input.shortcut ctrl+z
 *   - input.shortcut  → input.shortcut ctrl+z (skips ctrl+z itself)
 *   - app.close       → app.open <appName>
 *
 * Deferred to Phase 5:
 *   - file.delete (recycle bin restore)
 *   - file.rename / file.move (reverse the operation)
 *   - clipboard.write (no prior clipboard captured)
 */
function _buildUndoFor(lastAction) {
  if (!lastAction || !lastAction.intent) return null;
  const { intent, params } = lastAction;

  if (intent === 'input.type') {
    return {
      intent:       'input.shortcut',
      params:       { combo: 'ctrl+z' },
      raw:          lastAction.transcript || '',
      confidence:   'pattern',
      needsConfirm: false,
    };
  }
  if (intent === 'input.shortcut') {
    if (params && params.combo === 'ctrl+z') return null;       // don't undo an undo
    return {
      intent:       'input.shortcut',
      params:       { combo: 'ctrl+z' },
      raw:          lastAction.transcript || '',
      confidence:   'pattern',
      needsConfirm: false,
    };
  }
  if (intent === 'app.close' && params && params.appName) {
    return {
      intent:       'app.open',
      params:       { appName: params.appName },
      raw:          lastAction.transcript || '',
      confidence:   'pattern',
      needsConfirm: false,
    };
  }
  return null;
}

module.exports = { dispatch, DispatchError, META_INTENTS };
