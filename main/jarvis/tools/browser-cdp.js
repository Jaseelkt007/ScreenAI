'use strict';

/**
 * tools/browser-cdp.js — M5.1 browser automation over CDP.
 *
 * Attaches to the user's Chrome (launched with --remote-debugging-port=9222
 * via tools/chrome-debug-launcher.js) and exposes per-tab control:
 *
 *   listTabs()             — every page-target as { tabId, title, url, active }
 *   openTab({ url, focus }) — create a new tab via Target.createTarget
 *   closeTab({ tabId })    — Target.closeTarget; defaults to active tab
 *   focusTab({ tabId })    — Target.activateTarget
 *   navigate({ tabId, url })
 *   readPage({ tabId, mode, selector, max })
 *   click({ tabId, selector?, text? })
 *   fill ({ tabId, selector?, label?, value })
 *   scroll({ tabId, direction, amount })
 *   search({ tabId, query, engine })
 *
 * Uses chrome-remote-interface. All calls return ToolResult shape.
 *
 * The CDP client is reused across calls (one per tab; lazily attached). On
 * connection loss we throw chrome out and rebuild on the next call.
 */

const launcher = require('./chrome-debug-launcher');

let _cri = null; // { CDP, port, version, lastUsed }
let _clientCache = new Map(); // targetId -> connected client (Page domain enabled)

// ─── Connection helpers ───────────────────────────────────────────────────────

async function _ensureCDP() {
  if (_cri && _cri.CDP) return _cri;
  let CDP;
  try {
    CDP = require('chrome-remote-interface');
  } catch (err) {
    throw new Error('chrome-remote-interface not installed. Run: npm install chrome-remote-interface');
  }

  const status = await launcher.ensureChromeDebug();
  if (!status.ok) {
    throw new Error(status.error || 'Chrome debug port unreachable');
  }
  _cri = { CDP, port: status.port, version: status.version, lastUsed: Date.now() };
  return _cri;
}

async function _listTargets() {
  const { CDP, port } = await _ensureCDP();
  return CDP.List({ port });
}

async function _resolveTabId(tabId) {
  const targets = await _listTargets();
  const pages   = targets.filter((t) => t.type === 'page');
  if (tabId) return pages.find((t) => t.id === tabId) || null;
  // Active tab heuristic: chrome-remote-interface does not directly expose
  // "the focused tab", so we look for the most-recently-activated page. CDP
  // does report `attached` and tab order roughly. As a reasonable default we
  // pick the first page-target.
  return pages[0] || null;
}

async function _openClient(targetId) {
  if (_clientCache.has(targetId)) return _clientCache.get(targetId);
  const { CDP, port } = await _ensureCDP();
  const client = await CDP({ port, target: targetId });
  await client.Page.enable();
  await client.Runtime.enable();
  await client.DOM.enable();
  client.on('disconnect', () => { _clientCache.delete(targetId); });
  _clientCache.set(targetId, client);
  return client;
}

async function _evalJSON(client, expression, opts = {}) {
  const { result } = await client.Runtime.evaluate({
    expression,
    returnByValue: true,
    awaitPromise:  opts.awaitPromise === true,
    timeout:       opts.timeout || 5000,
  });
  if (result.subtype === 'error') {
    throw new Error(result.description || 'JS eval error');
  }
  return result.value;
}

// ─── Tool functions ───────────────────────────────────────────────────────────

async function listTabs() {
  try {
    const targets = await _listTargets();
    const tabs = targets.filter((t) => t.type === 'page').map((t, idx) => ({
      tabId:  t.id,
      title:  t.title || '',
      url:    t.url   || '',
      active: idx === 0,
    }));
    return {
      ok:     true,
      data:   { tabs },
      action: `${tabs.length} tab${tabs.length === 1 ? '' : 's'} open.`,
    };
  } catch (err) {
    return { ok: false, error: `Could not list tabs: ${err.message}`, action: '' };
  }
}

