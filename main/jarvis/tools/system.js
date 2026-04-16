'use strict';

/**
 * system.js — System-level controls for the Jarvis pipeline.
 *
 * All Windows operations implemented via PowerShell or rundll32.
 * No external tools required (no nircmd, no third-party binaries).
 *
 * Exports:
 *   setVolume(params)     — mute/unmute/up/down/set system audio
 *   setBrightness(action) — increase/decrease display brightness via WMI
 *   lockScreen()          — lock the Windows session via rundll32
 *
 * Pure Node.js — no Electron imports.
 */

const { execFile } = require('child_process');
const { runPS }    = require('./ps-runner');

// ─── Error sanitisation ───────────────────────────────────────────────────────
// runPS can return raw PowerShell error text (stack traces, C# compiler output).
// Never expose that to TTS — always return a short user-facing string instead.

function sanitizeError(raw, fallback) {
  const msg = (raw || '').trim();
  if (!msg || msg.length > 120) return fallback || 'Command failed.';
  return msg;
}

// ─── setVolume ────────────────────────────────────────────────────────────────

/**
 * Control system volume.
 *
 * @param {object} params
 * @param {'mute'|'unmute'|'up'|'down'|'set'} params.action
 * @param {number} [params.level] — 0–100, required when action === 'set'
 * @returns {Promise<ToolResult>}
 */
