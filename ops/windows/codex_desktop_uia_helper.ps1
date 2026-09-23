$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class WorkstationControlDesktopSyncNative {
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int X, int Y);

    [DllImport("user32.dll")]
    public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);

    [DllImport("user32.dll")]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
"@

$MouseEventLeftDown = 0x0002
$MouseEventLeftUp = 0x0004
$KeyEventKeyUp = 0x0002
$VirtualKeyControl = 0x11
$VirtualKeyA = 0x41
$VirtualKeyV = 0x56
$VirtualKeyBackspace = 0x08
$VirtualKeyEnter = 0x0D
$VirtualKeyEnd = 0x23
$ShowWindowRestore = 9

function Write-JsonResult {
    param(
        [Parameter(Mandatory = $true)][string]$Result,
        [string]$Message = $null,
        [hashtable]$Extra = @{}
    )

    $payload = [ordered]@{
        result = $Result
        message = $Message
    }

    foreach ($entry in $Extra.GetEnumerator()) {
        $payload[$entry.Key] = $entry.Value
    }

    $payload | ConvertTo-Json -Compress
}

function Get-CodexWindow {
    param([string]$ExpectedTitle)

    $processes = Get-Process | Where-Object {
        $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -and $_.ProcessName -eq 'Codex'
    }

    $exact = $processes | Where-Object { $_.MainWindowTitle -eq $ExpectedTitle } | Select-Object -First 1
    if ($exact) {
        return $exact
    }

    return $processes | Where-Object { $_.MainWindowTitle -like "*$ExpectedTitle*" } | Select-Object -First 1
}

function Get-RootElement {
    param([System.Diagnostics.Process]$WindowProcess)

    if (-not $WindowProcess -or $WindowProcess.MainWindowHandle -eq 0) {
        return $null
    }

    return [System.Windows.Automation.AutomationElement]::FromHandle($WindowProcess.MainWindowHandle)
}

function Get-DescendantsByType {
    param(
        [System.Windows.Automation.AutomationElement]$Root,
        [System.Windows.Automation.ControlType]$ControlType
    )

    $condition = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        $ControlType
    )
    $matches = $Root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
    if ($null -eq $matches) {
        return @()
    }

    return @($matches)
}

function Convert-NumberForDiagnostics {
    param([double]$Value)

    if ([double]::IsNaN($Value) -or [double]::IsInfinity($Value)) {
        return $null
    }

    return [Math]::Round($Value, 2)
}

function Convert-RectForDiagnostics {
    param([System.Windows.Rect]$Rect)

    return [ordered]@{
        left = Convert-NumberForDiagnostics $Rect.Left
        top = Convert-NumberForDiagnostics $Rect.Top
        right = Convert-NumberForDiagnostics $Rect.Right
        bottom = Convert-NumberForDiagnostics $Rect.Bottom
        width = Convert-NumberForDiagnostics $Rect.Width
        height = Convert-NumberForDiagnostics $Rect.Height
    }
}

function Limit-DiagnosticText {
    param([string]$Text)

    $normalized = Normalize-Whitespace $Text
    if ($normalized.Length -le 120) {
        return $normalized
    }

    return $normalized.Substring(0, 120)
}

function Add-ComposeProbeRejection {
    param(
        [object]$Diagnostics,
        [string]$Kind,
        [System.Windows.Automation.AutomationElement]$Element,
        [string]$Reason
    )

    if (-not $Diagnostics) {
        return
    }

    if (-not $Diagnostics.rejectedReasons.Contains($Reason)) {
        $Diagnostics.rejectedReasons[$Reason] = 0
    }
    $Diagnostics.rejectedReasons[$Reason] = [int]$Diagnostics.rejectedReasons[$Reason] + 1

    if (@($Diagnostics.rejectedSamples).Count -ge 8) {
        return
    }

    $Diagnostics.rejectedSamples += [ordered]@{
        kind = $Kind
        reason = $Reason
        className = Limit-DiagnosticText $Element.Current.ClassName
        name = Limit-DiagnosticText $Element.Current.Name
        rectangle = Convert-RectForDiagnostics $Element.Current.BoundingRectangle
    }
}

function Add-ComposeProbeAccepted {
    param(
        [object]$Diagnostics,
        [string]$Kind,
        [System.Windows.Automation.AutomationElement]$Element
    )

    if (-not $Diagnostics -or @($Diagnostics.acceptedSamples).Count -ge 8) {
        return
    }

    $Diagnostics.acceptedSamples += [ordered]@{
        kind = $Kind
        className = Limit-DiagnosticText $Element.Current.ClassName
        name = Limit-DiagnosticText $Element.Current.Name
        rectangle = Convert-RectForDiagnostics $Element.Current.BoundingRectangle
    }
}

function Test-FiniteNumber {
    param([double]$Value)

    return (-not [double]::IsNaN($Value)) -and (-not [double]::IsInfinity($Value))
}

function Test-UsableRectangle {
    param([System.Windows.Rect]$Rect)

    return (
        (Test-FiniteNumber -Value $Rect.Left) -and
        (Test-FiniteNumber -Value $Rect.Top) -and
        (Test-FiniteNumber -Value $Rect.Width) -and
        (Test-FiniteNumber -Value $Rect.Height) -and
        (Test-FiniteNumber -Value $Rect.Right) -and
        (Test-FiniteNumber -Value $Rect.Bottom) -and
        $Rect.Width -gt 0 -and
        $Rect.Height -gt 0 -and
        $Rect.Right -gt $Rect.Left -and
        $Rect.Bottom -gt $Rect.Top -and
        $Rect.Left -gt -20000 -and
        $Rect.Top -gt -20000
    )
}

function Get-FallbackScreenRectangle {
    $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
    return New-Object System.Windows.Rect -ArgumentList ([double]$bounds.X), ([double]$bounds.Y), ([double]$bounds.Width), ([double]$bounds.Height)
}

function Test-PointWithinVirtualScreen {
    param([System.Windows.Point]$Point)

    if (-not (Test-FiniteNumber -Value $Point.X) -or -not (Test-FiniteNumber -Value $Point.Y)) {
        return $false
    }

    $screen = Get-FallbackScreenRectangle
    return (
        $Point.X -ge $screen.Left -and
        $Point.X -le $screen.Right -and
        $Point.Y -ge $screen.Top -and
        $Point.Y -le $screen.Bottom
    )
}

function Add-VisibleRectangleClickPoints {
    param(
        [System.Collections.Generic.List[System.Windows.Point]]$Points,
        [System.Windows.Rect]$Rect,
        [switch]$PreferLeftBiasedPoint
    )

    if (-not (Test-UsableRectangle -Rect $Rect)) {
        return
    }

    $screen = Get-FallbackScreenRectangle
    $left = [Math]::Max($Rect.Left, $screen.Left)
    $right = [Math]::Min($Rect.Right, $screen.Right)
    $top = [Math]::Max($Rect.Top, $screen.Top)
    $bottom = [Math]::Min($Rect.Bottom, $screen.Bottom)
    $width = $right - $left
    $height = $bottom - $top
    if ($width -le 0 -or $height -le 0) {
        return
    }

    $leftBiased = New-Object System.Windows.Point(($left + [Math]::Min(110, ($width / 3))), ($top + ($height / 2)))
    $centerPoint = New-Object System.Windows.Point(($left + ($width / 2)), ($top + ($height / 2)))
    if ($PreferLeftBiasedPoint) {
        [void]$Points.Add($leftBiased)
        [void]$Points.Add($centerPoint)
    } else {
        [void]$Points.Add($centerPoint)
        [void]$Points.Add($leftBiased)
    }
}

function Get-EffectiveRootRectangle {
    param([System.Windows.Automation.AutomationElement]$Root)

    $rootRect = $Root.Current.BoundingRectangle
    if (Test-UsableRectangle -Rect $rootRect) {
        return $rootRect
    }

    $documents = @(Get-DescendantsByType -Root $Root -ControlType ([System.Windows.Automation.ControlType]::Document))
    for ($index = 0; $index -lt $documents.Count; $index += 1) {
        $documentRect = $documents.Item($index).Current.BoundingRectangle
        if (Test-UsableRectangle -Rect $documentRect) {
            return $documentRect
        }
    }

    return Get-FallbackScreenRectangle
}

function Get-SidebarLayoutLimits {
    param([System.Windows.Automation.AutomationElement]$Root)

    $rootRect = Get-EffectiveRootRectangle -Root $Root
    return [pscustomobject]@{
        RootRect = $rootRect
        SidebarRightLimit = $rootRect.Left + ($rootRect.Width * 0.45)
        SidebarWidthLimit = $rootRect.Width * 0.4
    }
}