async function openTab({ url, focus = true } = {}) {
  if (!url) return { ok: false, error: 'No URL provided.', action: '' };
  const safeUrl = _normaliseUrl(url);
  if (!safeUrl) return { ok: false, error: `Invalid URL: ${url}`, action: '' };

  try {
    const { CDP, port } = await _ensureCDP();
    // CDP.New is a top-level helper that POSTs /json/new?<url>
    const target = await CDP.New({ port, url: safeUrl });
    if (focus) {
      try { await CDP.Activate({ port, id: target.id }); } catch { /* */ }
    }
    return {
      ok:     true,
      data:   { tabId: target.id, url: target.url || safeUrl, title: target.title || '' },
      action: `Opened ${safeUrl}.`,
    };
  } catch (err) {
    return { ok: false, error: `Could not open tab: ${err.message}`, action: '' };
  }
}

async function closeTab({ tabId } = {}) {
  try {
    const target = await _resolveTabId(tabId);
    if (!target) return { ok: false, error: 'No tab to close.', action: '' };
    const { CDP, port } = await _ensureCDP();
    await CDP.Close({ port, id: target.id });
    if (_clientCache.has(target.id)) { try { await _clientCache.get(target.id).close(); } catch { /* */ } _clientCache.delete(target.id); }
    return { ok: true, data: { tabId: target.id }, action: 'Closed tab.' };
  } catch (err) {
    return { ok: false, error: `Could not close tab: ${err.message}`, action: '' };
  }
}

async function focusTab({ tabId } = {}) {
  if (!tabId) return { ok: false, error: 'No tabId provided.', action: '' };
  try {
    const { CDP, port } = await _ensureCDP();
    await CDP.Activate({ port, id: tabId });
    return { ok: true, data: { tabId }, action: 'Tab focused.' };
  } catch (err) {
    return { ok: false, error: `Could not focus tab: ${err.message}`, action: '' };
  }
}

async function navigate({ tabId, url } = {}) {
  if (!url) return { ok: false, error: 'No URL provided.', action: '' };
  const safeUrl = _normaliseUrl(url);
  if (!safeUrl) return { ok: false, error: `Invalid URL: ${url}`, action: '' };

  try {
    const target = await _resolveTabId(tabId);
    if (!target) {
      // Fallback: open as new tab
      return await openTab({ url: safeUrl, focus: true });
    }
    const client = await _openClient(target.id);
    await client.Page.navigate({ url: safeUrl });
    await _waitForLoad(client);
    return { ok: true, data: { tabId: target.id, url: safeUrl }, action: `Loaded ${safeUrl}.` };
  } catch (err) {
    return { ok: false, error: `Navigation failed: ${err.message}`, action: '' };
  }
}

async function readPage({ tabId, mode = 'main', selector, max = 4000 } = {}) {
  try {
    const target = await _resolveTabId(tabId);
    if (!target) return { ok: false, error: 'No tab to read.', action: '' };
    const client = await _openClient(target.id);

    let expr;
    if (mode === 'html' && selector) {
      expr = `((sel) => { const el = document.querySelector(sel); return el ? el.outerHTML : ''; })(${JSON.stringify(selector)})`;
    } else if (mode === 'text' && selector) {
      expr = `((sel) => { const el = document.querySelector(sel); return el ? (el.innerText || el.textContent || '') : ''; })(${JSON.stringify(selector)})`;
    } else {
      // 'main' — try a few common readability heuristics
      expr = `(() => {
        const candidates = ['article', 'main', '[role=main]', '#content', '.content', 'body'];
        for (const sel of candidates) {
          const el = document.querySelector(sel);
          if (el && (el.innerText || '').length > 120) return el.innerText;
        }
        return document.body ? (document.body.innerText || '') : '';
      })()`;
    }

    const raw = await _evalJSON(client, expr);
    const text = String(raw || '').slice(0, Math.max(200, Number(max) || 4000));
    const url   = target.url   || '';
    const title = target.title || '';
    return {
      ok:     true,
      data:   { tabId: target.id, url, title, content: text, length: text.length },
      action: `Read ${text.length} chars from "${title || url}".`,
    };
  } catch (err) {
    return { ok: false, error: `Read failed: ${err.message}`, action: '' };
  }
}

