'use strict';

/**
 * tools/browser.js — URL launch and navigation tool.
 *
 * Phase 1 scope: open browser, go to URL, search Google.
 * NOT browser automation — no clicking, no page reading, no CDP.
 *
 * Uses shell.openExternal() — opens URLs in the OS default browser.
 * Requires Electron (shell) — Tier B module.
 *
 * navigateInWindowByProcess() is chain-context-only: focuses a specific
 * browser process and navigates via Ctrl+L + clipboard paste + Enter,
 * bypassing shell.openExternal() (which always uses the OS default browser).
 */

const { shell } = require('electron');
const { runPS } = require('./ps-runner');

// Minimal Win32 type for SetForegroundWindow — used by navigateInWindowByProcess.
const _NAV_WIN32_TYPE_DEF = `
if (-not ([System.Management.Automation.PSTypeName]'JarvisWin32').Type) {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class JarvisWin32 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@
}`;

// ─── URL helpers ─────────────────────────────────────────────────────────────

const ALLOWED_SCHEMES = ['http:', 'https:'];

/**
 * Normalise a raw URL from the transcript.
 * Adds https:// if the input is a bare domain (e.g. "youtube.com").
 * Returns null if the result is not a valid http/https URL.
 */
function normaliseUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;

  let url = raw.trim();

  // Add scheme if missing
  if (!/^https?:\/\//i.test(url)) {
    // Looks like a domain (contains a dot, no spaces)
    if (/^[\w.-]+\.[a-z]{2,}(\/.*)?$/i.test(url)) {
      url = 'https://' + url;
    } else {
      return null;
    }
  }

  try {
    const parsed = new URL(url);
    if (!ALLOWED_SCHEMES.includes(parsed.protocol)) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

// ─── Tool functions ───────────────────────────────────────────────────────────

/**
 * Open the system default browser at google.com.
 * Intent: "browser.open" — user said "open a browser" not a specific app.
 * @returns {Promise<ToolResult>}
 */
async function openBrowser() {
  try {
    await shell.openExternal('https://www.google.com');
    return {
      ok: true,
      data: { launched: true, url: 'https://www.google.com' },
      action: 'Opened your default browser.',
    };
  } catch (err) {
    return { ok: false, error: `Could not open browser: ${err.message}`, action: '' };
  }
}

/**
 * Navigate to a specific URL.
 * @param {string} url — URL as spoken (may be bare domain)
 * @returns {Promise<ToolResult>}
 */
async function gotoUrl(url) {
  const normalised = normaliseUrl(url);
  if (!normalised) {
    return {
      ok: false,
      error: `"${url}" is not a valid web address. Only http and https URLs are supported.`,
      action: '',
    };
  }

  try {
    await shell.openExternal(normalised);
    return {
      ok: true,
      data: { launched: true, url: normalised },
      action: `Opened ${normalised}.`,
    };
  } catch (err) {
    return { ok: false, error: `Could not open URL: ${err.message}`, action: '' };
  }
}

/**
 * Search Google for the given query.
 * @param {string} query — raw search terms from transcript
 * @returns {Promise<ToolResult>}
 */
async function search(query) {
  if (!query || !query.trim()) {
    return { ok: false, error: 'No search query provided.', action: '' };
  }

  const encodedQuery = encodeURIComponent(query.trim());
  const searchUrl = `https://www.google.com/search?q=${encodedQuery}`;

  try {
    await shell.openExternal(searchUrl);
    return {
      ok: true,
      data: { launched: true, url: searchUrl },
      action: `Searched Google for "${query.trim()}".`,
    };
  } catch (err) {
    return { ok: false, error: `Could not open search: ${err.message}`, action: '' };
  }
}

/**
 * Navigate to a URL inside a specific browser process, used when step 1 of a
 * chain opened or focused that browser. Focuses the process via SetForegroundWindow,
 * puts the URL on the clipboard, then sends Ctrl+L → Ctrl+V → Enter via WScript.Shell.
 *
 * Avoids shell.openExternal() which always targets the OS default browser.
 *
 * @param {string} url         — URL as spoken (bare domain accepted)
 * @param {string} processName — Windows process name (e.g. 'msedge', 'chrome')
 * @returns {Promise<ToolResult>}
 */
async function navigateInWindowByProcess(url, processName) {
  const normalised = normaliseUrl(url);
  if (!normalised) {
    return {
      ok: false,
      error: `"${url}" is not a valid web address. Only http and https URLs are supported.`,
      action: '',
    };
  }

  const escapedUrl = normalised.replace(/'/g, "''");
  const script = `
${_NAV_WIN32_TYPE_DEF}
$proc = Get-Process -Name '${processName}' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
if (-not $proc) { Write-Output 'NOT_FOUND'; exit 0 }
[JarvisWin32]::SetForegroundWindow($proc.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 300
Set-Clipboard -Value '${escapedUrl}'
$shell = New-Object -ComObject WScript.Shell
$shell.SendKeys('^l')
Start-Sleep -Milliseconds 150
$shell.SendKeys('^v')
Start-Sleep -Milliseconds 50
$shell.SendKeys('{ENTER}')
Write-Output 'OK'
`;

  const r = await runPS(script, { timeoutMs: 8000 });
  if (!r.ok && !r.stdout) {
    return { ok: false, error: `Could not navigate in browser: ${(r.stderr || r.error || '').trim()}`, action: '' };
  }

  const out = (r.stdout || '').trim();
  if (out === 'NOT_FOUND') {
    return { ok: false, error: `Browser "${processName}" is not running.`, action: '' };
  }
  return {
    ok: true,
    data: { launched: true, url: normalised },
    action: `Opened ${normalised}.`,
  };
}

module.exports = { openBrowser, gotoUrl, search, normaliseUrl, navigateInWindowByProcess };
