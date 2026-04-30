# ps-uia.ps1 — Reference UIAutomation helper for the Jarvis M4.6 ui.* tools.
#
# This file is a manually-runnable reference. The actual scripts that run from
# the Jarvis pipeline are inlined in main/jarvis/tools/ui.js so we don't have
# to ship a separate file (asar packaging compatibility).
#
# Usage:
#   powershell.exe -NoProfile -File ps-uia.ps1 -Action list -Scope focused
#   powershell.exe -NoProfile -File ps-uia.ps1 -Action click -Name "Send"
#   powershell.exe -NoProfile -File ps-uia.ps1 -Action fill  -Name "Subject" -Value "hello"
#   powershell.exe -NoProfile -File ps-uia.ps1 -Action read  -Name "Status"
#
# All actions emit a single JSON object on stdout. Errors emit { ok: false, error }.

param(
  [Parameter(Mandatory=$true)]
  [ValidateSet('list','click','fill','read')]
  [string]$Action,

  [ValidateSet('focused','desktop')]
  [string]$Scope = 'focused',

  [string]$Name,
  [string]$AutomationId,
  [string]$Role,
  [string]$Value
)

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

function Get-RootElement([string]$scope) {
  if ($scope -eq 'desktop') {
    return [System.Windows.Automation.AutomationElement]::RootElement
  }
  $hwnd = [System.Windows.Automation.AutomationElement]::FocusedElement.Current.NativeWindowHandle
  if (-not $hwnd) {
    Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();'
    $hwnd = [W.U]::GetForegroundWindow()
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
      if ($info.Name -ne $name -and ($info.Name -notlike "*$name*")) { continue }
    }
    if ($role -and $info.LocalizedControlType -ne $role -and $info.ControlType.LocalizedControlType -ne $role) { continue }
    $out += [PSCustomObject]@{
      name          = $info.Name
      automationId  = $info.AutomationId
      role          = $info.LocalizedControlType
      isEnabled     = $info.IsEnabled
      runtimeId     = ($el.GetRuntimeId() -join ',')
    }
  }
  return $out
}

try {
  $root = Get-RootElement -scope $Scope

  if ($Action -eq 'list') {
    $els = Get-Candidates $root $Name $AutomationId $Role
    @{ ok = $true; elements = @($els) } | ConvertTo-Json -Depth 4 -Compress
    exit 0
  }

  $matches = Get-Candidates $root $Name $AutomationId $Role
  if (-not $matches -or $matches.Count -eq 0) {
    @{ ok = $false; error = 'not_found' } | ConvertTo-Json -Compress
    exit 0
  }

  if ($matches.Count -gt 1) {
    @{ ok = $false; ambiguous = $true; candidates = @($matches) } | ConvertTo-Json -Depth 4 -Compress
    exit 0
  }

  # Re-locate the unique element by AutomationId or runtimeId for the action.
  $target = $matches[0]
  $el = $root.FindFirst(
    [System.Windows.Automation.TreeScope]::Descendants,
    (New-Object System.Windows.Automation.AndCondition(
      (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $target.name)),
      [System.Windows.Automation.Condition]::TrueCondition
    ))
  )
  if (-not $el) {
    @{ ok = $false; error = 'element_lost' } | ConvertTo-Json -Compress
    exit 0
  }

  switch ($Action) {
    'click' {
      try {
        $invoke = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
        $invoke.Invoke()
        @{ ok = $true; target = $target } | ConvertTo-Json -Depth 4 -Compress
      } catch {
        # Fallback: focus + Enter
        try {
          $el.SetFocus()
          [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
          @{ ok = $true; target = $target; method = 'enter_fallback' } | ConvertTo-Json -Depth 4 -Compress
        } catch {
          @{ ok = $false; error = "click failed: $($_.Exception.Message)" } | ConvertTo-Json -Compress
        }
      }
    }
    'fill' {
      try {
        $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
        $vp.SetValue($Value)
        @{ ok = $true; target = $target; value = $Value } | ConvertTo-Json -Depth 4 -Compress
      } catch {
        @{ ok = $false; error = "fill failed: $($_.Exception.Message)" } | ConvertTo-Json -Compress
      }
    }
    'read' {
      try {
        $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
        $val = $vp.Current.Value
        @{ ok = $true; target = $target; value = $val } | ConvertTo-Json -Depth 4 -Compress
      } catch {
        @{ ok = $true; target = $target; value = $target.name } | ConvertTo-Json -Depth 4 -Compress
      }
    }
  }
} catch {
  @{ ok = $false; error = "ps-uia error: $($_.Exception.Message)" } | ConvertTo-Json -Compress
  exit 1
}
