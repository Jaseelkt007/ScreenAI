'use strict';

/**
 * tools/ui.js — Generic UI control via Windows UIAutomation. (M4.6)
 *
 * Exposes four capabilities to the dispatcher and the M4.5 agent:
 *   listElements({scope, role})           → enumerate clickable / readable controls
 *   clickElement({name, automationId, …}) → invoke a button / link / etc.
 *   fillElement({name, automationId, value}) → set text on an edit control
 *   readElement({name, automationId})     → read the value/text of a control
 *
 * Resolution order:
 *   automationId (exact)  →  name (exact)  →  name (substring)
 *   Multiple matches → return { ok:false, ambiguous:true, candidates }
 *   Zero matches    → return { ok:false, error: '...' }
 *
 * The PowerShell tier handles the actual UIA calls. We inline scripts here so
 * we don't need to read a separate .ps1 file at runtime (asar / packaging
 * compatibility); see tools/ps-uia.ps1 for a manually-runnable reference.
 *
 * Pure Node — no Electron imports; runPS is mockable for Tier A tests.
 */

const psRunner = require('./ps-runner');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _runPS(script, opts) {
  // Indirect through the module so withPatchedExports() can swap runPS in tests.
  return psRunner.runPS(script, opts);
}

function _quote(s) {
  // Single-quote-safe inside PowerShell single-quoted strings.
  return String(s == null ? '' : s).replace(/'/g, "''");
}

function _parseJsonStdout(stdout) {
  if (!stdout) return null;
  // PS may emit BOM or trailing whitespace; trim it.
  const trimmed = stdout.replace(/^﻿/, '').trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); } catch { return null; }
}

// ─── PowerShell script blocks ─────────────────────────────────────────────────

const PS_PRELUDE = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient | Out-Null
Add-Type -AssemblyName UIAutomationTypes  | Out-Null

function Get-RootElement([string]$scope) {
  if ($scope -eq 'desktop') {
    return [System.Windows.Automation.AutomationElement]::RootElement
  }
  Add-Type -Namespace JarvisUia -Name U -MemberDefinition '[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();' -ErrorAction SilentlyContinue | Out-Null
  $hwnd = [JarvisUia.U]::GetForegroundWindow()
  if (-not $hwnd -or $hwnd -eq [System.IntPtr]::Zero) {
    return [System.Windows.Automation.AutomationElement]::RootElement
  }
  return [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
}

function Get-Candidates($root, $name, $autoId, $role) {
  $cond = [System.Windows.Automation.Condition]::TrueCondition
  $all  = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
  $out  = @()
  foreach ($el in $all) {
    $info = $el.Current
    if ($autoId -and $info.AutomationId -ne $autoId) { continue }
    if ($name) {
      $exact = ($info.Name -eq $name)
      $sub   = ($info.Name -and ($info.Name.ToLower().Contains($name.ToLower())))
      if (-not $exact -and -not $sub) { continue }
    }
    if ($role -and $info.LocalizedControlType -ne $role) { continue }
    $out += [PSCustomObject]@{
      name          = $info.Name
      automationId  = $info.AutomationId
      role          = $info.LocalizedControlType
      isEnabled     = $info.IsEnabled
      exact         = if ($name) { ($info.Name -eq $name) } else { $false }
    }
  }
  return $out
}
`;

function _scriptList({ scope = 'focused', role } = {}) {
  return `${PS_PRELUDE}
$root = Get-RootElement -scope '${_quote(scope)}'
$els  = Get-Candidates $root $null $null '${_quote(role || '')}'
@{ ok = $true; elements = @($els) } | ConvertTo-Json -Depth 4 -Compress
`;
}

function _scriptFindOne({ scope = 'focused', name, automationId, role } = {}) {
  // Returns a JSON object with ok+target | ambiguous+candidates | error.
  return `${PS_PRELUDE}
$root = Get-RootElement -scope '${_quote(scope)}'
$matches = Get-Candidates $root '${_quote(name || '')}' '${_quote(automationId || '')}' '${_quote(role || '')}'
if (-not $matches -or $matches.Count -eq 0) {
  @{ ok = $false; error = 'not_found' } | ConvertTo-Json -Compress
  exit 0
}
# Prefer exact-name matches when present
$exact = $matches | Where-Object { $_.exact }
if ($exact -and $exact.Count -eq 1) { $matches = @($exact[0]) }
elseif ($exact -and $exact.Count -gt 1) { $matches = $exact }

if ($matches.Count -gt 1) {
  @{ ok = $false; ambiguous = $true; candidates = @($matches) } | ConvertTo-Json -Depth 4 -Compress
  exit 0
}
@{ ok = $true; target = $matches[0] } | ConvertTo-Json -Depth 4 -Compress
`;
}

function _scriptInvoke({ scope = 'focused', name, automationId, role } = {}) {
  return `${PS_PRELUDE}
$root    = Get-RootElement -scope '${_quote(scope)}'
$matches = Get-Candidates $root '${_quote(name || '')}' '${_quote(automationId || '')}' '${_quote(role || '')}'
if (-not $matches -or $matches.Count -eq 0) {
  @{ ok = $false; error = 'not_found' } | ConvertTo-Json -Compress; exit 0
}
$exact = $matches | Where-Object { $_.exact }
if ($exact -and $exact.Count -ge 1) { $matches = @($exact) }
if ($matches.Count -gt 1) {
  @{ ok = $false; ambiguous = $true; candidates = @($matches) } | ConvertTo-Json -Depth 4 -Compress
  exit 0
}
$target = $matches[0]
# Re-locate the live element to invoke it.
$cond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::NameProperty, $target.name)
$el = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
if (-not $el) { @{ ok = $false; error = 'element_lost' } | ConvertTo-Json -Compress; exit 0 }
try {
  $p = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
  $p.Invoke()
  @{ ok = $true; target = $target } | ConvertTo-Json -Depth 4 -Compress
} catch {
  Add-Type -AssemblyName System.Windows.Forms | Out-Null
  try {
    $el.SetFocus()
    [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
    @{ ok = $true; target = $target; method = 'enter_fallback' } | ConvertTo-Json -Depth 4 -Compress
  } catch {
    @{ ok = $false; error = ('click failed: ' + $_.Exception.Message) } | ConvertTo-Json -Compress
  }
}
`;
}

function _scriptFill({ scope = 'focused', name, automationId, value } = {}) {
  return `${PS_PRELUDE}
$root    = Get-RootElement -scope '${_quote(scope)}'
$matches = Get-Candidates $root '${_quote(name || '')}' '${_quote(automationId || '')}' $null
if (-not $matches -or $matches.Count -eq 0) {
  @{ ok = $false; error = 'not_found' } | ConvertTo-Json -Compress; exit 0
}
$exact = $matches | Where-Object { $_.exact }
if ($exact -and $exact.Count -ge 1) { $matches = @($exact) }
if ($matches.Count -gt 1) {
  @{ ok = $false; ambiguous = $true; candidates = @($matches) } | ConvertTo-Json -Depth 4 -Compress
  exit 0
}
$target = $matches[0]
$cond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::NameProperty, $target.name)
$el = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
if (-not $el) { @{ ok = $false; error = 'element_lost' } | ConvertTo-Json -Compress; exit 0 }
try {
  $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
  $vp.SetValue('${_quote(value || '')}')
  @{ ok = $true; target = $target; value = '${_quote(value || '')}' } | ConvertTo-Json -Depth 4 -Compress
} catch {
  @{ ok = $false; error = ('fill failed: ' + $_.Exception.Message) } | ConvertTo-Json -Compress
}
`;
}

function _scriptRead({ scope = 'focused', name, automationId } = {}) {
  return `${PS_PRELUDE}