async function click({ tabId, selector, text } = {}) {
  if (!selector && !text) return { ok: false, error: 'Provide selector or text.', action: '' };
  try {
    const target = await _resolveTabId(tabId);
    if (!target) return { ok: false, error: 'No tab to click in.', action: '' };
    const client = await _openClient(target.id);

    // Build a JS expression that clicks a matching element. selector wins.
    const expr = selector
      ? `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return { ok: false, error: 'no_match' };
          el.scrollIntoView({ block: 'center' });
          el.click();
          return { ok: true, tag: el.tagName.toLowerCase() };
        })()`
      : `(() => {
          const want = ${JSON.stringify(String(text))}.toLowerCase().trim();
          const all  = Array.from(document.querySelectorAll('button, a, [role=button], input[type=submit], [onclick]'));
          // First exact-text match
          let hit = all.find((e) => (e.innerText || e.value || '').toLowerCase().trim() === want);
          if (!hit) hit = all.find((e) => (e.innerText || e.value || '').toLowerCase().includes(want));
          if (!hit) return { ok: false, error: 'no_match' };
          hit.scrollIntoView({ block: 'center' });
          hit.click();
          return { ok: true, tag: hit.tagName.toLowerCase(), text: (hit.innerText || hit.value || '').slice(0, 60) };
        })()`;
    const r = await _evalJSON(client, expr);
    if (!r || !r.ok) {
      return { ok: false, error: `No element matched ${selector ? 'selector' : 'text'} "${selector || text}"`, action: '' };
    }
    return { ok: true, data: { tabId: target.id, ...r }, action: `Clicked ${r.text || r.tag}.` };
  } catch (err) {
    return { ok: false, error: `Click failed: ${err.message}`, action: '' };
  }
}

async function fill({ tabId, selector, label, value } = {}) {
  if (typeof value !== 'string') return { ok: false, error: 'No value to fill.', action: '' };
  if (!selector && !label) return { ok: false, error: 'Provide selector or label.', action: '' };
  try {
    const target = await _resolveTabId(tabId);
    if (!target) return { ok: false, error: 'No tab to fill in.', action: '' };
    const client = await _openClient(target.id);

    const expr = selector
      ? `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return { ok: false, error: 'no_match' };
          el.focus();
          if ('value' in el) {
            el.value = ${JSON.stringify(value)};
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          } else if (el.isContentEditable) {
            el.textContent = ${JSON.stringify(value)};
            el.dispatchEvent(new Event('input', { bubbles: true }));
          } else {
            return { ok: false, error: 'not_fillable' };
          }
          return { ok: true, tag: el.tagName.toLowerCase() };
        })()`
      : `(() => {
          const want = ${JSON.stringify(String(label))}.toLowerCase().trim();
          let target = null;
          for (const lab of document.querySelectorAll('label')) {
            if ((lab.innerText || '').toLowerCase().trim().includes(want)) {
              const id = lab.getAttribute('for');
              if (id) target = document.getElementById(id);
              if (!target) target = lab.querySelector('input,textarea,select,[contenteditable]');
              if (target) break;
            }
          }
          if (!target) {
            target = Array.from(document.querySelectorAll('input,textarea')).find((e) => {
              const ph = (e.placeholder || '').toLowerCase();
              const al = (e.getAttribute('aria-label') || '').toLowerCase();
              return ph.includes(want) || al.includes(want);
            });
          }
          if (!target) return { ok: false, error: 'no_match' };
          target.focus();
          if ('value' in target) {
            target.value = ${JSON.stringify(value)};
            target.dispatchEvent(new Event('input', { bubbles: true }));
            target.dispatchEvent(new Event('change', { bubbles: true }));
          } else {
            target.textContent = ${JSON.stringify(value)};
            target.dispatchEvent(new Event('input', { bubbles: true }));
          }
          return { ok: true, tag: target.tagName.toLowerCase() };
        })()`;
    const r = await _evalJSON(client, expr);
    if (!r || !r.ok) {
      return { ok: false, error: `Could not fill: ${r && r.error || 'no_match'}`, action: '' };
    }
    return { ok: true, data: { tabId: target.id, value, ...r }, action: 'Filled.' };
  } catch (err) {
    return { ok: false, error: `Fill failed: ${err.message}`, action: '' };
  }
}

