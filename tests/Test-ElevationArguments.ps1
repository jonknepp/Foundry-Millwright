#Requires -Version 7.0
<#
.SYNOPSIS
    Verify ProcessStartInfo.ArgumentList preserves Windows path arguments.
    This test does not request elevation or modify a deployment.
#>
$ErrorActionPreference = 'Stop'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('Millwright argument test ' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
try {
    $scriptPath = Join-Path $testRoot 'echo arguments.ps1'
    $resultPath = Join-Path $testRoot 'captured arguments.json'
    @'
param(
    [string]$SelectedDataDirectory,
    [string]$SelectedArchive,
    [string]$OutputPath
)
@($SelectedDataDirectory, $SelectedArchive) |
    ConvertTo-Json -Compress |
    Set-Content -LiteralPath $OutputPath -Encoding utf8
'@ | Set-Content -LiteralPath $scriptPath -Encoding utf8

    $dataPath = Join-Path $testRoot 'My Game Data'
    $archivePath = Join-Path $testRoot 'Foundry VTT Node.js.zip'
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = (Get-Process -Id $PID).Path
    $startInfo.UseShellExecute = $true
    foreach ($argument in @(
        '-NoProfile', '-File', $scriptPath,
        '-SelectedDataDirectory', $dataPath,
        '-SelectedArchive', $archivePath,
        '-OutputPath', $resultPath
    )) {
        $startInfo.ArgumentList.Add([string]$argument)
    }
    $child = [System.Diagnostics.Process]::Start($startInfo)
    if ($null -eq $child) { throw 'Failed to start argument round-trip process.' }
    try {
        $child.WaitForExit()
        if ($child.ExitCode -ne 0) { throw "Child process exited with $($child.ExitCode)." }
    }
    finally { $child.Dispose() }
    $actual = @(Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json)
    if ($actual.Count -ne 2 -or $actual[0] -cne $dataPath -or $actual[1] -cne $archivePath) {
        throw 'ProcessStartInfo.ArgumentList did not preserve the selected paths.'
    }
    Write-Host 'PASS: ProcessStartInfo.ArgumentList preserved paths containing spaces.' -ForegroundColor Green
}
finally {
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
