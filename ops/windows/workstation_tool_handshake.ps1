$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function New-WorkstationToolUsagePayload {
    param(
        [Parameter(Mandatory = $true)][string]$ToolId,
        [Parameter(Mandatory = $true)][string]$Purpose,
        [Parameter(Mandatory = $true)][string]$EntryPoint,
        [Parameter(Mandatory = $true)][string]$RunSummary,
        [Parameter(Mandatory = $true)][string]$RunSideEffects,
        [object[]]$Examples = @(),
        [hashtable]$SideEffects = @{},
        [string]$Docs = 'docs/windows-desktop.md'
    )

    [ordered]@{
        schema_version = 'tool_usage.v1'
        tool_id = $ToolId
        purpose = $Purpose
        entrypoint = $EntryPoint
        safe_first_calls = @(
            [ordered]@{ label = 'usage'; cmd = $EntryPoint },
            [ordered]@{ label = 'usage-json'; cmd = "$EntryPoint usage -Format json" },
            [ordered]@{ label = 'help'; cmd = "$EntryPoint run -?" }
        )
        verbs = @(
            [ordered]@{ name = 'usage'; side_effects = 'none'; summary = 'Return this compact usage contract.' },
            [ordered]@{ name = 'run'; side_effects = $RunSideEffects; summary = $RunSummary }
        )
        examples = $Examples
        side_effects = $SideEffects
        docs = $Docs
    }
}

function Write-WorkstationToolUsage {
    param(
        [Parameter(Mandatory = $true)][object]$Payload,
        [ValidateSet('text', 'json')][string]$Format = 'text'
    )

    if ($Format -eq 'json') {
        $Payload | ConvertTo-Json -Depth 8
        return
    }

    Write-Output $Payload.purpose
    Write-Output ''
    Write-Output ("entrypoint: {0}" -f $Payload.entrypoint)
    Write-Output ''
    Write-Output 'safe first calls:'
    foreach ($item in $Payload.safe_first_calls) {
        Write-Output ("  {0}: {1}" -f $item.label, $item.cmd)
    }
    Write-Output ''
    Write-Output 'verbs:'
    foreach ($item in $Payload.verbs) {
        Write-Output ("  {0}: {1} [{2}]" -f $item.name, $item.summary, $item.side_effects)
    }
    Write-Output ''
    Write-Output 'examples:'
    foreach ($item in $Payload.examples) {
        Write-Output ("  {0}: {1}" -f $item.label, $item.cmd)
    }
    Write-Output ''
    Write-Output 'side effects:'
    foreach ($key in $Payload.side_effects.Keys) {
        $value = $Payload.side_effects[$key]
        if ($value -is [System.Array]) {
            $value = ($value -join ', ')
        }
        Write-Output ("  {0}: {1}" -f $key, $value)
    }
    Write-Output ''
    Write-Output ("docs: {0}" -f $Payload.docs)
}
