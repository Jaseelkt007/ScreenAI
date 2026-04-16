'use strict';

/**
 * tools/windows.js — Window management via PowerShell + Win32 API.
 *
 * Windows-first. Uses child_process.execFile('powershell.exe') with Add-Type
 * inline DllImport — no native node addons, no new npm dependencies.
 *
 * All functions resolve with { ok, data?, action, error? } — never reject.
 * Each PowerShell call has a 5-second hard timeout.
 *
 * Phase 2 scope note:
 *   switchWindow uses WScript.Shell.SendKeys (Alt+Tab). This is prototype-quality:
 *   timing-sensitive and focus-sensitive. Evaluate @nut-tree/nut-js in Phase 3
 *   if reliability issues arise.
 *
 *   minimizeWindow / maximizeWindow with no appName uses GetForegroundWindow()
 *   inside the spawned PowerShell process. Due to process isolation this captures
 *   the PS window itself rather than the user's intended window. Prefer named-app
 *   commands ("minimize chrome") for reliable results. Phase 3 item.
 *
 * Pure Node.js — no Electron imports.
 */

const { execFile } = require('child_process');
const { APP_NAMES, BROWSER_PROCESS_NAMES } = require('./app-names');

// ─── Constants ────────────────────────────────────────────────────────────────

/** Processes that can never be closed via closeApp. */
const PROTECTED_PROCESSES = new Set([
  'explorer', 'winlogon', 'csrss', 'services', 'svchost', 'lsass', 'system',
]);

const PS_TIMEOUT_MS = 5000;

/**
 * Win32 Add-Type definition block — included in every PS script that needs it.
 * Guard against re-adding the type in the same session (not normally needed
 * since each execFile spawns a fresh process, but defensive).
 */
const WIN32_TYPE_DEF = `
if (-not ([System.Management.Automation.PSTypeName]'JarvisWin32').Type) {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class JarvisWin32 {
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out int lpdwProcessId);
}
"@
}
`;

// ShowWindow nCmdShow constants
const SW_MINIMIZE = 6;
const SW_MAXIMIZE = 3;

// ─── PowerShell runner ────────────────────────────────────────────────────────

/**
 * Run a PowerShell command string. Returns { ok, stdout, stderr }.
 * Resolves (never rejects) — timeout results in ok: false.
 */
function runPs(command) {
  return new Promise((resolve) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve({ ok: false, stdout: '', stderr: 'PowerShell timed out after 5s' });
      }
    }, PS_TIMEOUT_MS);

    try {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', command],
        { encoding: 'utf8', timeout: PS_TIMEOUT_MS },
        (err, stdout, stderr) => {
          if (settled) return;
          clearTimeout(timer);
          settled = true;
          if (err && !stdout) {
            resolve({ ok: false, stdout: '', stderr: stderr || err.message });
          } else {
            resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '' });
          }
        }
      );
    } catch (err) {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({ ok: false, stdout: '', stderr: err.message });
      }
    }
  });
}

// ─── Name resolution ─────────────────────────────────────────────────────────

/**
 * Translate spoken app name (e.g. "chrome") → Windows process name (e.g. "chrome").
 * Falls back to the spoken name itself if not in APP_NAMES map.
 */
function resolveProcessName(appName) {
  const key = (appName || '').toLowerCase().trim();
  const entry = APP_NAMES[key];
  return entry ? entry.processName : key;
}

// ─── Script builders ──────────────────────────────────────────────────────────

function namedWindowScript(processName, swCmd) {
  // Filter to processes that have a visible MainWindowHandle first.
  // Critical for multi-process apps (Chrome, Discord, Zoom) where the first
  // process returned by Get-Process is often a background helper with no window.
  return `
${WIN32_TYPE_DEF}
$proc = Get-Process -Name '${processName}' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
if (-not $proc) { Write-Output 'NOT_FOUND'; exit 0 }
[JarvisWin32]::ShowWindow($proc.MainWindowHandle, ${swCmd}) | Out-Null
Write-Output 'OK'
`;
}

