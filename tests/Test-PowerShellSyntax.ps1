#Requires -Version 7.0
<#
.SYNOPSIS
    Parse every tracked PowerShell script without executing it.
#>
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$paths = @(Get-ChildItem -LiteralPath $root -Filter '*.ps1' -File -Recurse |
    Where-Object { $_.FullName -notmatch '[\\/](?:\.git|node_modules)[\\/]' })
$failures = 0
foreach ($path in $paths) {
    $tokens = $null
    $parseErrors = $null
    [System.Management.Automation.Language.Parser]::ParseFile(
        $path.FullName, [ref]$tokens, [ref]$parseErrors) | Out-Null
    if ($parseErrors.Count -gt 0) {
        foreach ($errorItem in $parseErrors) {
            Write-Host "FAIL: $($path.FullName):$($errorItem.Extent.StartLineNumber): $($errorItem.Message)" -ForegroundColor Red
            $failures++
        }
    }
}
if ($failures -gt 0) {
    throw "PowerShell syntax validation failed with $failures error(s)."
}
Write-Host "PASS: Parsed $($paths.Count) PowerShell scripts without syntax errors." -ForegroundColor Green
