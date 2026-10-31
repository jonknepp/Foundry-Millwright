#requires -Version 7.0
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$files = @(Get-ChildItem -LiteralPath $root -Filter '*.ps1' -File)
$files += @(Get-ChildItem -LiteralPath (Join-Path $root 'scripts') -Filter '*.ps1' -File)
$failures = 0

foreach ($file in $files) {
    $tokens = $null
    $parseErrors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile(
        $file.FullName, [ref]$tokens, [ref]$parseErrors
    )
    if ($parseErrors.Count -gt 0) {
        foreach ($error in $parseErrors) {
            Write-Error -Message "$($file.FullName):$($error.Extent.StartLineNumber): $($error.Message)" -ErrorAction Continue
        }
        $failures += $parseErrors.Count
    }
}

if ($failures -gt 0) { throw "$failures PowerShell syntax error(s) detected." }
Write-Host "PowerShell syntax validation passed ($($files.Count) scripts)."