function Send-VirtualKey {
    param([byte]$VirtualKey)

    [WorkstationControlDesktopSyncNative]::keybd_event($VirtualKey, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 25
    [WorkstationControlDesktopSyncNative]::keybd_event($VirtualKey, 0, $KeyEventKeyUp, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 80
}

function Send-ControlChord {
    param([byte]$VirtualKey)

    [WorkstationControlDesktopSyncNative]::keybd_event($VirtualKeyControl, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 25
    [WorkstationControlDesktopSyncNative]::keybd_event($VirtualKey, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 25
    [WorkstationControlDesktopSyncNative]::keybd_event($VirtualKey, 0, $KeyEventKeyUp, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 25
    [WorkstationControlDesktopSyncNative]::keybd_event($VirtualKeyControl, 0, $KeyEventKeyUp, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 100
}

function Get-ThreadItems {
    param([System.Windows.Automation.AutomationElement]$Root)

    $items = @(Get-DescendantsByType -Root $Root -ControlType ([System.Windows.Automation.ControlType]::ListItem))
    $visible = New-Object System.Collections.Generic.List[System.Windows.Automation.AutomationElement]
    $layout = Get-SidebarLayoutLimits -Root $Root

    for ($index = 0; $index -lt $items.Count; $index += 1) {
        $item = $items.Item($index)
        $name = $item.Current.Name
        $rect = $item.Current.BoundingRectangle
        if (-not [string]::IsNullOrWhiteSpace($name) -and
            (Test-UsableRectangle -Rect $rect) -and
            $rect.Left -lt $layout.SidebarRightLimit -and
            $rect.Width -lt $layout.SidebarWidthLimit) {
            [void]$visible.Add($item)
        }
    }

    return $visible
}

function Get-ShowMoreButton {
    param([System.Windows.Automation.AutomationElement]$Root)

    $buttons = @(Get-DescendantsByType -Root $Root -ControlType ([System.Windows.Automation.ControlType]::Button))
    for ($index = 0; $index -lt $buttons.Count; $index += 1) {
        $button = $buttons.Item($index)
        if ($button.Current.Name -eq 'Show more') {
            return $button
        }
    }

    return $null
}

function Get-ShowSidebarButton {
    param([System.Windows.Automation.AutomationElement]$Root)

    $buttons = @(Get-DescendantsByType -Root $Root -ControlType ([System.Windows.Automation.ControlType]::Button))
    for ($index = 0; $index -lt $buttons.Count; $index += 1) {
        $button = $buttons.Item($index)
        if ($button.Current.Name -eq 'Show sidebar') {
            return $button
        }
    }

    return $null
}

function Invoke-AutomationButton {
    param([System.Windows.Automation.AutomationElement]$Button)

    if (-not $Button) {
        return $false
    }

    try {
        $pattern = $Button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
        $pattern.Invoke()
        return $true
    } catch {
        return $false
    }
}

function Expand-CodexSidebarIfCollapsed {
    param([System.Windows.Automation.AutomationElement]$Root)

    $showSidebar = Get-ShowSidebarButton -Root $Root
    if (-not $showSidebar) {
        return $false
    }

    if (-not (Invoke-AutomationButton -Button $showSidebar)) {
        return $false
    }

    Start-Sleep -Milliseconds 320
    return $true
}

function Normalize-Whitespace {
    param([string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return ''
    }

    return ([regex]::Replace($Value.Trim(), '\s+', ' ')).
        Replace([char]34, [char]39).
        Replace([char]0x201c, [char]39).
        Replace([char]0x201d, [char]39)
}

function Normalize-ThreadTitleForComparison {
    param([string]$Value)

    $normalized = Normalize-Whitespace $Value
    if ([string]::IsNullOrWhiteSpace($normalized)) {
        return ''
    }

    $decomposed = $normalized.Normalize([System.Text.NormalizationForm]::FormD)
    $builder = New-Object System.Text.StringBuilder
    foreach ($character in $decomposed.ToCharArray()) {
        $category = [System.Globalization.CharUnicodeInfo]::GetUnicodeCategory($character)
        if ($category -ne [System.Globalization.UnicodeCategory]::NonSpacingMark) {
            [void]$builder.Append($character)
        }
    }

    return $builder.ToString().Normalize([System.Text.NormalizationForm]::FormC)
}

function Get-RelativeAgeSuffix {
    param([string]$Value)

    $normalized = Normalize-Whitespace $Value
    if ([string]::IsNullOrWhiteSpace($normalized)) {
        return $null
    }

    $match = [regex]::Match($normalized, '^(.*?)(?:\s*)(\d+(?:mo|[mhdwy]))$', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if (-not $match.Success) {
        return $null
    }

    return [pscustomobject]@{
        Label = (Normalize-Whitespace $match.Groups[1].Value)
        Suffix = $match.Groups[2].Value
    }
}

function Test-RowClassLooksStrictSelected {
    param([string]$ClassName)

    $normalized = Normalize-Whitespace $ClassName
    if ([string]::IsNullOrWhiteSpace($normalized)) {
        return $false
    }

    return [regex]::IsMatch(
        $normalized,
        '(^|\s)bg-token-list-active-selection-background($|\s)'
    )
}

function Get-ThreadEntryVisibleLabel {
    param([object]$Entry)

    $title = Normalize-Whitespace $Entry.Title
    $rowName = ''
    if ($Entry.RowButton) {
        $rowName = Normalize-Whitespace $Entry.RowButton.Current.Name
    } elseif ($Entry.Item) {
        $rowName = $title
    }

    $titleAge = Get-RelativeAgeSuffix -Value $title
    $rowAge = Get-RelativeAgeSuffix -Value $rowName
    if ($rowAge -and $title.EndsWith($rowAge.Suffix, [System.StringComparison]::OrdinalIgnoreCase)) {
        return (Normalize-Whitespace $title.Substring(0, $title.Length - $rowAge.Suffix.Length))
    }
    if ($titleAge -and -not [string]::IsNullOrWhiteSpace($titleAge.Label)) {
        return $titleAge.Label
    }

    return $title
}

function Normalize-ThreadVisibleLabelForComparison {
    param([string]$Value)

    $age = Get-RelativeAgeSuffix -Value $Value
    if ($age -and -not [string]::IsNullOrWhiteSpace($age.Label)) {
        return Normalize-ThreadTitleForComparison $age.Label
    }

    return Normalize-ThreadTitleForComparison $Value
}

function Test-ThreadVisibleLabelEquals {
    param(
        [string]$ObservedLabel,
        [string]$ExpectedLabel
    )

    $observed = Normalize-ThreadVisibleLabelForComparison $ObservedLabel
    $expected = Normalize-ThreadVisibleLabelForComparison $ExpectedLabel

    if ([string]::IsNullOrWhiteSpace($observed) -or [string]::IsNullOrWhiteSpace($expected)) {
        return $false
    }

    return [string]::Equals($observed, $expected, [System.StringComparison]::OrdinalIgnoreCase)
}

function Test-SidebarRowButtonName {
    param([string]$Name)

    $normalized = Normalize-Whitespace $Name
    if ([string]::IsNullOrWhiteSpace($normalized)) {
        return $false
    }

    return (
        $normalized.IndexOf('Archive chat', [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -or
        $normalized.IndexOf('Archive thread', [System.StringComparison]::OrdinalIgnoreCase) -ge 0
    )
}

function Convert-ThreadEntryToSidebarRowPayload {
    param(
        [object]$Entry,
        [string]$CurrentThreadTitle = ''
    )

    $title = Normalize-Whitespace $Entry.Title
    $rowName = ''
    $rowClassName = ''
    if ($Entry.RowButton) {
        $rowName = Normalize-Whitespace $Entry.RowButton.Current.Name
        $rowClassName = Normalize-Whitespace $Entry.RowButton.Current.ClassName
    } elseif ($Entry.Item) {
        $rowName = $title
        $rowClassName = Normalize-Whitespace $Entry.Item.Current.ClassName
    }

    $itemClassName = ''
    if ($Entry.Item) {
        $itemClassName = Normalize-Whitespace $Entry.Item.Current.ClassName
    }

    $rowAge = Get-RelativeAgeSuffix -Value $rowName
    $titleAge = Get-RelativeAgeSuffix -Value $title
    $label = Get-ThreadEntryVisibleLabel -Entry $Entry
    $indicatorText = if ($rowAge) { $rowAge.Suffix } elseif ($titleAge) { $titleAge.Suffix } else { $null }
    $isProjectOrSectionRow = $itemClassName.Contains('group/cwd')
    $isThreadRow = (
        -not [string]::IsNullOrWhiteSpace($label) -and
        -not ($label -match '^(Show more|Show less)$') -and
        -not $isProjectOrSectionRow -and
        ($null -ne $Entry.RowButton -or $null -ne $Entry.Item)
    )
    $currentTitle = Normalize-Whitespace $CurrentThreadTitle
    $isLikelyCurrentThread = (
        $isThreadRow -and
        -not [string]::IsNullOrWhiteSpace($currentTitle) -and
        (Test-ThreadVisibleLabelEquals -ObservedLabel $label -ExpectedLabel $currentTitle)
    )
    $isPinnedThreadRow = $rowName.IndexOf('Unpin chat', [System.StringComparison]::OrdinalIgnoreCase) -ge 0

    $turnState = 'unknown'
    $indicatorReason = 'not_a_thread_row'
    if ($isThreadRow -and -not [string]::IsNullOrWhiteSpace($indicatorText)) {
        $turnState = 'idle'
        $indicatorReason = 'relative_age_indicator'
    } elseif ($isLikelyCurrentThread) {
        $turnState = 'unknown'
        $indicatorReason = 'current_thread_without_indicator_text'
    } elseif ($isThreadRow -and $Entry.IsSelected) {
        $turnState = 'unknown'
        $indicatorReason = 'active_row_without_indicator_text'
    } elseif ($isThreadRow -and $isPinnedThreadRow) {
        $turnState = 'working'
        $indicatorReason = 'sidebar_context_progress_indicator_likely'
    } elseif ($isThreadRow) {
        $turnState = 'unknown'
        $indicatorReason = 'non_pinned_row_without_indicator_text'
    }

    return [ordered]@{
        title = $title
        label = $label
        rowName = $rowName
        rowClassName = $rowClassName
        itemClassName = $itemClassName
        isSelected = [bool]$Entry.IsSelected
        isLikelyCurrentThread = [bool]$isLikelyCurrentThread
        isPinnedThreadRow = [bool]$isPinnedThreadRow
        isThreadRow = [bool]$isThreadRow
        indicatorText = $indicatorText
        turnState = $turnState
        indicatorReason = $indicatorReason
    }
}

function Get-VisibleSidebarThreadRows {
    param(
        [object[]]$Entries,
        [string]$CurrentThreadTitle = ''
    )

    return @(
        @($Entries) |
            Where-Object { $null -ne $_.RowButton -or $null -ne $_.Item } |
            ForEach-Object { Convert-ThreadEntryToSidebarRowPayload -Entry $_ -CurrentThreadTitle $CurrentThreadTitle } |
            Where-Object { $_.isThreadRow }
    )
}

function Find-MatchingThreadEntries {
    param(
        [object[]]$Entries,
        [string]$ExpectedTitle
    )

    $matches = @()
    $needle = Normalize-ThreadVisibleLabelForComparison $ExpectedTitle

    foreach ($entry in @($Entries)) {
        $name = Normalize-ThreadVisibleLabelForComparison (Get-ThreadEntryVisibleLabel -Entry $entry)
        if (-not [string]::IsNullOrWhiteSpace($name) -and
            [string]::Equals($name, $needle, [System.StringComparison]::OrdinalIgnoreCase)) {
            $matches += $entry
        }
    }

    return @($matches)
}

function Get-ClickablePointOrNull {
    param([System.Windows.Automation.AutomationElement]$Element)

    try {
        return $Element.GetClickablePoint()
    } catch {
        $rect = $Element.Current.BoundingRectangle
        if (-not (Test-UsableRectangle -Rect $rect)) {
            return $null
        }

        $point = New-Object System.Windows.Point(($rect.Left + ($rect.Width / 2)), ($rect.Top + ($rect.Height / 2)))
        return $point
    }
}

function Invoke-SelectionPattern {
    param([System.Windows.Automation.AutomationElement]$Element)

    try {
        $pattern = $Element.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
        $pattern.Select()
        Start-Sleep -Milliseconds 120
        return $true
    } catch {
        return $false
    }
}

function Invoke-ElementPattern {
    param([System.Windows.Automation.AutomationElement]$Element)

    try {
        $pattern = $Element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
        $pattern.Invoke()
        Start-Sleep -Milliseconds 120
        return $true
    } catch {
        return $false
    }
}

function Invoke-LegacyDefaultAction {
    param([System.Windows.Automation.AutomationElement]$Element)

    try {
        $pattern = $Element.GetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern)
        $pattern.DoDefaultAction()
        Start-Sleep -Milliseconds 120
        return $true
    } catch {
        return $false
    }
}

function Get-ChildTextElements {
    param([System.Windows.Automation.AutomationElement]$Element)

    $condition = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Text
    )

    $found = $Element.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
    $visible = New-Object System.Collections.Generic.List[System.Windows.Automation.AutomationElement]
    for ($index = 0; $index -lt $found.Count; $index += 1) {
        $item = $found.Item($index)
        $name = $item.Current.Name
        $rect = $item.Current.BoundingRectangle
        if (-not [string]::IsNullOrWhiteSpace($name) -and $rect.Width -gt 0 -and $rect.Height -gt 0) {
            [void]$visible.Add($item)
        }
    }

    return $visible
}

function Get-SelectedSidebarThreadTitle {
    param([System.Windows.Automation.AutomationElement]$Root)

    $selectedEntries = @(
        @(Get-ThreadEntriesEnsuringSidebar -Root $Root) |
            Where-Object { $_.IsSelected } |
            ForEach-Object { Get-ThreadEntryVisibleLabel -Entry $_ }
    )

    if ($selectedEntries.Count -eq 0) {
        return $null
    }

    return $selectedEntries[-1]
}

function Get-SelectedSidebarThreadTitles {
    param([System.Windows.Automation.AutomationElement]$Root)

    return @(
        @(Get-ThreadEntriesEnsuringSidebar -Root $Root) |
            Where-Object { $_.IsSelected } |
            ForEach-Object { Get-ThreadEntryVisibleLabel -Entry $_ }
    )
}

function Get-VisibleSidebarRowButtons {
    param([System.Windows.Automation.AutomationElement]$Root)

    $buttons = @(Get-DescendantsByType -Root $Root -ControlType ([System.Windows.Automation.ControlType]::Button))
    $visible = New-Object System.Collections.Generic.List[System.Windows.Automation.AutomationElement]
    $layout = Get-SidebarLayoutLimits -Root $Root

    for ($index = 0; $index -lt $buttons.Count; $index += 1) {
        $button = $buttons.Item($index)
        $name = Normalize-Whitespace $button.Current.Name
        $className = Normalize-Whitespace $button.Current.ClassName
        $rect = $button.Current.BoundingRectangle
        if ([string]::IsNullOrWhiteSpace($name) -or
            (-not (Test-UsableRectangle -Rect $rect)) -or
            $rect.Left -ge $layout.SidebarRightLimit -or
            $rect.Width -gt $layout.SidebarWidthLimit) {
            continue
        }

        $isThreadRowButton = Test-SidebarRowButtonName -Name $name

        if (-not $isThreadRowButton) {
            continue
        }

        [void]$visible.Add($button)
    }

    return $visible
}

function Test-RectanglesOverlapVertically {
    param(
        [System.Windows.Rect]$A,
        [System.Windows.Rect]$B
    )

    return ($A.Top -lt $B.Bottom) -and ($A.Bottom -gt $B.Top)
}

function Get-RowButtonPreferenceScore {
    param([System.Windows.Automation.AutomationElement]$Button)

    if (-not $Button) {
        return -1
    }

    $className = Normalize-Whitespace $Button.Current.ClassName
    if ([string]::IsNullOrWhiteSpace($className)) {
        return 0
    }

    if ($className.Contains('bg-token-list-active-selection-background')) {
        return 4
    }

    if ($className.Contains('group relative cursor-interaction')) {
        return 3
    }

    if ($className.Contains('cursor-grab active:cursor-grabbing')) {
        return 1
    }

    return 2
}

function Find-OverlappingSidebarRowButton {
    param(
        [System.Collections.Generic.List[System.Windows.Automation.AutomationElement]]$Buttons,
        [System.Windows.Automation.AutomationElement]$Item
    )

    $itemRect = $Item.Current.BoundingRectangle
    if (-not (Test-UsableRectangle -Rect $itemRect)) {
        return $null
    }

    $bestButton = $null
    $bestDistance = [double]::PositiveInfinity
    $bestScore = -1

    foreach ($button in @($Buttons)) {
        $buttonRect = $button.Current.BoundingRectangle
        if (-not (Test-UsableRectangle -Rect $buttonRect)) {
            continue
        }

        if (-not (Test-RectanglesOverlapVertically -A $itemRect -B $buttonRect)) {
            continue
        }
        if ($itemRect.Left -gt ($buttonRect.Right + 8)) {
            continue
        }

        $distance = [Math]::Abs($buttonRect.Top - $itemRect.Top) + [Math]::Abs($buttonRect.Left - $itemRect.Left)
        $score = Get-RowButtonPreferenceScore -Button $button
        if ($score -gt $bestScore -or ($score -eq $bestScore -and $distance -lt $bestDistance)) {
            $bestScore = $score
            $bestDistance = $distance
            $bestButton = $button
        }
    }

    return $bestButton
}

function Test-RowButtonSelected {
    param([System.Windows.Automation.AutomationElement]$Button)

    if (-not $Button) {
        return $false
    }

    return Test-RowClassLooksStrictSelected -ClassName $Button.Current.ClassName
}

function Test-ThreadEntrySelected {
    param([object]$Entry)

    if (-not $Entry) {
        return $false
    }

    $classes = @()
    if ($Entry.RowButton) {
        $classes += (Normalize-Whitespace $Entry.RowButton.Current.ClassName)
        if ($Entry.RowButton.Current.HasKeyboardFocus) {
            return $true
        }
    }
    if ($Entry.Item) {
        $classes += (Normalize-Whitespace $Entry.Item.Current.ClassName)
    }

    return @(
        $classes |
            Where-Object { Test-RowClassLooksStrictSelected -ClassName $_ }
    ).Count -gt 0
}

function Get-ThreadEntries {
    param([System.Windows.Automation.AutomationElement]$Root)

    $items = @(Get-ThreadItems -Root $Root)
    $rowButtons = @(Get-VisibleSidebarRowButtons -Root $Root)
    $entries = @()

    foreach ($item in @($items)) {
        $title = Normalize-Whitespace $item.Current.Name
        if ([string]::IsNullOrWhiteSpace($title)) {
            continue
        }

        $itemClassName = Normalize-Whitespace $item.Current.ClassName
        if ($itemClassName.IndexOf('_markdownText_', [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -or
            $itemClassName.IndexOf('_listItem_', [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
            continue
        }

        $rowButton = Find-OverlappingSidebarRowButton -Buttons $rowButtons -Item $item
        $entries += [pscustomobject]@{
            Title = $title
            Item = $item
            RowButton = $rowButton
            IsSelected = $false
        }
        $entries[-1].IsSelected = Test-ThreadEntrySelected -Entry $entries[-1]
    }

    return @($entries)
}

function Get-ThreadEntriesEnsuringSidebar {
    param([System.Windows.Automation.AutomationElement]$Root)

    $entries = @(Get-ThreadEntries -Root $Root)
    if ($entries.Count -gt 0) {
        return @($entries)
    }

    if (Expand-CodexSidebarIfCollapsed -Root $Root) {
        $entries = @(Get-ThreadEntries -Root $Root)
    }

    return @($entries)
}

function Send-ScrollToLatest {
    Send-ControlChord -VirtualKey $VirtualKeyEnd
    Start-Sleep -Milliseconds 260
}

function Get-VisibleMainTextCombined {
    param(
        [System.Windows.Automation.AutomationElement]$Root,
        [double]$SidebarRight
    )

    $rootRect = Get-EffectiveRootRectangle -Root $Root
    $textElements = @(Get-DescendantsByType -Root $Root -ControlType ([System.Windows.Automation.ControlType]::Text))
    $pieces = New-Object System.Collections.Generic.List[string]
    $mainPaneLeftThreshold = $SidebarRight + 32

    for ($index = 0; $index -lt $textElements.Count; $index += 1) {
        $item = $textElements.Item($index)
        $name = Normalize-Whitespace $item.Current.Name
        if ([string]::IsNullOrWhiteSpace($name)) {
            continue
        }

        $rect = $item.Current.BoundingRectangle
        if (-not (Test-UsableRectangle -Rect $rect)) {
            continue
        }

        if ($rect.Bottom -le $rootRect.Top -or $rect.Top -ge $rootRect.Bottom) {
            continue
        }

        if ($rect.Left -lt $mainPaneLeftThreshold) {
            continue
        }

        [void]$pieces.Add($name)
    }

    return (($pieces | Where-Object { $_ }) -join ' ')
}

function Test-VisibleMainTextContains {
    param(
        [System.Windows.Automation.AutomationElement]$Root,
        [double]$SidebarRight,
        [string]$ExpectedText
    )

    if ([string]::IsNullOrWhiteSpace($ExpectedText)) {
        return $null
    }

    $needle = Normalize-Whitespace $ExpectedText
    if ([string]::IsNullOrWhiteSpace($needle)) {
        return $null
    }

    $combined = Normalize-Whitespace (Get-VisibleMainTextCombined -Root $Root -SidebarRight $SidebarRight)
    return $combined.Contains($needle)
}

function Click-AutomationElement {
    param(
        [System.Windows.Automation.AutomationElement]$Element,
        [switch]$PreferLeftBiasedPoint,
        [switch]$SkipPatterns,
        [ValidateRange(1, 3)]
        [int]$ClickCount = 1
    )

    try {
        $scrollPattern = $Element.GetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern)
        $scrollPattern.ScrollIntoView()
        Start-Sleep -Milliseconds 120
    } catch {
        # ScrollIntoView is best-effort only.
    }

    if (-not $SkipPatterns) {
        if (Invoke-SelectionPattern -Element $Element) {
            return $true
        }

        if (Invoke-ElementPattern -Element $Element) {
            return $true
        }

        if (Invoke-LegacyDefaultAction -Element $Element) {
            return $true
        }
    }

    $candidatePoints = New-Object System.Collections.Generic.List[System.Windows.Point]

    $rect = $Element.Current.BoundingRectangle
    Add-VisibleRectangleClickPoints -Points $candidatePoints -Rect $rect -PreferLeftBiasedPoint:$PreferLeftBiasedPoint

    foreach ($child in @(Get-ChildTextElements -Element $Element)) {
        $childPoint = Get-ClickablePointOrNull -Element $child
        if ($childPoint) {
            [void]$candidatePoints.Add($childPoint)
        }
    }

    $point = Get-ClickablePointOrNull -Element $Element
    if ($point) {
        [void]$candidatePoints.Add($point)
    }

    $dedupedPoints = New-Object System.Collections.Generic.List[System.Windows.Point]
    $seen = New-Object System.Collections.Generic.HashSet[string]
    foreach ($candidate in $candidatePoints) {
        if (-not (Test-PointWithinVirtualScreen -Point $candidate)) {
            continue
        }

        $key = ('{0}:{1}' -f [int][Math]::Round($candidate.X), [int][Math]::Round($candidate.Y))
        if (-not $seen.Add($key)) {
            continue
        }

        [void]$dedupedPoints.Add($candidate)
    }

    foreach ($candidate in $dedupedPoints) {
        [WorkstationControlDesktopSyncNative]::SetCursorPos([int][Math]::Round($candidate.X), [int][Math]::Round($candidate.Y)) | Out-Null
        Start-Sleep -Milliseconds 80
        for ($clickIndex = 0; $clickIndex -lt $ClickCount; $clickIndex += 1) {
            [WorkstationControlDesktopSyncNative]::mouse_event($MouseEventLeftDown, 0, 0, 0, [UIntPtr]::Zero)
            Start-Sleep -Milliseconds 40
            [WorkstationControlDesktopSyncNative]::mouse_event($MouseEventLeftUp, 0, 0, 0, [UIntPtr]::Zero)
            if ($clickIndex -lt ($ClickCount - 1)) {
                Start-Sleep -Milliseconds 90
            }
        }
        Start-Sleep -Milliseconds 180
        return $true
    }

    return ($dedupedPoints.Count -gt 0)
}

function Click-FirstAutomationElement {
    param(
        [object[]]$Elements,
        [switch]$PreferLeftBiasedPoint,
        [switch]$SkipPatterns
    )

    foreach ($element in @($Elements)) {
        if (-not $element) {
            continue
        }

        if (Click-AutomationElement -Element $element -PreferLeftBiasedPoint:$PreferLeftBiasedPoint -SkipPatterns:$SkipPatterns) {
            return $true
        }
    }

    return $false
}

function Bring-WindowForward {
    param([System.Diagnostics.Process]$WindowProcess)

    if ([WorkstationControlDesktopSyncNative]::IsIconic($WindowProcess.MainWindowHandle)) {
        [WorkstationControlDesktopSyncNative]::ShowWindowAsync($WindowProcess.MainWindowHandle, $ShowWindowRestore) | Out-Null
        Start-Sleep -Milliseconds 150
    }
    [WorkstationControlDesktopSyncNative]::SetForegroundWindow($WindowProcess.MainWindowHandle) | Out-Null
    Start-Sleep -Milliseconds 180
}

function Move-CursorOutsideSidebar {
    param(
        [System.Windows.Automation.AutomationElement]$Root,
        [double]$SidebarRight
    )

    $rootRect = Get-EffectiveRootRectangle -Root $Root
    $x = [Math]::Min(
        ($rootRect.Right - 80),
        [Math]::Max(($SidebarRight + 120), ($rootRect.Left + ($rootRect.Width * 0.5)))
    )
    $y = [Math]::Min(
        ($rootRect.Bottom - 120),
        [Math]::Max(($rootRect.Top + 120), ($rootRect.Top + ($rootRect.Height * 0.5)))
    )

    if ((Test-FiniteNumber -Value $x) -and (Test-FiniteNumber -Value $y)) {
        [WorkstationControlDesktopSyncNative]::SetCursorPos([int][Math]::Round($x), [int][Math]::Round($y)) | Out-Null
        Start-Sleep -Milliseconds 160
    }
}

function Find-TargetEntries {
    param(
        [System.Windows.Automation.AutomationElement]$Root,
        [string]$ExpectedTitle,
        [int]$MaxExpansions
    )

    $expansions = 0
    while ($true) {
        $items = @(Get-ThreadEntriesEnsuringSidebar -Root $Root)
        $matches = @(Find-MatchingThreadEntries -Entries $items -ExpectedTitle $ExpectedTitle)
        if ($matches.Count -gt 0) {
            return [pscustomobject]@{
                Items = $items
                Matches = $matches
                Expanded = $expansions
            }
        }

        if ($expansions -ge $MaxExpansions) {
            return [pscustomobject]@{
                Items = $items
                Matches = $matches
                Expanded = $expansions
            }
        }

        $showMore = Get-ShowMoreButton -Root $Root
        if (-not $showMore) {
            return [pscustomobject]@{
                Items = $items
                Matches = $matches
                Expanded = $expansions
            }
        }

        if (-not (Invoke-AutomationButton -Button $showMore)) {
            return [pscustomobject]@{
                Items = $items
                Matches = $matches
                Expanded = $expansions
            }
        }

        $expansions += 1
        Start-Sleep -Milliseconds 180
    }
}

function Get-SidebarRightBoundary {
    param(
        [System.Windows.Automation.AutomationElement]$Root,
        [object[]]$Entries
    )

    $rootRect = Get-EffectiveRootRectangle -Root $Root
    $maxTrustedSidebarRight = $rootRect.Left + ($rootRect.Width * 0.35)
    $sidebarRight = [double]0
    $boundaryEntries = @($Entries | Where-Object { $null -ne $_.RowButton -or $null -ne $_.Item })
    foreach ($visible in @($boundaryEntries)) {
        $visibleAnchor = if ($visible.RowButton) { $visible.RowButton } else { $visible.Item }
        $visibleRect = $visibleAnchor.Current.BoundingRectangle
        if ((Test-UsableRectangle -Rect $visibleRect) -and $visibleRect.Right -gt $sidebarRight) {
            $sidebarRight = [Math]::Min($visibleRect.Right, $maxTrustedSidebarRight)
        }
    }

    if ($sidebarRight -le 0) {
        $sidebarRight = $maxTrustedSidebarRight
    }

    if (-not (Test-FiniteNumber -Value $sidebarRight)) {
        return [double]0
    }

    return $sidebarRight
}

function Get-VisibleMainTextLines {
    param(
        [System.Windows.Automation.AutomationElement]$Root,
        [double]$SidebarRight
    )

    $rootRect = Get-EffectiveRootRectangle -Root $Root
    $textElements = @(Get-DescendantsByType -Root $Root -ControlType ([System.Windows.Automation.ControlType]::Text))
    $pieces = New-Object System.Collections.Generic.List[string]
    $mainPaneLeftThreshold = $SidebarRight + 32

    for ($index = 0; $index -lt $textElements.Count; $index += 1) {
        $item = $textElements.Item($index)
        $name = Normalize-Whitespace $item.Current.Name
        if ([string]::IsNullOrWhiteSpace($name)) {
            continue
        }

        $rect = $item.Current.BoundingRectangle
        if (-not (Test-UsableRectangle -Rect $rect)) {
            continue
        }

        if ($rect.Bottom -le $rootRect.Top -or $rect.Top -ge $rootRect.Bottom) {
            continue
        }

        if ($rect.Left -lt $mainPaneLeftThreshold) {
            continue
        }

        [void]$pieces.Add($name)
    }

    return @($pieces)
}

function Get-ComposeInput {
    param(
        [System.Windows.Automation.AutomationElement]$Root,
        [double]$SidebarRight,
        [object]$Diagnostics = $null
    )

    $rootRect = Get-EffectiveRootRectangle -Root $Root
    $mainPaneLeftThreshold = $SidebarRight + 32
    $bottomHalfTop = $rootRect.Top + ($rootRect.Height * 0.45)
    $candidates = @()

    if ($Diagnostics) {
        $Diagnostics.Clear()
        $Diagnostics['rootRectangle'] = Convert-RectForDiagnostics $rootRect
        $Diagnostics['sidebarRight'] = Convert-NumberForDiagnostics $SidebarRight
        $Diagnostics['mainPaneLeftThreshold'] = Convert-NumberForDiagnostics $mainPaneLeftThreshold
        $Diagnostics['bottomHalfTop'] = Convert-NumberForDiagnostics $bottomHalfTop
        $Diagnostics['editControlCount'] = 0
        $Diagnostics['groupControlCount'] = 0
        $Diagnostics['proseMirrorGroupCount'] = 0
        $Diagnostics['acceptedCandidateCount'] = 0
        $Diagnostics['rejectedReasons'] = [ordered]@{}
        $Diagnostics['rejectedSamples'] = @()
        $Diagnostics['acceptedSamples'] = @()
        $Diagnostics['selectedCandidate'] = $null
    }

    $editControls = @(Get-DescendantsByType -Root $Root -ControlType ([System.Windows.Automation.ControlType]::Edit))
    if ($Diagnostics) {
        $Diagnostics['editControlCount'] = $editControls.Count
    }
    for ($index = 0; $index -lt $editControls.Count; $index += 1) {
        $item = $editControls.Item($index)
        $rect = $item.Current.BoundingRectangle
        if (-not (Test-UsableRectangle -Rect $rect)) {
            Add-ComposeProbeRejection -Diagnostics $Diagnostics -Kind 'edit' -Element $item -Reason 'unusable_rectangle'
            continue
        }
        if ($rect.Width -le 120 -or $rect.Height -le 18) {
            Add-ComposeProbeRejection -Diagnostics $Diagnostics -Kind 'edit' -Element $item -Reason 'too_small'
            continue
        }
        if ($rect.Left -lt $mainPaneLeftThreshold) {
            Add-ComposeProbeRejection -Diagnostics $Diagnostics -Kind 'edit' -Element $item -Reason 'left_of_main_pane'
            continue
        }
        if ($rect.Top -lt $bottomHalfTop) {
            Add-ComposeProbeRejection -Diagnostics $Diagnostics -Kind 'edit' -Element $item -Reason 'above_compose_region'
            continue
        }
        if ($rect.Bottom -le $rootRect.Top -or $rect.Top -ge $rootRect.Bottom) {
            Add-ComposeProbeRejection -Diagnostics $Diagnostics -Kind 'edit' -Element $item -Reason 'outside_root_vertical'
            continue
        }

        $candidates += $item
        Add-ComposeProbeAccepted -Diagnostics $Diagnostics -Kind 'edit' -Element $item
    }

    $groupControls = @(Get-DescendantsByType -Root $Root -ControlType ([System.Windows.Automation.ControlType]::Group))
    if ($Diagnostics) {
        $Diagnostics['groupControlCount'] = $groupControls.Count
    }
    for ($index = 0; $index -lt $groupControls.Count; $index += 1) {
        $item = $groupControls.Item($index)
        $className = Normalize-Whitespace $item.Current.ClassName
        if ($className.IndexOf('ProseMirror', [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
            continue
        }

        if ($Diagnostics) {
            $Diagnostics['proseMirrorGroupCount'] = [int]$Diagnostics.proseMirrorGroupCount + 1
        }

        $rect = $item.Current.BoundingRectangle
        if (-not (Test-UsableRectangle -Rect $rect)) {
            Add-ComposeProbeRejection -Diagnostics $Diagnostics -Kind 'prosemirror_group' -Element $item -Reason 'unusable_rectangle'
            continue
        }
        if ($rect.Width -le 120 -or $rect.Height -le 18) {
            Add-ComposeProbeRejection -Diagnostics $Diagnostics -Kind 'prosemirror_group' -Element $item -Reason 'too_small'
            continue
        }
        if ($rect.Left -lt $mainPaneLeftThreshold) {
            Add-ComposeProbeRejection -Diagnostics $Diagnostics -Kind 'prosemirror_group' -Element $item -Reason 'left_of_main_pane'
            continue
        }
        if ($rect.Top -lt $bottomHalfTop) {
            Add-ComposeProbeRejection -Diagnostics $Diagnostics -Kind 'prosemirror_group' -Element $item -Reason 'above_compose_region'
            continue
        }
        if ($rect.Bottom -le $rootRect.Top -or $rect.Top -ge $rootRect.Bottom) {
            Add-ComposeProbeRejection -Diagnostics $Diagnostics -Kind 'prosemirror_group' -Element $item -Reason 'outside_root_vertical'
            continue
        }

        $candidates += $item
        Add-ComposeProbeAccepted -Diagnostics $Diagnostics -Kind 'prosemirror_group' -Element $item
    }

    if ($Diagnostics) {
        $Diagnostics['acceptedCandidateCount'] = $candidates.Count
    }
    if ($candidates.Count -eq 0) {
        return $null
    }

    $selected = ($candidates | Sort-Object { $_.Current.BoundingRectangle.Top } -Descending | Select-Object -First 1)
    if ($Diagnostics) {
        $Diagnostics['selectedCandidate'] = [ordered]@{
            className = Limit-DiagnosticText $selected.Current.ClassName
            name = Limit-DiagnosticText $selected.Current.Name
            rectangle = Convert-RectForDiagnostics $selected.Current.BoundingRectangle
        }
    }
    return $selected
}

function Set-ClipboardTextSafely {
    param([string]$Text)

    $snapshot = [ordered]@{
        hadText = $false
        text = $null
    }

    try {
        if ([System.Windows.Forms.Clipboard]::ContainsText()) {
            $snapshot.hadText = $true
            $snapshot.text = [System.Windows.Forms.Clipboard]::GetText()
        }
    } catch {
        $snapshot.hadText = $false
        $snapshot.text = $null
    }

    [System.Windows.Forms.Clipboard]::SetText($Text)
    return $snapshot
}

function Restore-ClipboardTextSafely {
    param($Snapshot)

    try {
        if ($Snapshot -and $Snapshot.hadText) {
            [System.Windows.Forms.Clipboard]::SetText([string]$Snapshot.text)
        } else {
            [System.Windows.Forms.Clipboard]::Clear()
        }
    } catch {
        # best effort only
    }
}

function Set-ComposeInputText {
    param(
        [System.Windows.Automation.AutomationElement]$ComposeInput,
        [string]$Text
    )

    if (-not $ComposeInput) {
        return $false
    }

    $focused = $false
    try {
        $ComposeInput.SetFocus()
        Start-Sleep -Milliseconds 120
        $focused = $true
    } catch {
        $focused = $false
    }

    if (-not $focused) {
        if (-not (Click-AutomationElement -Element $ComposeInput)) {
            return $false
        }

        Start-Sleep -Milliseconds 120
    }

    $snapshot = $null
    try {
        Send-ControlChord -VirtualKey $VirtualKeyA
        Start-Sleep -Milliseconds 90
        Send-VirtualKey -VirtualKey $VirtualKeyBackspace
        Start-Sleep -Milliseconds 110
        $snapshot = Set-ClipboardTextSafely -Text $Text
        Start-Sleep -Milliseconds 80
        Send-ControlChord -VirtualKey $VirtualKeyV
        Start-Sleep -Milliseconds 240
        return $true
    } catch {
        return $false
    } finally {
        if ($null -ne $snapshot) {
            Restore-ClipboardTextSafely -Snapshot $snapshot
        }
    }
}

function Find-ButtonByNameFragment {
    param(
        [System.Windows.Automation.AutomationElement]$Root,
        [string]$Needle,
        [double]$LeftThreshold = 0
    )

    $buttons = @(Get-DescendantsByType -Root $Root -ControlType ([System.Windows.Automation.ControlType]::Button))
    $normalizedNeedle = Normalize-Whitespace $Needle
    for ($index = 0; $index -lt $buttons.Count; $index += 1) {
        $button = $buttons.Item($index)
        $name = Normalize-Whitespace $button.Current.Name
        $rect = $button.Current.BoundingRectangle
        if (-not (Test-UsableRectangle -Rect $rect)) {
            continue
        }
        if ($rect.Left -lt $LeftThreshold) {
            continue
        }
        if ($name -and $name.IndexOf($normalizedNeedle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
            return $button
        }
    }

    return $null
}

function Find-ComposeSendButton {
    param(
        [System.Windows.Automation.AutomationElement]$Root,
        [System.Windows.Automation.AutomationElement]$ComposeInput,
        [double]$SidebarRight
    )

    $namedButton = Find-ButtonByNameFragment -Root $Root -Needle 'Send' -LeftThreshold ($SidebarRight + 80)
    if ($namedButton) {
        return $namedButton
    }

    if (-not $ComposeInput) {
        return $null
    }

    $composeRect = $ComposeInput.Current.BoundingRectangle
    if (-not (Test-UsableRectangle -Rect $composeRect)) {
        return $null
    }

    $buttons = @(Get-DescendantsByType -Root $Root -ControlType ([System.Windows.Automation.ControlType]::Button))
    $bestButton = $null
    $bestScore = [double]::NegativeInfinity

    for ($index = 0; $index -lt $buttons.Count; $index += 1) {
        $button = $buttons.Item($index)
        $rect = $button.Current.BoundingRectangle
        if (-not (Test-UsableRectangle -Rect $rect)) {
            continue
        }
        if ($rect.Left -lt ($SidebarRight + 80)) {
            continue
        }
        if (-not $button.Current.IsEnabled) {
            continue
        }

        $overlapsVertically = Test-RectanglesOverlapVertically -A $composeRect -B $rect
        $isRightOfCompose = $rect.Left -ge ($composeRect.Right - 24)
        $isBottomPane = $rect.Top -ge ($composeRect.Top - 32)
        if (-not $overlapsVertically -or -not $isRightOfCompose -or -not $isBottomPane) {
            continue
        }

        $name = Normalize-Whitespace $button.Current.Name
        $score = 0.0
        if ([string]::IsNullOrWhiteSpace($name)) {
            $score += 10.0
        }
        $score += [Math]::Min(5.0, ($rect.Left - $composeRect.Left) / 100.0)
        $score += [Math]::Max(0.0, 2.0 - ([Math]::Abs($rect.Top - $composeRect.Top) / 100.0))

        if ($score -gt $bestScore) {
            $bestScore = $score
            $bestButton = $button
        }
    }

    return $bestButton
}

function Submit-ComposeInput {
    param(
        [System.Windows.Automation.AutomationElement]$Root,
        [System.Windows.Automation.AutomationElement]$ComposeInput,
        [double]$SidebarRight
    )

    if (-not $ComposeInput) {
        return $false
    }

    $sendButton = Find-ComposeSendButton -Root $Root -ComposeInput $ComposeInput -SidebarRight $SidebarRight
    if ($sendButton) {
        if (Click-AutomationElement -Element $sendButton -SkipPatterns) {
            Start-Sleep -Milliseconds 300
            return $true
        }
    }

    # Set-ComposeInputText already focuses the composer. Use Enter only as a
    # fallback because some Codex Desktop builds expose a reliable Send button
    # while treating Enter as text input in the first-message composer.
    Start-Sleep -Milliseconds 120
    Send-VirtualKey -VirtualKey $VirtualKeyEnter
    Start-Sleep -Milliseconds 300
    return $true
}

function Invoke-NewThreadAction {
    param([System.Windows.Automation.AutomationElement]$Root)

    $buttons = @(Get-DescendantsByType -Root $Root -ControlType ([System.Windows.Automation.ControlType]::Button))
    for ($index = 0; $index -lt $buttons.Count; $index += 1) {
        $button = $buttons.Item($index)
        $name = Normalize-Whitespace $button.Current.Name
        if (($name -eq 'New thread' -or
                $name -eq 'New chat' -or
                $name.StartsWith('Start new chat in ', [System.StringComparison]::OrdinalIgnoreCase)) -and
            (Click-AutomationElement -Element $button)) {
            Start-Sleep -Milliseconds 280
            return $true
        }
    }

    $items = @(Get-DescendantsByType -Root $Root -ControlType ([System.Windows.Automation.ControlType]::ListItem))
    for ($index = 0; $index -lt $items.Count; $index += 1) {
        $item = $items.Item($index)
        $name = Normalize-Whitespace $item.Current.Name
        if (($name -eq 'New thread' -or
                $name -eq 'New chat' -or
                $name.StartsWith('Start new chat in ', [System.StringComparison]::OrdinalIgnoreCase)) -and
            (Click-AutomationElement -Element $item)) {
            Start-Sleep -Milliseconds 280
            return $true
        }
    }

    return $false
}

function Get-DesktopStatePayload {
    param([System.Windows.Automation.AutomationElement]$Root)

    $entries = @(Get-ThreadEntriesEnsuringSidebar -Root $Root)
    $sidebarEntries = @($entries | Where-Object { $null -ne $_.RowButton })
    if ($sidebarEntries.Count -eq 0) {
        $sidebarEntries = $entries
    }
    $sidebarRight = Get-SidebarRightBoundary -Root $Root -Entries $entries
    $selectedTitles = @(Get-SelectedSidebarThreadTitles -Root $Root)
    $visibleThreadTitles = @($sidebarEntries | Select-Object -ExpandProperty Title)
    $composeDiagnostics = [ordered]@{}
    $composeInput = Get-ComposeInput -Root $Root -SidebarRight $sidebarRight -Diagnostics $composeDiagnostics
    $visibleLines = @(Get-VisibleMainTextLines -Root $Root -SidebarRight $sidebarRight)
    $selectedTitle = if ($selectedTitles.Count -gt 0) { $selectedTitles[-1] } else { $null }
    $visibleThreadRows = @(Get-VisibleSidebarThreadRows -Entries $entries -CurrentThreadTitle $selectedTitle)

    return [ordered]@{
        windowFound = $true
        threadListAccessible = ($visibleThreadTitles.Count -gt 0)
        visibleThreadCount = $visibleThreadTitles.Count
        visibleThreadTitles = $visibleThreadTitles
        visibleThreadRows = $visibleThreadRows
        selectedSidebarThreadTitle = $selectedTitle
        selectedSidebarThreadTitles = $selectedTitles
        composeAvailable = ($null -ne $composeInput)
        composeDiagnostics = $composeDiagnostics
        readbackAvailable = $true
        visibleTranscriptLines = $visibleLines
        visibleTranscriptText = if ($visibleLines.Count -gt 0) { ($visibleLines -join ' ') } else { '' }
        sidebarRight = $sidebarRight
    }
}

function Invoke-CodexDesktopStateAction {
    param([string]$WindowTitle = 'Codex')

    $window = Get-CodexWindow -ExpectedTitle $WindowTitle
    if (-not $window) {
        return [ordered]@{
            result = 'unavailable'
            message = 'Codex desktop window is not available.'
            windowFound = $false
            threadListAccessible = $false
            visibleThreadCount = 0
            visibleThreadTitles = @()
            visibleThreadRows = @()
            composeAvailable = $false
            readbackAvailable = $false
            selectedSidebarThreadTitle = $null
            selectedSidebarThreadTitles = @()
            visibleTranscriptLines = @()
            visibleTranscriptText = ''
        }
    }

    $root = Get-RootElement -WindowProcess $window
    if (-not $root) {
        return [ordered]@{
            result = 'unavailable'
            message = 'Codex desktop window is not accessible through UI Automation.'
            windowFound = $true
            threadListAccessible = $false
            visibleThreadCount = 0
            visibleThreadTitles = @()
            visibleThreadRows = @()
            composeAvailable = $false
            readbackAvailable = $false
            selectedSidebarThreadTitle = $null
            selectedSidebarThreadTitles = @()
            visibleTranscriptLines = @()
            visibleTranscriptText = ''
        }
    }

    $state = Get-DesktopStatePayload -Root $root
    $state['result'] = 'applied'
    $state['message'] = $null
    return $state
}

function Invoke-CodexDesktopSyncAction {
    param(
        [string]$Mode = 'inspect',
        [string]$WindowTitle = 'Codex',
        [string]$ThreadTitle = '',
        [string]$ExpectedVisibleText = '',
        [string]$Reason = 'select',
        [int]$MaxShowMoreClicks = 8
    )

    $window = Get-CodexWindow -ExpectedTitle $WindowTitle
    if (-not $window) {
        return [ordered]@{
            result = 'unavailable'
            message = 'Codex desktop window is not available.'
            windowFound = $false
            visibleThreadCount = 0
            threadListAccessible = $false
        }
    }

    $root = Get-RootElement -WindowProcess $window
    if (-not $root) {
        return [ordered]@{
            result = 'unavailable'
            message = 'Codex desktop window is not accessible through UI Automation.'
            windowFound = $true
            visibleThreadCount = 0
            threadListAccessible = $false
        }
    }

    if ($Mode -eq 'inspect') {
        $inspectItems = @(Get-ThreadEntriesEnsuringSidebar -Root $root)
        $inspectSidebarItems = @($inspectItems | Where-Object { $null -ne $_.RowButton })
        if ($inspectSidebarItems.Count -eq 0) {
            $inspectSidebarItems = $inspectItems
        }
        $inspectTitles = @($inspectSidebarItems | Select-Object -ExpandProperty Title)
        return [ordered]@{
            result = 'applied'
            message = $null
            windowFound = $true
            threadListAccessible = ($inspectTitles.Count -gt 0)
            visibleThreadCount = $inspectTitles.Count
            visibleThreadTitles = $inspectTitles
        }
    }

    if ([string]::IsNullOrWhiteSpace($ThreadTitle)) {
        return [ordered]@{
            result = 'error'
            message = 'Thread title is required for desktop sync.'
        }
    }

    $foregroundWindow = [WorkstationControlDesktopSyncNative]::GetForegroundWindow()
    $isForeground = ($foregroundWindow -eq $window.MainWindowHandle)
    $isMinimized = [WorkstationControlDesktopSyncNative]::IsIconic($window.MainWindowHandle)

    if ($Mode -eq 'auto' -and (-not $isForeground -or $isMinimized)) {
        return [ordered]@{
            result = 'focus_required'
            message = 'Bring Codex to the foreground to refresh this thread.'
            windowFound = $true
            visibleThreadCount = 0
            threadListAccessible = $false
        }
    }

    if ($Mode -eq 'focus') {
        Bring-WindowForward -WindowProcess $window
        $root = Get-RootElement -WindowProcess $window
        if (-not $root) {
            return [ordered]@{
                result = 'unavailable'
                message = 'Codex desktop window is not accessible through UI Automation after foreground focus.'
                windowFound = $true
                visibleThreadCount = 0
                threadListAccessible = $false
            }
        }
    }

    $search = Find-TargetEntries -Root $root -ExpectedTitle $ThreadTitle -MaxExpansions $MaxShowMoreClicks
    if ($search.Items.Count -eq 0) {
        return [ordered]@{
            result = 'unsupported'
            message = 'Codex desktop thread items are not accessible on this build.'
            windowFound = $true
            visibleThreadCount = 0
            threadListAccessible = $false
            expanded = $search.Expanded
        }
    }

    if ($search.Matches.Count -eq 0) {
        return [ordered]@{
            result = 'unavailable'
            message = 'The requested thread is not currently visible in the Codex desktop sidebar.'
            windowFound = $true
            visibleThreadCount = $search.Items.Count
            threadListAccessible = $true
            expanded = $search.Expanded
        }
    }

    if ($search.Matches.Count -gt 1) {
        return [ordered]@{
            result = 'ambiguous_match'
            message = 'Multiple visible desktop threads match this title.'
            windowFound = $true
            visibleThreadCount = $search.Items.Count
            threadListAccessible = $true
            expanded = $search.Expanded
            matchCount = $search.Matches.Count
        }
    }

    $target = $search.Matches[0]
    $targetElements = @($target.RowButton, $target.Item) | Where-Object { $null -ne $_ }
    $sidebarRight = Get-SidebarRightBoundary -Root $root -Entries $search.Items

    $activationAttempted = $false
    $postClickEntries = @()
    $postClickMatches = @()
    $selectedSidebarThreadTitles = @()
    $selectedSidebarThreadTitle = $null
    $selectedMatch = $null
    $selectionConfirmed = $false

    foreach ($targetElement in @($targetElements)) {
        $applied = Click-AutomationElement -Element $targetElement -PreferLeftBiasedPoint -SkipPatterns
        if (-not $applied) {
            continue
        }

        $activationAttempted = $true
        Move-CursorOutsideSidebar -Root $root -SidebarRight $sidebarRight

        for ($attempt = 1; $attempt -le 24; $attempt += 1) {
            Start-Sleep -Milliseconds 250
            $root = Get-RootElement -WindowProcess $window
            if (-not $root) {
                break
            }

            $postClickEntries = @(Get-ThreadEntriesEnsuringSidebar -Root $root)
            $postClickMatches = @(Find-MatchingThreadEntries -Entries $postClickEntries -ExpectedTitle $ThreadTitle)
            $selectedSidebarThreadTitles = @(Get-SelectedSidebarThreadTitles -Root $root)
            $selectedSidebarThreadTitle = if ($selectedSidebarThreadTitles.Count -gt 0) { $selectedSidebarThreadTitles[-1] } else { $null }
            if ($postClickMatches.Count -eq 1) {
                $selectedMatch = $postClickMatches[0]
                $selectionConfirmed = Test-ThreadEntrySelected -Entry $selectedMatch
                if ($selectionConfirmed) {
                    break
                }
            }
        }

        if ($selectionConfirmed -or (-not $root)) {
            break
        }
    }

    if (-not $activationAttempted) {
        return [ordered]@{
            result = 'unsupported'
            message = 'The exact Codex desktop sidebar thread row could not be activated safely.'
            windowFound = $true
            visibleThreadCount = $search.Items.Count
            threadListAccessible = $true
            expanded = $search.Expanded
        }
    }

    if (-not $root) {
        return [ordered]@{
            result = 'unavailable'
            message = 'Codex desktop window became inaccessible while verifying the selected sidebar thread.'
            windowFound = $true
            visibleThreadCount = 0
            threadListAccessible = $false
            expanded = $search.Expanded
            selectionConfirmed = $false
        }
    }

    if ($postClickMatches.Count -ne 1) {
        $state = Get-DesktopStatePayload -Root $root
        return [ordered]@{
            result = 'thread_mismatch'
            message = 'After clicking the requested thread, the sidebar no longer exposed exactly one exact-label match.'
            windowFound = $state.windowFound
            visibleThreadCount = $state.visibleThreadCount
            threadListAccessible = $state.threadListAccessible
            expanded = $search.Expanded
            selectionConfirmed = $false
            selectedSidebarThreadTitle = $selectedSidebarThreadTitle
            selectedSidebarThreadTitles = $selectedSidebarThreadTitles
            composeAvailable = $state.composeAvailable
            readbackAvailable = $state.readbackAvailable
            visibleTranscriptLines = $state.visibleTranscriptLines
            visibleTranscriptText = $state.visibleTranscriptText
            sidebarRight = $sidebarRight
            matchCount = $postClickMatches.Count
        }
    }

    if (-not $selectionConfirmed) {
        $state = Get-DesktopStatePayload -Root $root
        return [ordered]@{
            result = 'thread_mismatch'
            message = 'Codex desktop did not mark the exact requested sidebar row as selected after activation.'
            windowFound = $state.windowFound
            visibleThreadCount = $state.visibleThreadCount
            threadListAccessible = $state.threadListAccessible
            expanded = $search.Expanded
            selectionConfirmed = $false
            selectedSidebarThreadTitle = $selectedSidebarThreadTitle
            selectedSidebarThreadTitles = $selectedSidebarThreadTitles
            composeAvailable = $state.composeAvailable
            readbackAvailable = $state.readbackAvailable
            visibleTranscriptLines = $state.visibleTranscriptLines
            visibleTranscriptText = $state.visibleTranscriptText
            sidebarRight = $sidebarRight
        }
    }

    $selectedSidebarThreadTitle = Get-ThreadEntryVisibleLabel -Entry $selectedMatch
    $selectedSidebarThreadTitles = @($selectedSidebarThreadTitle)
    $state = Get-DesktopStatePayload -Root $root
    return [ordered]@{
        result = 'applied'
        message = $null
        windowFound = $state.windowFound
        visibleThreadCount = $state.visibleThreadCount
        threadListAccessible = $state.threadListAccessible
        expanded = $search.Expanded
        selectionConfirmed = $selectionConfirmed
        selectedSidebarThreadTitle = $selectedSidebarThreadTitle
        selectedSidebarThreadTitles = $selectedSidebarThreadTitles
        composeAvailable = $state.composeAvailable
        readbackAvailable = $state.readbackAvailable
        visibleTranscriptLines = $state.visibleTranscriptLines
        visibleTranscriptText = $state.visibleTranscriptText
        sidebarRight = $sidebarRight
    }
}

function Invoke-CodexDesktopPromptAction {
    param(
        [string]$Mode = 'focus',
        [string]$WindowTitle = 'Codex',
        [string]$ThreadTitle,
        [string]$Text,
        [int]$MaxShowMoreClicks = 16
    )

    if ([string]::IsNullOrWhiteSpace($Text)) {
        return [ordered]@{ result = 'error'; message = 'Prompt text is required.' }
    }

    $selection = Invoke-CodexDesktopSyncAction -Mode $Mode -WindowTitle $WindowTitle -ThreadTitle $ThreadTitle -Reason 'prompt' -MaxShowMoreClicks $MaxShowMoreClicks
    if ($selection.result -ne 'applied') {
        return $selection
    }

    $window = Get-CodexWindow -ExpectedTitle $WindowTitle
    $root = if ($window) { Get-RootElement -WindowProcess $window } else { $null }
    if (-not $root) {
        return [ordered]@{ result = 'unavailable'; message = 'Codex desktop window is not accessible through UI Automation.'; windowFound = ($null -ne $window) }
    }

    $composeDiagnostics = [ordered]@{}
    $composeInput = Get-ComposeInput -Root $root -SidebarRight $selection.sidebarRight -Diagnostics $composeDiagnostics
    if (-not $composeInput) {
        return [ordered]@{ result = 'unsupported'; message = 'Codex desktop compose box is not accessible on this build.'; windowFound = $true; composeAvailable = $false; composeDiagnostics = $composeDiagnostics }
    }
    if (-not (Set-ComposeInputText -ComposeInput $composeInput -Text $Text)) {
        return [ordered]@{ result = 'unsupported'; message = 'Codex desktop compose box could not be populated safely.'; windowFound = $true; composeAvailable = $true; composeDiagnostics = $composeDiagnostics }
    }
    if (-not (Submit-ComposeInput -Root $root -ComposeInput $composeInput -SidebarRight $selection.sidebarRight)) {
        return [ordered]@{ result = 'unsupported'; message = 'Codex desktop prompt submit action was not available.'; windowFound = $true; composeAvailable = $true; composeDiagnostics = $composeDiagnostics }
    }

    Send-ScrollToLatest
    $visibleLines = @(Get-VisibleMainTextLines -Root $root -SidebarRight $selection.sidebarRight)

    return [ordered]@{
        result = 'applied'
        message = $null
        windowFound = $true
        composeAvailable = $true
        composeDiagnostics = $composeDiagnostics
        readbackAvailable = $true
        selectionConfirmed = $selection.selectionConfirmed
        selectedSidebarThreadTitle = $selection.selectedSidebarThreadTitle
        selectedSidebarThreadTitles = $selection.selectedSidebarThreadTitles
        visibleTranscriptLines = $visibleLines
        visibleTranscriptText = ($visibleLines -join ' ')
    }
}

function Invoke-CodexDesktopCreateThreadAction {
    param(
        [string]$Mode = 'focus',
        [string]$WindowTitle = 'Codex',
        [string]$Text
    )

    if ([string]::IsNullOrWhiteSpace($Text)) {
        return [ordered]@{ result = 'error'; message = 'Prompt text is required.' }
    }

    $window = Get-CodexWindow -ExpectedTitle $WindowTitle
    if (-not $window) {
        return [ordered]@{ result = 'unavailable'; message = 'Codex desktop window is not available.'; windowFound = $false }
    }

    $foregroundWindow = [WorkstationControlDesktopSyncNative]::GetForegroundWindow()
    $isForeground = ($foregroundWindow -eq $window.MainWindowHandle)
    $isMinimized = [WorkstationControlDesktopSyncNative]::IsIconic($window.MainWindowHandle)
    if ($Mode -eq 'auto' -and (-not $isForeground -or $isMinimized)) {
        return [ordered]@{ result = 'focus_required'; message = 'Bring Codex to the foreground to create a thread.'; windowFound = $true }
    }
    if ($Mode -eq 'focus') {
        Bring-WindowForward -WindowProcess $window
    }

    $root = Get-RootElement -WindowProcess $window
    if (-not $root) {
        return [ordered]@{ result = 'unavailable'; message = 'Codex desktop window is not accessible through UI Automation.'; windowFound = $true }
    }
    [void](Expand-CodexSidebarIfCollapsed -Root $root)
    if (-not (Invoke-NewThreadAction -Root $root)) {
        return [ordered]@{ result = 'unsupported'; message = 'Codex desktop New thread action is not accessible on this build.'; windowFound = $true }
    }

    $entries = @()
    $sidebarRight = 0
    $composeDiagnostics = [ordered]@{}
    $composeInput = $null
    for ($attempt = 1; $attempt -le 24; $attempt += 1) {
        Start-Sleep -Milliseconds 250
        $root = Get-RootElement -WindowProcess $window
        if (-not $root) {
            break
        }

        $entries = @(Get-ThreadEntriesEnsuringSidebar -Root $root)
        $sidebarRight = Get-SidebarRightBoundary -Root $root -Entries $entries
        $composeDiagnostics = [ordered]@{}
        $composeInput = Get-ComposeInput -Root $root -SidebarRight $sidebarRight -Diagnostics $composeDiagnostics
        if ($composeInput) {
            break
        }
    }
    if (-not $composeInput) {
        return [ordered]@{ result = 'unsupported'; message = 'Codex desktop compose box is not accessible on this build.'; windowFound = $true; composeAvailable = $false; composeDiagnostics = $composeDiagnostics }
    }
    if (-not (Set-ComposeInputText -ComposeInput $composeInput -Text $Text)) {
        return [ordered]@{ result = 'unsupported'; message = 'Codex desktop compose box could not be populated safely.'; windowFound = $true; composeAvailable = $true; composeDiagnostics = $composeDiagnostics }
    }
    if (-not (Submit-ComposeInput -Root $root -ComposeInput $composeInput -SidebarRight $sidebarRight)) {
        return [ordered]@{ result = 'unsupported'; message = 'Codex desktop create-thread submit action was not available.'; windowFound = $true; composeAvailable = $true; composeDiagnostics = $composeDiagnostics }
    }

    Send-ScrollToLatest
    $selectedTitles = @(Get-SelectedSidebarThreadTitles -Root $root)
    $visibleLines = @(Get-VisibleMainTextLines -Root $root -SidebarRight $sidebarRight)
    $selectedTitle = if ($selectedTitles.Count -gt 0) { $selectedTitles[-1] } else { $null }

    return [ordered]@{
        result = 'applied'
        message = $null
        windowFound = $true
        composeAvailable = $true
        composeDiagnostics = $composeDiagnostics
        readbackAvailable = $true
        selectedSidebarThreadTitle = $selectedTitle
        selectedSidebarThreadTitles = $selectedTitles
        visibleTranscriptLines = $visibleLines
        visibleTranscriptText = ($visibleLines -join ' ')
    }
}

function Invoke-CodexDesktopReadbackAction {
    param(
        [string]$WindowTitle = 'Codex',
        [string]$ExpectedThreadTitle = ''
    )

    $state = Invoke-CodexDesktopStateAction -WindowTitle $WindowTitle
    if ($state.result -ne 'applied') {
        return $state
    }

    if (-not [string]::IsNullOrWhiteSpace($ExpectedThreadTitle)) {
        if (-not (Test-ThreadVisibleLabelEquals -ObservedLabel ([string]$state.selectedSidebarThreadTitle) -ExpectedLabel $ExpectedThreadTitle)) {
            $state['result'] = 'thread_mismatch'
            $state['message'] = 'The currently selected Codex desktop thread does not match the expected thread.'
        }
    }

    return $state
}