async function scroll({ tabId, direction = 'down', amount = 600 } = {}) {
  try {
    const target = await _resolveTabId(tabId);
    if (!target) return { ok: false, error: 'No tab to scroll in.', action: '' };
    const client = await _openClient(target.id);
    let expr;
    if (direction === 'top')         expr = 'window.scrollTo({top: 0});';
    else if (direction === 'bottom') expr = 'window.scrollTo({top: document.body.scrollHeight});';
    else if (direction === 'up')     expr = `window.scrollBy({top: -${Number(amount) || 600}});`;
    else                             expr = `window.scrollBy({top: ${Number(amount) || 600}});`;
    await _evalJSON(client, `(() => { ${expr} return true; })()`);
    return { ok: true, data: { tabId: target.id, direction, amount }, action: 'Scrolled.' };
  } catch (err) {
    return { ok: false, error: `Scroll failed: ${err.message}`, action: '' };
  }
}

async function search({ query, engine = 'google' } = {}) {
  if (!query || !query.trim()) return { ok: false, error: 'No query.', action: '' };
  const q = encodeURIComponent(query.trim());
  const urls = {
    google:     `https://www.google.com/search?q=${q}`,
    duckduckgo: `https://duckduckgo.com/?q=${q}`,
    bing:       `https://www.bing.com/search?q=${q}`,
  };
  const url = urls[engine] || urls.google;
  const opened = await openTab({ url, focus: true });
  if (!opened.ok) return opened;

  const tabId = opened.data.tabId;

  // Wait briefly for results then parse top results.
  let results = [];
  try {
    const client = await _openClient(tabId);
    await _waitForLoad(client);
    const expr = engine === 'google' || engine === 'bing'
      ? `(() => {
          const results = [];
          const blocks = document.querySelectorAll('div.g, li.b_algo, div[data-sokoban-container]');
          for (const b of Array.from(blocks).slice(0, 10)) {
            const a = b.querySelector('a[href^="http"]');
            const h = b.querySelector('h3, h2');
            const s = b.querySelector('div[data-snf], .VwiC3b, .b_caption p, div[role=heading] + div');
            if (!a || !h) continue;
            results.push({
              title: (h.innerText || '').trim().slice(0, 200),
              url:   a.href,
              snippet: ((s && (s.innerText || s.textContent)) || '').trim().slice(0, 280),
            });
            if (results.length >= 5) break;
          }
          return results;
        })()`
      : `(() => {
          const results = [];
          const blocks = document.querySelectorAll('article[data-testid="result"]');
          for (const b of Array.from(blocks).slice(0, 5)) {
            const a = b.querySelector('a[href^="http"]');
            const h = b.querySelector('h2');
            const s = b.querySelector('[data-result="snippet"]');
            if (!a || !h) continue;
            results.push({
              title:   (h.innerText || '').trim().slice(0, 200),
              url:     a.href,
              snippet: ((s && (s.innerText || s.textContent)) || '').trim().slice(0, 280),
            });
          }
          return results;
        })()`;
    results = await _evalJSON(client, expr) || [];
  } catch (err) {
    // Even if parsing failed, the search tab is open — that's still useful.
    return {
      ok:     true,
      data:   { tabId, url, results: [], parseError: err.message },
      action: `Opened ${engine} search for "${query}".`,
    };
  }

  return {
    ok:     true,
    data:   { tabId, url, results, query, engine },
    action: results.length
      ? `Found ${results.length} ${engine} results for "${query}".`
      : `Opened ${engine} search for "${query}".`,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function _waitForLoad(client, timeoutMs = 6000) {
  return new Promise((resolve) => {
    let settled = false;
    const t = setTimeout(() => { if (!settled) { settled = true; resolve(); } }, timeoutMs);
    const handler = () => { if (!settled) { settled = true; clearTimeout(t); client.removeListener('Page.loadEventFired', handler); resolve(); } };
    try { client.on('Page.loadEventFired', handler); }
    catch { clearTimeout(t); resolve(); }
  });
}

function _normaliseUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let url = raw.trim();
  if (!/^https?:\/\//i.test(url)) {
    if (/^[\w.-]+\.[a-z]{2,}(\/.*)?$/i.test(url)) url = 'https://' + url;
    else return null;
  }
  try { return new URL(url).href; } catch { return null; }
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

async function disposeAll() {
  for (const c of _clientCache.values()) {
    try { await c.close(); } catch { /* */ }
  }
  _clientCache.clear();
  _cri = null;
}

module.exports = {
  listTabs, openTab, closeTab, focusTab, navigate,
  readPage, click, fill, scroll, search,
  disposeAll,
};
