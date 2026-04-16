'use strict';

/**
 * sites.js — Named site shortcut lookup table for the browser.site intent.
 *
 * Same philosophy as app-names.js — a plain object, easy to extend.
 * Imported by dispatcher.js for URL resolution.
 *
 * Pure Node.js — no Electron imports.
 */

// Maps spoken name aliases → canonical URL
const NAMED_SITES = {
  'gmail':               'https://mail.google.com',
  'youtube':             'https://youtube.com',
  'github':              'https://github.com',
  'linkedin':            'https://linkedin.com',
  'twitter':             'https://x.com',
  'x':                   'https://x.com',
  'reddit':              'https://reddit.com',
  'calendar':            'https://calendar.google.com',
  'google calendar':     'https://calendar.google.com',
  'notion':              'https://notion.so',
  'stackoverflow':       'https://stackoverflow.com',
  'stack overflow':      'https://stackoverflow.com',
  'google docs':         'https://docs.google.com',
  'docs':                'https://docs.google.com',
  'google drive':        'https://drive.google.com',
  'drive':               'https://drive.google.com',
  'google maps':         'https://maps.google.com',
  'maps':                'https://maps.google.com',
  'google':              'https://www.google.com',
  'chatgpt':             'https://chatgpt.com',
  'claude':              'https://claude.ai',
  'netflix':             'https://netflix.com',
  'spotify web':         'https://open.spotify.com',
  'amazon':              'https://amazon.com',
};

/**
 * Resolve a spoken site name to a canonical URL.
 *
 * Normalisation steps (applied in order):
 *   1. Lowercase
 *   2. Strip leading "the " or "my "
 *   3. Strip trailing " website", " web", " page", " site"
 *   4. Trim whitespace
 *
 * Returns the URL string, or null if no match found.
 *
 * @param {string} spokenName
 * @returns {string|null}
 */
function resolveSiteUrl(spokenName) {
  if (!spokenName || typeof spokenName !== 'string') return null;

  let normalised = spokenName.toLowerCase().trim();

  // Strip leading articles/possessives
  normalised = normalised.replace(/^(the|my)\s+/, '');

  // Strip trailing noise words
  normalised = normalised.replace(/\s+(website|web|page|site)$/, '');

  normalised = normalised.trim();

  return NAMED_SITES[normalised] || null;
}

module.exports = { NAMED_SITES, resolveSiteUrl };
