'use strict';

/**
 * tools/web-scrape.js — M5.2 Apify deep-scrape tool.
 *
 * Used by the planner when browser.read is insufficient (paginated, anti-bot,
 * heavily JS-rendered pages). SLOW (~2-5 s) — the planner is told to prefer
 * web.search / browser.read first.
 *
 * Default actor: apify/web-scraper. Override via jarvisApifyActor setting.
 *
 * Apify run flow:
 *   POST /v2/acts/<actor>/run-sync-get-dataset-items?token=<token>
 *     body: { startUrls: [{ url }], pageFunction: '...', ... }
 *   Returns dataset items array directly when run-sync completes within timeout.
 *
 * Pure Node — node-fetch.
 */

const settings = require('../../settings');

const APIFY_BASE = 'https://api.apify.com/v2';

// ─── Per-process rate limit ───────────────────────────────────────────────────

const _rate = { window: 60000, hits: [] };
function _rateOk() {
  const limit = Number(settings.getSetting('jarvisWebScrapePerMinute', 3)) || 3;
  const now = Date.now();
  _rate.hits = _rate.hits.filter((t) => now - t < _rate.window);
  if (_rate.hits.length >= limit) return false;
  _rate.hits.push(now);
  return true;
}

/**
 * @param {object} opts
 * @param {string} opts.url
 * @param {string} [opts.instructions]
 * @returns {Promise<ToolResult>}
 */
async function scrape({ url, instructions } = {}) {
  if (!url || typeof url !== 'string') return { ok: false, error: 'No URL.', action: '' };
  let parsed;
  try { parsed = new URL(url.trim()); } catch { return { ok: false, error: `Invalid URL: ${url}`, action: '' }; }
  if (!/^https?:$/.test(parsed.protocol)) return { ok: false, error: 'Only http/https URLs are supported.', action: '' };

  const token = settings.getSetting('jarvisApifyToken', '') || process.env.APIFY_TOKEN || '';
  if (!token) {
    return { ok: false, error: 'No Apify token configured. Add jarvisApifyToken in Settings.', action: '' };
  }
  if (!_rateOk()) {
    return { ok: false, error: 'web.scrape rate limit reached for this minute.', action: '' };
  }

  const actor = settings.getSetting('jarvisApifyActor', 'apify/web-scraper') || 'apify/web-scraper';
  const actorPath = encodeURIComponent(actor).replace('%2F', '~'); // Apify accepts user~actor

  const apiUrl = `${APIFY_BASE}/acts/${actorPath}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}&timeout=60`;

  // Minimal payload that web-scraper accepts: a list of URLs + a pageFunction
  // that returns a small object. We extract title + main text + a link list,
  // bounded so the LLM can still use the result without context bloat.
  const pageFunction = `async function pageFunction(context) {
    const { request, jQuery: $ } = context;
    const title = document.title || '';
    const text  = (document.body ? document.body.innerText : '').slice(0, 8000);
    const links = $ ? $('a[href]').map((_, a) => ({
      text: ($(a).text() || '').trim().slice(0, 200),
      url:  a.href,
    })).get().filter((l) => l.url && l.url.startsWith('http')).slice(0, 20) : [];
    return { url: request.url, title, text, links };
  }`;

  const payload = {
    startUrls:        [{ url: parsed.href }],
    pageFunction,
    maxPagesPerCrawl: 1,
    proxyConfiguration: { useApifyProxy: true },
  };
  if (typeof instructions === 'string' && instructions.trim()) {
    payload.userData = { instructions: instructions.slice(0, 500) };
  }

  let res;
  try {
    const fetch = (await import('node-fetch')).default;
    res = await fetch(apiUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
  } catch (err) {
    return { ok: false, error: `Apify network error: ${err.message}`, action: '' };
  }

  if (!res.ok) {
    let body = '';
    try { body = await res.text(); } catch { /* */ }
    return { ok: false, error: `Apify error [${res.status}]: ${body.slice(0, 240)}`, action: '' };
  }

  let items;
  try { items = await res.json(); } catch (err) {
    return { ok: false, error: `Apify returned invalid JSON: ${err.message}`, action: '' };
  }

  const first = Array.isArray(items) && items.length ? items[0] : null;
  if (!first) return { ok: false, error: 'Apify returned no data.', action: '' };

  return {
    ok:     true,
    data:   {
      url:    first.url   || parsed.href,
      title:  first.title || '',
      text:   String(first.text || '').slice(0, 8000),
      links:  Array.isArray(first.links) ? first.links.slice(0, 20) : [],
    },
    action: `Scraped "${first.title || parsed.hostname}" (${(first.text || '').length} chars).`,
  };
}

module.exports = { scrape };