async function setVolume(params) {
  const { action, level } = params || {};

  if (!action) {
    return { ok: false, error: 'No volume action specified.', action: '' };
  }

  switch (action) {
    case 'mute': {
      const script = `$obj = New-Object -ComObject WScript.Shell; $obj.SendKeys([char]173)`;
      const r = await runPS(script);
      if (!r.ok) return { ok: false, error: sanitizeError(r.error, 'Failed to mute.'), action: '' };
      return { ok: true, data: { action: 'mute' }, action: 'Audio muted.' };
    }

    case 'unmute': {
      // VK_VOLUME_MUTE (173) toggles — send once to unmute.
      const script = `$obj = New-Object -ComObject WScript.Shell; $obj.SendKeys([char]173)`;
      const r = await runPS(script);
      if (!r.ok) return { ok: false, error: sanitizeError(r.error, 'Failed to unmute.'), action: '' };
      return { ok: true, data: { action: 'unmute' }, action: 'Audio unmuted.' };
    }

    case 'up': {
      // VK_VOLUME_UP (175) — press twice for ~4% step
      const script = `$obj = New-Object -ComObject WScript.Shell; $obj.SendKeys([char]175); $obj.SendKeys([char]175)`;
      const r = await runPS(script);
      if (!r.ok) return { ok: false, error: sanitizeError(r.error, 'Failed to increase volume.'), action: '' };
      return { ok: true, data: { action: 'up' }, action: 'Volume increased.' };
    }

    case 'down': {
      // VK_VOLUME_DOWN (174) — press twice for ~4% step
      const script = `$obj = New-Object -ComObject WScript.Shell; $obj.SendKeys([char]174); $obj.SendKeys([char]174)`;
      const r = await runPS(script);
      if (!r.ok) return { ok: false, error: sanitizeError(r.error, 'Failed to decrease volume.'), action: '' };
      return { ok: true, data: { action: 'down' }, action: 'Volume decreased.' };
    }

    case 'set': {
      const clampedLevel = Math.max(0, Math.min(100, Number(level) || 0));
      const scalar = (clampedLevel / 100).toFixed(4); // e.g. "0.7000"

      // IAudioEndpointVolume via Add-Type.
      //
      // Vtable order for IAudioEndpointVolume (after IUnknown's 3 methods, which
      // C# InterfaceIsIUnknown handles automatically):
      //   0 — RegisterControlChangeNotify
      //   1 — UnregisterControlChangeNotify
      //   2 — GetChannelCount
      //   3 — SetMasterVolumeLevel       (absolute dB)
      //   4 — SetMasterVolumeLevelScalar (scalar 0–1) ← we call this
      //
      // IMMDevice.Activate must return `out object` (marshalled as IUnknown),
      // then cast to IAudioEndpointVolume — using `out IAudioEndpointVolume`
      // directly does NOT work because the vtable pointer is a void*.
      //
      // IMMDeviceEnumerator vtable:
      //   0 — EnumAudioEndpoints (stub)
      //   1 — GetDefaultAudioEndpoint   ← we call this
      const script = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioEndpointVolume {
    int RegisterControlChangeNotify(IntPtr pNotify);
    int UnregisterControlChangeNotify(IntPtr pNotify);
    int GetChannelCount(out uint channelCount);
    int SetMasterVolumeLevel(float levelDB, IntPtr pguidEventContext);
    int SetMasterVolumeLevelScalar(float level, IntPtr pguidEventContext);
}

[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDevice {
    int Activate(ref Guid iid, uint clsCtx, IntPtr pActivationParams,
                 [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
}

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int dataFlow, int stateMask,
                           [MarshalAs(UnmanagedType.IUnknown)] out object ppDevices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
}

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
public class MMDeviceEnumeratorComObject {}

public static class AudioSetter {
    public static void SetVolume(float level) {
        var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
        IMMDevice device;
        enumerator.GetDefaultAudioEndpoint(0, 1, out device);
        var iid = typeof(IAudioEndpointVolume).GUID;
        object epvObj;
        device.Activate(ref iid, 23, IntPtr.Zero, out epvObj);
        var epv = (IAudioEndpointVolume)epvObj;
        epv.SetMasterVolumeLevelScalar(level, IntPtr.Zero);
    }
}
"@ -ErrorAction Stop
[AudioSetter]::SetVolume(${scalar})
`.trim();

      const r = await runPS(script, { timeoutMs: 10000 });
      if (!r.ok) {
        // 'already exists' happens if Add-Type was previously compiled in this PS session —
        // in that case the call still succeeds, so treat as success.
        const alreadyLoaded = (r.stderr || '').includes('already exists');
        if (!alreadyLoaded) {
          return { ok: false, error: 'Failed to set volume level.', action: '' };
        }
      }
      return { ok: true, data: { action: 'set', level: clampedLevel }, action: `Volume set to ${clampedLevel}%.` };
    }

    default:
      return { ok: false, error: `Unknown volume action: "${action}".`, action: '' };
  }
}

// ─── setBrightness ────────────────────────────────────────────────────────────

/**
 * Increase or decrease display brightness via WMI.
 * Degrades gracefully on desktop systems where WMI brightness API is absent.
 *
 * @param {'up'|'down'} action
 * @returns {Promise<ToolResult>}
 */
async function setBrightness(action) {
  if (action !== 'up' && action !== 'down') {
    return { ok: false, error: `Unknown brightness action: "${action}".`, action: '' };
  }

  // Read current brightness.
  // Get-CimInstance is read-only here (property access is fine on CimInstance).
  const queryScript = `
$bm = Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBrightness -ErrorAction SilentlyContinue
if ($null -eq $bm) { Write-Output "UNAVAILABLE" } else { Write-Output $bm.CurrentBrightness }
`.trim();

  const queryResult = await runPS(queryScript);
  const queryOut = (queryResult.stdout || '').trim();

  if (!queryResult.ok || queryOut === 'UNAVAILABLE' || queryOut === '') {
    return {
      ok:     false,
      error:  'Brightness control not available on this display.',
      action: '',
    };
  }

  const currentBrightness = parseInt(queryOut, 10);
  if (isNaN(currentBrightness)) {
    return { ok: false, error: 'Could not read current brightness level.', action: '' };
  }

  const step = 10;
  const newBrightness = action === 'up'
    ? Math.min(100, currentBrightness + step)
    : Math.max(0,   currentBrightness - step);

  // IMPORTANT: Get-CimInstance returns a CimInstance — you CANNOT call WMI methods
  // directly on CimInstance objects (unlike Get-WmiObject ManagementObject).
  // The correct approach is Invoke-CimMethod.
  const setScript = `
$methods = Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBrightnessMethods -ErrorAction SilentlyContinue
if ($null -eq $methods) { Write-Output "UNAVAILABLE"; exit 0 }
Invoke-CimMethod -InputObject $methods -MethodName WmiSetBrightness -Arguments @{ Timeout = 1; Brightness = ${newBrightness} } | Out-Null
Write-Output "OK"
`.trim();

  const setResult = await runPS(setScript);
  const setOut = (setResult.stdout || '').trim();

  if (setOut === 'UNAVAILABLE') {
    return { ok: false, error: 'Brightness control not available on this display.', action: '' };
  }

  if (!setResult.ok || setOut !== 'OK') {
    return { ok: false, error: 'Failed to change brightness.', action: '' };
  }

  const direction = action === 'up' ? 'increased' : 'decreased';
  return {
    ok:     true,
    data:   { action, from: currentBrightness, to: newBrightness },
    action: `Brightness ${direction} to ${newBrightness}%.`,
  };
}

// ─── lockScreen ───────────────────────────────────────────────────────────────

/**
 * Lock the Windows session immediately.
 * Uses rundll32.exe — no PS startup cost, immediate response.
 *
 * @returns {Promise<ToolResult>}
 */
function lockScreen() {
  return new Promise((resolve) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        // Lock happens asynchronously in Windows — process exits immediately.
        resolve({ ok: true, data: { locked: true }, action: 'Screen locked.' });
      }
    }, 3000);

    try {
      execFile(
        'rundll32.exe',
        ['user32.dll,LockWorkStation'],
        { timeout: 3000 },
        (err) => {
          if (settled) return;
          clearTimeout(timer);
          settled = true;
          if (err && err.killed) {
            resolve({ ok: false, error: 'Lock screen command timed out.', action: '' });
          } else {
            resolve({ ok: true, data: { locked: true }, action: 'Screen locked.' });
          }
        }
      );
    } catch (err) {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({ ok: false, error: 'Failed to lock screen.', action: '' });
      }
    }
  });
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { setVolume, setBrightness, lockScreen };
