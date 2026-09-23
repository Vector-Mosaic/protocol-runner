[CmdletBinding()]
param(
    [ValidateSet('auto-command', 'usage', 'run')]
    [string]$Command = 'auto-command',
    [ValidateSet('text', 'json')]
    [string]$Format = 'text',
    [ValidateSet('state', 'select', 'prompt', 'create', 'readback')]
    [string]$Action = 'state',
    [ValidateSet('auto', 'focus')]
    [string]$Mode = 'focus',
    [string]$WindowTitle = 'Codex',
    [string]$ThreadTitle = '',
    [string]$Text = '',
    [string]$TextFile = '',
    [int]$MaxShowMoreClicks = 16,
    [switch]$OmitTranscript,
    [switch]$AllowDirectDesktopControl,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot 'workstation_tool_handshake.ps1')

$entrypoint = 'powershell -NoProfile -ExecutionPolicy Bypass -File ops/windows/invoke_codex_desktop_action.ps1'
$usagePayload = New-WorkstationToolUsagePayload `
    -ToolId 'tool.system.workstation_control.invoke_codex_desktop_action' `
    -Purpose 'Invoke a Codex desktop UI Automation action and emit a compact JSON result.' `
    -EntryPoint $entrypoint `
    -RunSummary 'Run a desktop action: state, select, prompt, create, or readback.' `
    -RunSideEffects 'state/readback inspect UI; select/prompt/create can focus Codex, select threads, fill compose text, submit prompts, or create threads' `
    -Examples @(
        [ordered]@{ label = 'dry run'; cmd = "$entrypoint run -Action state -DryRun" },
        [ordered]@{ label = 'state'; cmd = "$entrypoint run -Action state" },
        [ordered]@{ label = 'prompt through codex-desktop-api'; cmd = "POST /api/codex-desktop/prompt" },
        [ordered]@{ label = 'direct gated helper bypass'; cmd = "$entrypoint run -Action prompt -ThreadTitle <title> -TextFile <path> -AllowDirectDesktopControl" }
    ) `
    -SideEffects @{
        writes_repo = $false
        desktop_access = 'reads and can manipulate Codex desktop UI Automation controls'
        optional_mutations = @('select thread', 'send prompt', 'create new thread')
        network_access = 'none directly; Codex desktop may perform its own model/network work after prompt submission'
        danger_level = 'high'
        supports_dry_run = $true
    }

$domainParameterBound = (
    $PSBoundParameters.ContainsKey('Action') -or
    $PSBoundParameters.ContainsKey('Mode') -or
    $PSBoundParameters.ContainsKey('WindowTitle') -or
    $PSBoundParameters.ContainsKey('ThreadTitle') -or
    $PSBoundParameters.ContainsKey('Text') -or
    $PSBoundParameters.ContainsKey('TextFile') -or
    $PSBoundParameters.ContainsKey('MaxShowMoreClicks') -or
    $PSBoundParameters.ContainsKey('OmitTranscript') -or
    $PSBoundParameters.ContainsKey('AllowDirectDesktopControl') -or
    $PSBoundParameters.ContainsKey('DryRun')
)
if ($Command -eq 'usage' -or ($Command -eq 'auto-command' -and -not $domainParameterBound)) {
    Write-WorkstationToolUsage -Payload $usagePayload -Format $Format
    exit 0
}
if ($DryRun) {
    Write-Output 'status=preview'
    Write-Output ("action={0}" -f $Action)
    Write-Output ("mode={0}" -f $Mode)
    Write-Output ("window_title={0}" -f $WindowTitle)
    Write-Output ("thread_title={0}" -f $ThreadTitle)
    Write-Output ("text_source={0}" -f $(if ([string]::IsNullOrWhiteSpace($TextFile)) { $(if ([string]::IsNullOrWhiteSpace($Text)) { '<none>' } else { '<inline>' }) } else { $TextFile }))
    Write-Output 'would_read_desktop_uia=true'
    Write-Output ("would_manipulate_desktop={0}" -f ($Action -in @('select', 'prompt', 'create')))
    Write-Output ("direct_desktop_control_allowed={0}" -f ([bool]$AllowDirectDesktopControl))
    exit 0
}

$mutatingAction = $Action -in @('select', 'prompt', 'create')
if ($mutatingAction -and -not $AllowDirectDesktopControl) {
    $blockedPayload = [ordered]@{
        result = 'unsupported'
        message = 'Direct Codex Desktop mutation is blocked. Use codex-desktop-api so the shared operator gate and action queue own desktop control, or pass -AllowDirectDesktopControl for an explicit diagnostic bypass.'
        action = $Action
        requiresCodexDesktopApi = $true
        directDesktopControlAllowed = $false
    }
    Write-Output ($blockedPayload | ConvertTo-Json -Compress -Depth 8)
    exit 2
}

. (Join-Path $PSScriptRoot 'codex_desktop_uia_helper.ps1')

function Clear-TranscriptFields {
    param([object]$Payload)

    if ($Payload -is [System.Collections.IDictionary]) {
        if ($Payload.Contains('visibleTranscriptLines')) {
            $Payload['visibleTranscriptLines'] = @()
        }
        if ($Payload.Contains('visibleTranscriptText')) {
            $Payload['visibleTranscriptText'] = ''
        }
        if ($Payload.Contains('selectedSidebarThreadTitle') -and
            $Payload.Contains('selectedSidebarThreadTitles') -and
            @($Payload['selectedSidebarThreadTitles']).Count -eq 0) {
            $Payload['selectedSidebarThreadTitle'] = $null
        }
    }

    return $Payload
}

function Convert-StringForFallbackJson {
    param([string]$Value)

    if ($null -eq $Value) {
        return $null
    }

    return $Value.Replace('"', [char]0x201d)
}

function Convert-PayloadForFallbackJson {
    param([object]$Value)

    if ($null -eq $Value) {
        return $null
    }

    if ($Value -is [string]) {
        return Convert-StringForFallbackJson -Value $Value
    }

    if ($Value -is [System.Collections.IDictionary]) {
        $copy = [ordered]@{}
        foreach ($key in $Value.Keys) {
            $copy[[string]$key] = Convert-PayloadForFallbackJson -Value $Value[$key]
        }
        return ,$copy
    }

    if ($Value -is [System.Collections.IEnumerable]) {
        $items = @()
        foreach ($item in $Value) {
            $items += ,(Convert-PayloadForFallbackJson -Value $item)
        }
        return $items
    }

    if ($Value -is [pscustomobject]) {
        $copy = [ordered]@{}
        foreach ($property in $Value.PSObject.Properties) {
            $copy[$property.Name] = Convert-PayloadForFallbackJson -Value $property.Value
        }
        return ,$copy
    }

    return $Value
}

function Convert-PayloadForJsonSerialization {
    param(
        [object]$Value,
        [switch]$SanitizeStrings
    )

    if ($null -eq $Value) {
        return $null
    }

    if ($Value -is [string]) {
        if ($SanitizeStrings) {
            return Convert-StringForFallbackJson -Value $Value
        }
        return $Value
    }

    if ($Value -is [bool] -or
        $Value -is [byte] -or
        $Value -is [int16] -or
        $Value -is [int] -or
        $Value -is [int64] -or
        $Value -is [single] -or
        $Value -is [double] -or
        $Value -is [decimal]) {
        return $Value
    }

    if ($Value -is [System.Collections.IDictionary]) {
        $copy = [ordered]@{}
        foreach ($key in $Value.Keys) {
            $copy[[string]$key] = Convert-PayloadForJsonSerialization -Value $Value[$key] -SanitizeStrings:$SanitizeStrings
        }
        return ,$copy
    }

    if ($Value -is [System.Management.Automation.PSCustomObject]) {
        $copy = [ordered]@{}
        foreach ($property in $Value.PSObject.Properties) {
            if ($property.MemberType -notin @('NoteProperty', 'AliasProperty', 'ScriptProperty', 'Property')) {
                continue
            }
            $copy[$property.Name] = Convert-PayloadForJsonSerialization -Value $property.Value -SanitizeStrings:$SanitizeStrings
        }
        return ,$copy
    }

    if ($Value -is [System.Collections.IEnumerable]) {
        $items = @()
        foreach ($item in $Value) {
            $items += ,(Convert-PayloadForJsonSerialization -Value $item -SanitizeStrings:$SanitizeStrings)
        }
        return ,$items
    }

    $stringValue = [string]$Value
    if ($SanitizeStrings) {
        return Convert-StringForFallbackJson -Value $stringValue
    }
    return $stringValue
}

function ConvertTo-HelperJsonLine {
    param([object]$Payload)

    try {
        Add-Type -AssemblyName System.Web.Extensions
        $serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
        $serializer.MaxJsonLength = 10485760
        $simplePayload = Convert-PayloadForJsonSerialization -Value $Payload -SanitizeStrings
        return $serializer.Serialize($simplePayload)
    } catch {
        $fallbackPayload = Convert-PayloadForJsonSerialization -Value $Payload -SanitizeStrings
        Add-Type -AssemblyName System.Web.Extensions
        $serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
        $serializer.MaxJsonLength = 10485760
        return $serializer.Serialize($fallbackPayload)
    }
}

try {
    $resolvedText = $Text
    if (-not [string]::IsNullOrWhiteSpace($TextFile)) {
        $resolvedText = Get-Content -LiteralPath $TextFile -Raw
    }

    $payload = switch ($Action) {
        'state' { Invoke-CodexDesktopStateAction -WindowTitle $WindowTitle }
        'select' { Invoke-CodexDesktopSyncAction -Mode $Mode -WindowTitle $WindowTitle -ThreadTitle $ThreadTitle -Reason 'select' -MaxShowMoreClicks $MaxShowMoreClicks }
        'prompt' { Invoke-CodexDesktopPromptAction -Mode $Mode -WindowTitle $WindowTitle -ThreadTitle $ThreadTitle -Text $resolvedText -MaxShowMoreClicks $MaxShowMoreClicks }
        'create' { Invoke-CodexDesktopCreateThreadAction -Mode $Mode -WindowTitle $WindowTitle -Text $resolvedText }
        'readback' { Invoke-CodexDesktopReadbackAction -WindowTitle $WindowTitle -ExpectedThreadTitle $ThreadTitle }
    }

    if ($OmitTranscript) {
        $payload = Clear-TranscriptFields -Payload $payload
    }

    Write-Output (ConvertTo-HelperJsonLine -Payload $payload)
    exit 0
} catch {
    Write-Output (ConvertTo-HelperJsonLine -Payload ([ordered]@{
            result = 'error'
            message = $_.Exception.Message
            scriptStackTrace = $_.ScriptStackTrace
        }))
    exit 1
}
