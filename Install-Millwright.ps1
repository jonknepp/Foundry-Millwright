#Requires -Version 7.0
<#
.SYNOPSIS
    Guided, resumable installation of Foundry-Millwright.
.DESCRIPTION
    Orchestrates existing configuration scripts. Does not start operational
    containers without explicit confirmation. Existing deployment data is retained.
#>
[CmdletBinding()]
param(
    [switch]$SkipActivation
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$scripts = Join-Path $root 'scripts'
$envPath = Join-Path $root '.env'

function Invoke-Phase([string]$Title, [string]$Script, [string[]]$Arguments = @()) {
    Write-Host ""
    Write-Host "=== $Title ===" -ForegroundColor Cyan
    & (Join-Path $scripts $Script) @Arguments
    if (-not $?) { throw "$Title failed." }
}
function Confirm-Step([string]$Question, [bool]$DefaultYes = $true) {
    $suffix = if ($DefaultYes) { '[Y/n]' } else { '[y/N]' }
    while ($true) {
        $reply = (Read-Host "$Question $suffix").Trim()
        if ($reply -eq '') { return $DefaultYes }
        if ($reply -match '^(?i:y|yes)$') { return $true }
        if ($reply -match '^(?i:n|no)$') { return $false }
        Write-Warning 'Enter Y or N.'
    }
}
function Read-Settings {
    $settings = @{}
    foreach ($line in [IO.File]::ReadAllLines($envPath)) {
        if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') {
            $settings[$Matches[1]] = $Matches[2].Trim('"', "'")
        }
    }
    return $settings
}
Write-Host 'Foundry-Millwright | Guided Installation' -ForegroundColor Cyan
Write-Host 'Existing settings are reused; configuration can be resumed by rerunning this installer.'
Write-Host 'Operational containers will remain stopped until you approve activation.'

if (-not $IsWindows) { throw 'This installer currently supports Windows only.' }
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'PowerShell 7 or newer is required.' }
foreach ($command in 'git', 'docker', 'wsl.exe') {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "Required executable not found: $command" }
}
& docker info --format '{{.ServerVersion}}' 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Docker Desktop engine is not running or accessible.' }
& docker compose version | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Docker Compose is unavailable.' }
& wsl.exe --status | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'WSL2 status check failed.' }
Write-Host 'Prerequisite commands are available.'

if (Confirm-Step 'Initialize or review storage and Foundry archive?') {
    Invoke-Phase 'Storage and Foundry archive' 'Initialize-Millwright.ps1'
}
if (-not (Test-Path -LiteralPath $envPath -PathType Leaf)) {
    throw 'Persistent configuration is not initialized. Run the storage phase.'
}
$settings = Read-Settings
$dataRoot = $settings['MILLWRIGHT_DATA_DIR']
if ([string]::IsNullOrWhiteSpace($dataRoot) -or -not [IO.Path]::IsPathFullyQualified($dataRoot)) {
    throw 'MILLWRIGHT_DATA_DIR must be an absolute path.'
}
$signingPath = Join-Path $dataRoot 'secrets/authcrunch-signing-key'
if (-not (Test-Path -LiteralPath $signingPath -PathType Leaf)) {
    Write-Host 'Generating deployment signing key.'
    $directory = Split-Path -Parent $signingPath
    $null = New-Item -ItemType Directory -Path $directory -Force
    $key = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
    $stream = [IO.File]::Open($signingPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $bytes = [Text.Encoding]::ASCII.GetBytes($key)
        $stream.Write($bytes, 0, $bytes.Length)
    } finally { $stream.Dispose() }
}
if ((Get-Item -LiteralPath $signingPath).Length -eq 0) { throw 'Signing key file is empty.' }

if (Confirm-Step 'Configure or review Discord integration?') {
    Invoke-Phase 'Discord integration' 'Set-DiscordConfig.ps1'
}
if (Confirm-Step 'Configure or review DuckDNS?') {
    Invoke-Phase 'DuckDNS' 'Set-DuckDNSConfig.ps1'
}
if (Confirm-Step 'Configure or review networking?') {
    Invoke-Phase 'Network and port forwarding' 'Set-PortForwardingConfig.ps1'
}
Write-Host ""
Write-Host '=== Pre-activation validation ===' -ForegroundColor Cyan
& (Join-Path $scripts 'Start-Millwright.ps1') -ValidateOnly
if (-not $?) { throw 'Pre-activation validation failed. Correct configuration and rerun the installer.' }
$settings = Read-Settings
Write-Host ""
Write-Host '=== Deployment summary ===' -ForegroundColor Cyan
Write-Host "Data directory: $($settings['MILLWRIGHT_DATA_DIR'])"
Write-Host "Foundry archive: $($settings['FOUNDRY_ARCHIVE'])"
Write-Host "Public hostname: $($settings['MILLWRIGHT_PUBLIC_HOSTNAME'])"
Write-Host "Public HTTPS port: $($settings['MILLWRIGHT_PUBLIC_HTTPS_PORT'])"
Write-Host "Forwarding mode: $($settings['MILLWRIGHT_PORT_FORWARDING_MODE'])"
Write-Host 'Discord credentials and DNS token are not displayed.'
if ($SkipActivation) {
    Write-Host 'Validation complete; activation skipped.'
    return
}
if (-not (Confirm-Step 'Activate Millwright services now?' $false)) {
    Write-Host 'Installation configuration saved; services not started.'
    return
}
& (Join-Path $scripts 'Start-Millwright.ps1')
if (-not $?) { throw 'Activation failed.' }
Write-Host 'Millwright startup command completed.'
Write-Host ''
Write-Host 'If administrator setup is still pending, the one-time challenge is displayed above.'
Write-Host 'For later starts, run .\\scripts\\Start-Millwright.ps1 to display it again until claimed.'
