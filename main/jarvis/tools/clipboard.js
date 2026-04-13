'use strict';

/**
 * tools/clipboard.js — Write text to the system clipboard.
 *
 * Uses Electron's clipboard module (synchronous API).
 * Requires Electron — Tier B module.
 */

const { clipboard } = require('electron');

/**
 * Write text to the system clipboard.
 * @param {string} text — text to copy
 * @returns {Promise<ToolResult>}
 */
async function writeClipboard(text) {
  if (typeof text !== 'string') {
    return { ok: false, error: 'No text provided to copy.', action: '' };
  }

  try {
    clipboard.writeText(text);

    // Immediate readback to confirm write succeeded
    const written = clipboard.readText();
    if (written !== text) {
      return {
        ok: false,
        error: 'Clipboard write did not verify — readback mismatch.',
        action: '',
      };
    }

    return {
      ok: true,
      data: { written: text },
      action: `Copied ${text.length} character${text.length !== 1 ? 's' : ''} to clipboard.`,
    };
  } catch (err) {
    return { ok: false, error: `Clipboard error: ${err.message}`, action: '' };
  }
}

module.exports = { writeClipboard };