function activeWindowScript(swCmd) {
  // NOTE: GetForegroundWindow() here captures whatever is focused at PS launch time,
  // which is typically the PS window itself. Prefer named-app commands in practice.
  return `
${WIN32_TYPE_DEF}
$hwnd = [JarvisWin32]::GetForegroundWindow()
if ($hwnd -eq [IntPtr]::Zero) { Write-Output 'NO_WINDOW'; exit 0 }
[JarvisWin32]::ShowWindow($hwnd, ${swCmd}) | Out-Null
Write-Output 'OK'
`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Close an app gracefully by sending WM_CLOSE (not Stop-Process -Force).
 * The app receives the close signal and can show unsaved-changes dialogs.
 *
 * Do NOT change to Stop-Process -Force in Phase 2. Force kill is a separate
 * Phase 3 intent (app.kill) with its own confirm gate.
 *
 * @param {string} appName — spoken app name (e.g. "notepad", "chrome")
 * @returns {Promise<ToolResult>}
 */
async function closeApp(appName) {
  if (!appName) {
    return { ok: false, error: 'No app name provided.', action: '' };
  }

  const key = (appName || '').toLowerCase().trim();
  if (PROTECTED_PROCESSES.has(key)) {
    return { ok: false, error: `Cannot close system process "${appName}".`, action: '' };
  }

  const processName = resolveProcessName(appName);

  // WM_CLOSE = 0x0010
  const script = `
${WIN32_TYPE_DEF}
$procs = Get-Process -Name '${processName}' -ErrorAction SilentlyContinue
if (-not $procs) { Write-Output 'NOT_FOUND'; exit 0 }
foreach ($p in $procs) {
  if ($p.MainWindowHandle -ne [IntPtr]::Zero) {
    [JarvisWin32]::PostMessage($p.MainWindowHandle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
  }
}
Start-Sleep -Milliseconds 2500
$still = Get-Process -Name '${processName}' -ErrorAction SilentlyContinue
if ($still) { Write-Output 'STILL_RUNNING' } else { Write-Output 'CLOSED' }
`;

  const r = await runPs(script);
  if (!r.ok && !r.stdout) {
    return { ok: false, error: `PowerShell error: ${r.stderr.trim()}`, action: '' };
  }

  const out = r.stdout.trim();
  if (out === 'NOT_FOUND') {
    return { ok: false, error: `"${appName}" is not running.`, action: '' };
  }
  if (out === 'STILL_RUNNING') {
    return { ok: false, error: `"${appName}" did not close gracefully. It may have unsaved changes.`, action: '' };
  }
  return { ok: true, data: { closed: true, processName }, action: `Closed ${appName}.` };
}

/**
 * Bring a named app window to the foreground.
 * Verification is focus_assumed — we confirm the process exists and the
 * request was sent, but cannot guarantee the window actually came to front.
 *
 * @param {string} appName — spoken app name
 * @returns {Promise<ToolResult>}
 */
async function focusApp(appName) {
  if (!appName) {
    return { ok: false, error: 'No app name provided.', action: '' };
  }

  const processName = resolveProcessName(appName);

  // Filter to process WITH a visible window — same multi-process fix as namedWindowScript.
  const script = `
${WIN32_TYPE_DEF}
$proc = Get-Process -Name '${processName}' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
if (-not $proc) { Write-Output 'NOT_FOUND'; exit 0 }
[JarvisWin32]::SetForegroundWindow($proc.MainWindowHandle) | Out-Null
Write-Output 'OK'
`;

  const r = await runPs(script);
  if (!r.ok && !r.stdout) {
    return { ok: false, error: `PowerShell error: ${r.stderr.trim()}`, action: '' };
  }

  const out = r.stdout.trim();
  if (out === 'NOT_FOUND') {
    return { ok: false, error: `"${appName}" is not running.`, action: '' };
  }
  if (out === 'NO_WINDOW') {
    return { ok: false, error: `"${appName}" has no visible window.`, action: '' };
  }
  return { ok: true, data: { focused: true, processName }, action: `Focused ${appName}.` };
}

/**
 * Minimize the active window, or a named app window if appName is provided.
 *
 * @param {string|null} appName — spoken app name, or null for active window
 * @returns {Promise<ToolResult>}
 */
async function minimizeWindow(appName) {
  const script = appName
    ? namedWindowScript(resolveProcessName(appName), SW_MINIMIZE)
    : activeWindowScript(SW_MINIMIZE);

  const r = await runPs(script);
  if (!r.ok && !r.stdout) {
    return { ok: false, error: `PowerShell error: ${r.stderr.trim()}`, action: '' };
  }

  const out = r.stdout.trim();
  if (out === 'NOT_FOUND') {
    return { ok: false, error: `"${appName}" is not running.`, action: '' };
  }
  if (out === 'NO_WINDOW') {
    return { ok: false, error: 'No foreground window found.', action: '' };
  }
  return { ok: true, data: {}, action: appName ? `Minimized ${appName}.` : 'Minimized window.' };
}

/**
 * Maximize the active window, or a named app window if appName is provided.
 *
 * @param {string|null} appName — spoken app name, or null for active window
 * @returns {Promise<ToolResult>}
 */
async function maximizeWindow(appName) {
  const script = appName
    ? namedWindowScript(resolveProcessName(appName), SW_MAXIMIZE)
    : activeWindowScript(SW_MAXIMIZE);

  const r = await runPs(script);
  if (!r.ok && !r.stdout) {
    return { ok: false, error: `PowerShell error: ${r.stderr.trim()}`, action: '' };
  }

  const out = r.stdout.trim();
  if (out === 'NOT_FOUND') {
    return { ok: false, error: `"${appName}" is not running.`, action: '' };
  }
  if (out === 'NO_WINDOW') {
    return { ok: false, error: 'No foreground window found.', action: '' };
  }
  return { ok: true, data: {}, action: appName ? `Maximized ${appName}.` : 'Maximized window.' };
}

/**
 * Switch to the previous window (Alt+Tab) via WScript.Shell.
 * Acts on the OS window stack — no target name needed.
 *
 * @returns {Promise<ToolResult>}
 */
async function switchWindow() {
  const script = `
$shell = New-Object -ComObject WScript.Shell
$shell.SendKeys('%{TAB}')
Write-Output 'OK'
`;

  const r = await runPs(script);
  if (!r.ok && !r.stdout) {
    return { ok: false, error: `PowerShell error: ${r.stderr.trim()}`, action: '' };
  }
  return { ok: true, data: {}, action: 'Switched window (Alt+Tab).' };
}

/**
 * List all active windows (processes with a visible MainWindowTitle).
 * Returns array of { name, title, pid }.
 *
 * @returns {Promise<ToolResult>}
 */
async function listActiveWindows() {
  const script = `
Get-Process | Where-Object { $_.MainWindowTitle -ne '' } | ForEach-Object {
  Write-Output "$($_.ProcessName)|$($_.MainWindowTitle)|$($_.Id)"
}
`;
  const r = await runPs(script);
  if (!r.ok) {
    return { ok: false, error: r.stderr.trim(), action: '' };
  }

  const entries = r.stdout.trim().split('\n').filter(Boolean).map((line) => {
    const parts = line.trim().split('|');
    return {
      name:  (parts[0] || '').trim(),
      title: (parts[1] || '').trim(),
      pid:   parseInt(parts[2] || '0', 10),
    };
  });

  return { ok: true, data: { windows: entries }, action: '' };
}

/**
 * Check if the currently focused window belongs to a known browser process.
 *
 * Fail-safe contract: Any error, timeout, or ambiguous result MUST return
 * { focused: false, processName: null }. Never assumes browser is focused
 * when uncertain. The safe default is always false — a browser command
 * failing with a helpful error is far better than silently sending keystrokes
 * to the wrong application.
 *
 * @returns {Promise<{ focused: boolean, processName: string|null }>}
 */
async function isBrowserFocused() {
  const script = `
${WIN32_TYPE_DEF}
$hwnd = [JarvisWin32]::GetForegroundWindow()
if ($hwnd -eq [IntPtr]::Zero) { Write-Output 'NONE'; exit 0 }
$pid = 0
[JarvisWin32]::GetWindowThreadProcessId($hwnd, [ref]$pid) | Out-Null
if ($pid -eq 0) { Write-Output 'NONE'; exit 0 }
$proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
if (-not $proc) { Write-Output 'NONE'; exit 0 }
Write-Output $proc.ProcessName
`;

  try {
    const r = await runPs(script);
    if (!r.ok) return { focused: false, processName: null };

    const procName = r.stdout.trim().toLowerCase();
    if (!procName || procName === 'none') return { focused: false, processName: null };

    const focused = BROWSER_PROCESS_NAMES.has(procName);
    return { focused, processName: procName };
  } catch {
    // Fail-safe: any unexpected error → not focused
    return { focused: false, processName: null };
  }
}

/**
 * Capture the current foreground window handle as a decimal string.
 * Returns null on any error or if no foreground window exists.
 *
 * @returns {Promise<string|null>}
 */
async function captureForegroundWindow() {
  const script = `
${WIN32_TYPE_DEF}
$hwnd = [JarvisWin32]::GetForegroundWindow()
if ($hwnd -eq [IntPtr]::Zero) { Write-Output 'NONE'; exit 0 }
Write-Output $hwnd.ToInt64()
`;

  try {
    const r = await runPs(script);
    if (!r.ok) return null;

    const handle = (r.stdout || '').trim();
    if (!handle || handle === 'NONE' || !/^-?\d+$/.test(handle)) return null;
    return handle;
  } catch {
    return null;
  }
}

module.exports = {
  closeApp,
  focusApp,
  minimizeWindow,
  maximizeWindow,
  switchWindow,
  listActiveWindows,
  isBrowserFocused,
  captureForegroundWindow,
};
