'use strict';

/**
 * tools/web-search.js — M5.2 web search.
 *
 * Returns top web results without opening a browser tab. Used by the planner
 * for "what's happening with X / look up Y" queries where the user only needs
 * text content, not a visible browser.
 *
 * Provider is selected via jarvisWebSearchProvider:
 *   'tavily' (default) — 1000 queries/month free, no credit card required
 *   'brave'            — 2000 queries/month free but requires a card on signup
 *
 * Settings:
 *   jarvisWebSearchProvider   — provider key (above)
 *   jarvisTavilyApiKey        — required when provider='tavily'
 *   jarvisBraveApiKey         — required when provider='brave'
 *   jarvisWebSearchPerMinute  — rate limit shared across providers (default 10)
 *
 * Pure Node — node-fetch (loaded lazily for ESM compatibility).
 */

const settings = require('../../settings');

const TAVILY_URL = 'https://api.tavily.com/search';
const BRAVE_URL  = 'https://api.search.brave.com/res/v1/web/search';

// node-fetch v3 is ESM-only — load lazily.
let _fetchPromise = null;
function _getFetch() {
  if (!_fetchPromise) _fetchPromise = import('node-fetch').then((m) => m.default);
  return _fetchPromise;
}

// ─── Per-process rate limit ───────────────────────────────────────────────────

const _rate = { window: 60000, hits: [] };
function _rateOk() {
  const limit = Number(settings.getSetting('jarvisWebSearchPerMinute', 10)) || 10;
  const now = Date.now();
  _rate.hits = _rate.hits.filter((t) => now - t < _rate.window);
  if (_rate.hits.length >= limit) return false;
  _rate.hits.push(now);
  return true;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {string} opts.query
 * @param {number} [opts.count=5]
 * @returns {Promise<ToolResult>}
 */
async function search({ query, count = 5 } = {}) {
  if (!query || !query.trim()) return { ok: false, error: 'No query.', action: '' };

  const provider = (settings.getSetting('jarvisWebSearchProvider', 'tavily') || 'tavily').toLowerCase();
  if (!_rateOk()) {
    return { ok: false, error: 'web.search rate limit reached for this minute.', action: '' };
  }

  if (provider === 'brave') return _searchBrave({ query, count });
  return _searchTavily({ query, count });
}

// ─── Tavily ───────────────────────────────────────────────────────────────────

async function _searchTavily({ query, count }) {
  const apiKey = settings.getSetting('jarvisTavilyApiKey', '') || process.env.TAVILY_API_KEY || '';
  if (!apiKey) {
    return {
      ok:    false,
      error: 'No Tavily API key configured. Get one free (no card) at https://app.tavily.com/sign-in then add it to Settings → jarvisTavilyApiKey. Or switch to a different provider via jarvisWebSearchProvider.',
      action: '',
    };
  }

  const max = Math.max(1, Math.min(10, Number(count) || 5));
  const body = {
    api_key:               apiKey,
    query:                 query.trim(),
    max_results:           max,
    search_depth:          'basic',
    include_answer:        false,
    include_raw_content:   false,
  };

  let res;
  try {
    const fetch = await _getFetch();
    res = await fetch(TAVILY_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, error: `Tavily network error: ${err.message}`, action: '' };
  }

  if (!res.ok) {
    let bodyText = '';
    try { bodyText = await res.text(); } catch { /* */ }
    return { ok: false, error: `Tavily error [${res.status}]: ${bodyText.slice(0, 240)}`, action: '' };
  }

  let data;
  try { data = await res.json(); } catch (err) {
    return { ok: false, error: `Tavily returned invalid JSON: ${err.message}`, action: '' };
  }

  const items = Array.isArray(data && data.results) ? data.results : [];
  const results = items.slice(0, max).map((r) => ({
    title:   String(r.title   || '').slice(0, 240),
    url:     String(r.url     || ''),
    snippet: String(r.content || '').replace(/\s+/g, ' ').trim().slice(0, 320),
  }));

  return {
    ok:     true,
    data:   { results, query: query.trim(), provider: 'tavily' },
    action: results.length
      ? `Found ${results.length} web result${results.length === 1 ? '' : 's'} for "${query.trim()}".`
      : `No web results for "${query.trim()}".`,
  };
}

// ─── Brave ────────────────────────────────────────────────────────────────────

async function _searchBrave({ query, count }) {
  const apiKey = settings.getSetting('jarvisBraveApiKey', '') || process.env.BRAVE_API_KEY || '';
  if (!apiKey) {
    return { ok: false, error: 'No Brave Search API key configured. Add jarvisBraveApiKey in Settings, or switch jarvisWebSearchProvider to "tavily" for a free path.', action: '' };
  }

  const max = Math.max(1, Math.min(10, Number(count) || 5));
  const params = new URLSearchParams({
    q:                query.trim(),
    count:            String(max),
    safesearch:       'moderate',
    text_decorations: 'false',
  });
  const url = `${BRAVE_URL}?${params.toString()}`;

  let res;
  try {
    const fetch = await _getFetch();
    res = await fetch(url, {
      method:  'GET',
      headers: {
        'Accept':                'application/json',
        'Accept-Encoding':       'gzip',
        'X-Subscription-Token':  apiKey,
      },
    });
  } catch (err) {
    return { ok: false, error: `Brave network error: ${err.message}`, action: '' };
  }

  if (!res.ok) {
    let body = '';
    try { body = await res.text(); } catch { /* */ }
    return { ok: false, error: `Brave Search error [${res.status}]: ${body.slice(0, 160)}`, action: '' };
  }

  let data;
  try { data = await res.json(); } catch (err) {
    return { ok: false, error: `Brave returned invalid JSON: ${err.message}`, action: '' };
  }

  const items = (data && data.web && Array.isArray(data.web.results)) ? data.web.results : [];
  const results = items.slice(0, max).map((r) => ({
    title:   String(r.title || '').slice(0, 240),
    url:     String(r.url   || ''),
    snippet: String(r.description || r.snippet || '').replace(/<[^>]+>/g, '').slice(0, 320),
  }));

  return {
    ok:     true,
    data:   { results, query: query.trim(), provider: 'brave' },
    action: results.length
      ? `Found ${results.length} web result${results.length === 1 ? '' : 's'} for "${query.trim()}".`
      : `No web results for "${query.trim()}".`,
  };
}

module.exports = { search };
