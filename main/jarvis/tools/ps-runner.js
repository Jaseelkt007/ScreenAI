'use strict';

/**
 * ps-runner.js — Centralised PowerShell execution helper.
 *
 * Extracted from the ad-hoc execFile patterns in windows.js and keyboard.js
 * to provide a single consistent seam for all PowerShell calls in Jarvis.
 *
 * Features:
 *   - Consistent 5-second default timeout (configurable per call)
 *   - Consistent error wrapping: PS errors → { ok: false, error: string }
 *   - Stdout/stderr parsed in one place
 *   - Clear seam for a future persistent PS process if latency becomes a concern
 *
 * Pure Node.js — no Electron imports.
 */

const { execFile } = require('child_process');

/**
 * Run a PowerShell script string.
 *
 * @param {string} script           — PowerShell script to execute
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs] — hard timeout in ms (default: 5000)
 * @returns {Promise<{ ok: boolean, stdout: string, stderr: string, error?: string }>}
 *
 * Always resolves — never rejects. Timeout and PS errors both resolve with ok: false.
 */
function runPS(script, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve({ ok: false, stdout: '', stderr: '', error: 'PowerShell timed out after 5s' });
      }
    }, timeoutMs);

    try {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { encoding: 'utf8', timeout: timeoutMs },
        (err, stdout, stderr) => {
          if (settled) return;
          clearTimeout(timer);
          settled = true;
          if (err && !stdout) {
            resolve({ ok: false, stdout: '', stderr: stderr || '', error: err.message });
          } else {
            resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '' });
          }
        }
      );
    } catch (err) {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({ ok: false, stdout: '', stderr: '', error: err.message });
      }
    }
  });
}

module.exports = { runPS };