$root    = Get-RootElement -scope '${_quote(scope)}'
$matches = Get-Candidates $root '${_quote(name || '')}' '${_quote(automationId || '')}' $null
if (-not $matches -or $matches.Count -eq 0) {
  @{ ok = $false; error = 'not_found' } | ConvertTo-Json -Compress; exit 0
}
$exact = $matches | Where-Object { $_.exact }
if ($exact -and $exact.Count -ge 1) { $matches = @($exact) }
if ($matches.Count -gt 1) {
  @{ ok = $false; ambiguous = $true; candidates = @($matches) } | ConvertTo-Json -Depth 4 -Compress
  exit 0
}
$target = $matches[0]
$cond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::NameProperty, $target.name)
$el = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
if (-not $el) { @{ ok = $false; error = 'element_lost' } | ConvertTo-Json -Compress; exit 0 }
$value = $target.name
try {
  $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
  $value = $vp.Current.Value
} catch { }
@{ ok = $true; target = $target; value = $value } | ConvertTo-Json -Depth 4 -Compress
`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Validate that at least one selector is supplied. */
function _requireSelector({ name, automationId }) {
  if (!name && !automationId) {
    return { ok: false, error: 'No element name or automationId provided.', action: '' };
  }
  return null;
}

function _normalizeCandidate(c) {
  if (!c || typeof c !== 'object') return null;
  return {
    name:         c.name || '',
    automationId: c.automationId || '',
    role:         c.role || '',
    isEnabled:    c.isEnabled !== false,
  };
}

/**
 * @param {object} opts
 * @returns {Promise<ToolResult>}
 */
async function listElements(opts = {}) {
  const r = await _runPS(_scriptList(opts), { timeoutMs: 6000 });
  if (!r.ok) return { ok: false, error: r.error || 'PowerShell failed', action: '' };
  const parsed = _parseJsonStdout(r.stdout);
  if (!parsed) return { ok: false, error: 'Invalid UIA response.', action: '' };
  if (parsed.ok === false) return { ok: false, error: parsed.error || 'UIA error', action: '' };
  const elements = (parsed.elements || []).map(_normalizeCandidate).filter(Boolean);
  return {
    ok:     true,
    data:   { elements },
    action: `Found ${elements.length} element${elements.length === 1 ? '' : 's'}.`,
  };
}

async function clickElement(opts = {}) {
  const guard = _requireSelector(opts);
  if (guard) return guard;

  const r = await _runPS(_scriptInvoke(opts), { timeoutMs: 6000 });
  if (!r.ok) return { ok: false, error: r.error || 'PowerShell failed', action: '' };
  const parsed = _parseJsonStdout(r.stdout);
  if (!parsed) return { ok: false, error: 'Invalid UIA response.', action: '' };

  if (parsed.ambiguous && Array.isArray(parsed.candidates)) {
    const candidates = parsed.candidates.map(_normalizeCandidate).filter(Boolean).slice(0, 5);
    const list = candidates.map((c, i) => `${i + 1}. ${c.name}`).join(', ');
    return {
      ok:         false,
      ambiguous:  true,
      candidates,
      action:     `I found ${parsed.candidates.length} controls matching "${opts.name || opts.automationId}". Say one, two, or three: ${list}`,
    };
  }

  if (!parsed.ok) {
    const err = parsed.error === 'not_found'
      ? `No control named "${opts.name || opts.automationId}".`
      : parsed.error || 'Click failed.';
    return { ok: false, error: err, action: '' };
  }

  const t = _normalizeCandidate(parsed.target) || {};
  return {
    ok:     true,
    data:   { target: t, method: parsed.method || 'invoke' },
    action: `Clicked "${t.name}".`,
  };
}

async function fillElement(opts = {}) {
  const guard = _requireSelector(opts);
  if (guard) return guard;
  if (typeof opts.value !== 'string') {
    return { ok: false, error: 'Missing value to fill.', action: '' };
  }

  const r = await _runPS(_scriptFill(opts), { timeoutMs: 6000 });
  if (!r.ok) return { ok: false, error: r.error || 'PowerShell failed', action: '' };
  const parsed = _parseJsonStdout(r.stdout);
  if (!parsed) return { ok: false, error: 'Invalid UIA response.', action: '' };

  if (parsed.ambiguous && Array.isArray(parsed.candidates)) {
    const candidates = parsed.candidates.map(_normalizeCandidate).filter(Boolean).slice(0, 5);
    const list = candidates.map((c, i) => `${i + 1}. ${c.name}`).join(', ');
    return {
      ok:         false,
      ambiguous:  true,
      candidates,
      action:     `I found ${parsed.candidates.length} fields matching "${opts.name || opts.automationId}". Say one, two, or three: ${list}`,
    };
  }

  if (!parsed.ok) {
    const err = parsed.error === 'not_found'
      ? `No field named "${opts.name || opts.automationId}".`
      : parsed.error || 'Fill failed.';
    return { ok: false, error: err, action: '' };
  }

  const t = _normalizeCandidate(parsed.target) || {};
  return {
    ok:     true,
    data:   { target: t, value: parsed.value != null ? parsed.value : opts.value },
    action: `Filled "${t.name}".`,
  };
}

async function readElement(opts = {}) {
  const guard = _requireSelector(opts);
  if (guard) return guard;

  const r = await _runPS(_scriptRead(opts), { timeoutMs: 6000 });
  if (!r.ok) return { ok: false, error: r.error || 'PowerShell failed', action: '' };
  const parsed = _parseJsonStdout(r.stdout);
  if (!parsed) return { ok: false, error: 'Invalid UIA response.', action: '' };

  if (parsed.ambiguous && Array.isArray(parsed.candidates)) {
    const candidates = parsed.candidates.map(_normalizeCandidate).filter(Boolean).slice(0, 5);
    const list = candidates.map((c, i) => `${i + 1}. ${c.name}`).join(', ');
    return {
      ok:         false,
      ambiguous:  true,
      candidates,
      action:     `I found ${parsed.candidates.length} elements matching "${opts.name || opts.automationId}". Say one, two, or three: ${list}`,
    };
  }

  if (!parsed.ok) {
    const err = parsed.error === 'not_found'
      ? `No element named "${opts.name || opts.automationId}".`
      : parsed.error || 'Read failed.';
    return { ok: false, error: err, action: '' };
  }

  const t = _normalizeCandidate(parsed.target) || {};
  const val = parsed.value != null ? String(parsed.value) : '';
  return {
    ok:     true,
    data:   { target: t, value: val },
    action: val ? `"${t.name}" reads: ${val.slice(0, 120)}` : `"${t.name}" is empty.`,
  };
}

module.exports = { listElements, clickElement, fillElement, readElement };
