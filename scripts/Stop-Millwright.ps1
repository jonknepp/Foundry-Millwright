#Requires -Version 7.0
[CmdletBinding()]
param([switch]$CleanupNetwork)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root '.env'
$composeFile = Join-Path $root 'compose.yml'
if (-not (Test-Path -LiteralPath $envFile)) { throw "Missing .env: $envFile" }
$settings = @{}
foreach ($line in [IO.File]::ReadAllLines($envFile)) {
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') {
        $settings[$Matches[1]] = $Matches[2].Trim().Trim('"', "'")
    }
}
# Compose interpolates required service variables even for 'down'. Load the
# deployment's values without requiring them to be valid for shutdown.
$keys = @('MILLWRIGHT_DATA_DIR', 'DISCORD_CLIENT_ID', 'DISCORD_GUILD_ID')
$previous = @{}
foreach ($key in $keys) {
    $previous[$key] = @{
        Existed = Test-Path -LiteralPath "Env:$key"
        Value = [Environment]::GetEnvironmentVariable($key, 'Process')
    }
}
try {
    foreach ($key in $keys) {
        if (-not [string]::IsNullOrWhiteSpace($settings[$key])) {
            [Environment]::SetEnvironmentVariable($key, $settings[$key], 'Process')
        } elseif ([string]::IsNullOrWhiteSpace($previous[$key].Value)) {
            # Placeholders permit Compose interpolation for teardown only.
            [Environment]::SetEnvironmentVariable($key, 'shutdown-placeholder', 'Process')
        }
    }
    & docker compose --project-directory $root -f $composeFile --profile middleware down --remove-orphans
    if ($LASTEXITCODE -ne 0) { throw 'Docker Compose shutdown failed; network resources were not removed.' }
} finally {
    foreach ($key in $keys) {
        if ($previous[$key].Existed) {
            [Environment]::SetEnvironmentVariable($key, $previous[$key].Value, 'Process')
        } else {
            Remove-Item -LiteralPath "Env:$key" -ErrorAction SilentlyContinue
        }
    }
}
# Never remove a foreign router mapping. A failure leaves the ownership record
# intact and is reported rather than silently ignored.
if ($CleanupNetwork) {
    & (Join-Path $PSScriptRoot 'Set-PortForwardingConfig.ps1') -EnvPath $envFile -CleanupNetwork
} else {
    & (Join-Path $PSScriptRoot 'Set-PortForwardingConfig.ps1') -EnvPath $envFile -RemoveOwnedUpnp
}
Write-Host 'Millwright stopped. Persistent deployment data preserved.'
