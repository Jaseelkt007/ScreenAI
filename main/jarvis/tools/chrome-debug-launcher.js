'use strict';

/**
 * chrome-debug-launcher.js — M5.1
 *
 * Detects whether a Chrome instance with --remote-debugging-port=<port> is
 * already running (probes http://127.0.0.1:<port>/json/version). If not, and
 * jarvisChromeAutoLaunch is true, spawns Chrome with the debug flag. Returns
 * a small descriptor the browser tool uses to attach over CDP.
 *
 * NOTE: We do NOT kill the user's existing Chrome. If they have a regular
 * Chrome running without the debug flag, we ask them to restart it (HUD prompt
 * via the returned needsRelaunch flag) — the caller decides UX.
 *
 * Pure Node — uses node:http for the probe and child_process.spawn for launch.
 */

const fs       = require('fs');
const os       = require('os');
const path     = require('path');
const http     = require('http');
const { spawn } = require('child_process');
const settings = require('../../settings');

let _spawned = null; // { proc, port, startedAt }

// ─── Probe ────────────────────────────────────────────────────────────────────

/**
 * Probe the debug endpoint. Resolves with { ok, port, version?, error? }.
 * @param {number} port
 * @param {number} [timeoutMs=900]
 */
function probeDebugPort(port, timeoutMs = 900) {
  return new Promise((resolve) => {
    let settled = false;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path:     '/json/version',
      method:   'GET',
      timeout:  timeoutMs,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (settled) return; settled = true;
        if (res.statusCode !== 200) {
          resolve({ ok: false, port, error: `HTTP ${res.statusCode}` });
          return;
        }
        try {
          const data = JSON.parse(body);
          resolve({ ok: true, port, version: data.Browser || '', webSocketDebuggerUrl: data.webSocketDebuggerUrl || '' });
        } catch (err) {
          resolve({ ok: false, port, error: `bad JSON: ${err.message}` });
        }
      });
    });
    req.on('timeout', () => { if (!settled) { settled = true; req.destroy(); resolve({ ok: false, port, error: 'timeout' }); } });
    req.on('error',   (err) => { if (!settled) { settled = true; resolve({ ok: false, port, error: err.message }); } });
    req.end();
  });
}

// ─── Locate chrome.exe ────────────────────────────────────────────────────────

function _findChromePath() {
  const explicit = settings.getSetting('jarvisChromePath', '');
  if (explicit && fs.existsSync(explicit)) return explicit;

  if (process.platform === 'win32') {
    const candidates = [
      path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['LocalAppData'] || (path.join(os.homedir(), 'AppData', 'Local')), 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
    for (const c of candidates) { if (fs.existsSync(c)) return c; }
    return null;
  }
  if (process.platform === 'darwin') {
    const c = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    return fs.existsSync(c) ? c : null;
  }
  // linux best-effort
  for (const c of ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/google-chrome-stable']) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

// ─── Launch ───────────────────────────────────────────────────────────────────

/**
 * Spawn Chrome with --remote-debugging-port=<port>. Uses the user's default
 * profile so they keep their cookies, history, extensions.
 *
 * @param {number} port
 * @returns {Promise<{ ok, port, error? }>}
 */
async function launchChromeWithDebug(port) {
  const chromePath = _findChromePath();
  if (!chromePath) {
    return { ok: false, port, error: 'Chrome executable not found. Set jarvisChromePath in settings.' };
  }

  // Use a non-default user-data dir to avoid the "Chrome already running with
  // a different profile" lock that fires when the user already has Chrome up.
  // The user's session/cookies/history live in their default profile, but a
  // CDP-attached Chrome can still run side-by-side as a separate instance.
  // This is the same trade-off Playwright makes for connectOverCDP.
  const userDataDir = path.join(os.homedir(), '.jarvis-chrome');
  try { fs.mkdirSync(userDataDir, { recursive: true }); } catch { /* */ }

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=ChromeWhatsNewUI',
    '--start-maximized',
  ];

  let proc;
  try {
    proc = spawn(chromePath, args, { detached: true, stdio: 'ignore' });
    proc.on('error', () => { /* swallow — handled via probe failure */ });
    proc.unref();
  } catch (err) {
    return { ok: false, port, error: `Could not spawn Chrome: ${err.message}` };
  }
  _spawned = { proc, port, startedAt: Date.now() };

  // Wait up to 5s for the debug port to come up.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const p = await probeDebugPort(port, 600);
    if (p.ok) return { ok: true, port, version: p.version, webSocketDebuggerUrl: p.webSocketDebuggerUrl };
    await new Promise((r) => setTimeout(r, 250));
  }
  return { ok: false, port, error: 'Chrome started but debug port did not become reachable.' };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Ensure a CDP-debuggable Chrome is reachable on the configured port.
 * Probes first; spawns iff jarvisChromeAutoLaunch is true.
 *
 * @returns {Promise<{ ok: boolean, port: number, version?, webSocketDebuggerUrl?, error?, needsRelaunch?: boolean }>}
 */
async function ensureChromeDebug() {
  const port = Number(settings.getSetting('jarvisChromeDebugPort', 9222)) || 9222;

  const probe1 = await probeDebugPort(port);
  if (probe1.ok) return { ok: true, port, version: probe1.version, webSocketDebuggerUrl: probe1.webSocketDebuggerUrl };

  if (!settings.getSetting('jarvisChromeAutoLaunch', true)) {
    return {
      ok:    false,
      port,
      error: 'Chrome debug port not reachable and auto-launch disabled.',
      needsRelaunch: true,
    };
  }

  const launched = await launchChromeWithDebug(port);
  if (launched.ok) return launched;

  return { ...launched, needsRelaunch: true };
}

module.exports = { ensureChromeDebug, probeDebugPort, launchChromeWithDebug };
