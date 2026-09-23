param(
  [Parameter(Mandatory = $true)]
  [string]$Url,

  [int]$PendingCount = 0,

  [string]$WindowTitlePattern = "Protocol Runner Gate",

  [string]$RepoRoot = ""
)

$ErrorActionPreference = "SilentlyContinue"

function Add-WindowApi {
  if ("WorkstationControlWindowApi" -as [type]) {
    return
  }

  Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class WorkstationControlWindowApi
{
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(
        IntPtr hWnd,
        IntPtr hWndInsertAfter,
        int X,
        int Y,
        int cx,
        int cy,
        UInt32 uFlags);
}
"@
}

function Find-ProtocolRunnerWindow {
  param([string]$Pattern)

  $matches = Get-Process |
    Where-Object {
      $_.MainWindowHandle -ne 0 -and
      -not [string]::IsNullOrWhiteSpace($_.MainWindowTitle) -and
      $_.MainWindowTitle -like "*$Pattern*"
    } |
    Sort-Object StartTime -Descending

  return $matches | Select-Object -First 1
}

function Resolve-RepoRoot {
  param([string]$RequestedRoot)

  if (-not [string]::IsNullOrWhiteSpace($RequestedRoot)) {
    return (Resolve-Path -LiteralPath $RequestedRoot).Path
  }

  return (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..")).Path
}

function Test-RendererAvailable {
  param([string]$RequestedUrl)

  try {
    $uri = [System.Uri]$RequestedUrl
    $base = "{0}://{1}:{2}/" -f $uri.Scheme, $uri.Host, $uri.Port
    $response = Invoke-WebRequest -Uri $base -UseBasicParsing -TimeoutSec 2
    return ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500)
  } catch {
    return $false
  }
}

function Resolve-AppFlagFromUrl {
  param([string]$RequestedUrl)

  try {
    $uri = [System.Uri]$RequestedUrl
    $query = $uri.Query.TrimStart("?").ToLowerInvariant()
    $pairs = $query -split "&"
    if ($pairs -contains "notify=1") {
      return "--notify"
    }
    if ($pairs -contains "gate=1") {
      return "--gate"
    }
  } catch {
    return "--gate"
  }

  return ""
}

function Start-ProtocolRunnerApp {
  param(
    [string]$Root,
    [string]$ModeFlag
  )

  $appCwd = Join-Path $Root "apps\protocol-runner-ui"
  $appMain = Join-Path $appCwd "electron\main.cjs"
  $electronCmd = Join-Path $Root "node_modules\.bin\electron.cmd"
  $electronArgs = @($appMain)
  if (-not [string]::IsNullOrWhiteSpace($ModeFlag)) {
    $electronArgs += $ModeFlag
  }

  if (Test-Path -LiteralPath $electronCmd) {
    Start-Process `
      -FilePath $electronCmd `
      -ArgumentList $electronArgs `
      -WorkingDirectory $appCwd `
      -WindowStyle Hidden
    return
  }

  $pnpmArgs = @(
    "--workspace-root",
    "--filter",
    "@workstation-control/protocol-runner-ui",
    "exec",
    "electron",
    "electron/main.cjs"
  )
  if (-not [string]::IsNullOrWhiteSpace($ModeFlag)) {
    $pnpmArgs += $ModeFlag
  }

  Start-Process `
    -FilePath "pnpm.cmd" `
    -ArgumentList $pnpmArgs `
    -WorkingDirectory $Root `
    -WindowStyle Hidden
}

Add-WindowApi
$resolvedRepoRoot = Resolve-RepoRoot -RequestedRoot $RepoRoot
$modeFlag = Resolve-AppFlagFromUrl -RequestedUrl $Url

$target = Find-ProtocolRunnerWindow -Pattern $WindowTitlePattern
if ($null -eq $target) {
  if (-not (Test-RendererAvailable -RequestedUrl $Url)) {
    Write-Warning "Start the Protocol Runner dashboard before requesting its operator gate."
    exit 1
  }
  Start-ProtocolRunnerApp -Root $resolvedRepoRoot -ModeFlag $modeFlag
}

$deadline = (Get-Date).AddSeconds(10)
while ((Get-Date) -lt $deadline) {
  $target = Find-ProtocolRunnerWindow -Pattern $WindowTitlePattern
  if ($null -ne $target) {
    break
  }
  Start-Sleep -Milliseconds 250
}

if ($null -eq $target -or $target.MainWindowHandle -eq 0) {
  exit 0
}

$handle = [System.IntPtr]$target.MainWindowHandle
$swRestore = 9
$hwndTopmost = [System.IntPtr](-1)
$hwndNotTopmost = [System.IntPtr](-2)
$swpNoMove = 0x0002
$swpNoSize = 0x0001
$swpShowWindow = 0x0040
$flags = $swpNoMove -bor $swpNoSize -bor $swpShowWindow

[WorkstationControlWindowApi]::ShowWindowAsync($handle, $swRestore) | Out-Null
[WorkstationControlWindowApi]::SetWindowPos($handle, $hwndTopmost, 0, 0, 0, 0, $flags) | Out-Null
Start-Sleep -Milliseconds 200
[WorkstationControlWindowApi]::SetForegroundWindow($handle) | Out-Null
[WorkstationControlWindowApi]::SetWindowPos($handle, $hwndNotTopmost, 0, 0, 0, 0, $flags) | Out-Null

exit 0
