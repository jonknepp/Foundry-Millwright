#requires -Version 7.0
[CmdletBinding()]
param(
    [switch]$ValidateOnly,
    [switch]$ForceRebuild
)

$ErrorActionPreference = 'Stop'
if ($ValidateOnly -and $ForceRebuild) { throw '-ValidateOnly and -ForceRebuild cannot be used together.' }
$root = Split-Path -Parent $PSScriptRoot
$composeFile = Join-Path $root 'compose.yml'
$envFile = Join-Path $root '.env'

if (-not (Test-Path -LiteralPath $composeFile -PathType Leaf)) { throw "Missing Compose file: $composeFile" }
if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) { throw "Missing .env: $envFile" }

$settings = @{}
foreach ($line in [IO.File]::ReadAllLines($envFile)) {
    if ($line -match '^\s*(?:#|$)') { continue }
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$') {
        $settings[$Matches[1]] = $Matches[2].Trim().Trim('"', "'")
    }
}

foreach ($key in 'MILLWRIGHT_DATA_DIR', 'DISCORD_CLIENT_ID', 'DISCORD_GUILD_ID') {
    if ([string]::IsNullOrWhiteSpace($settings[$key])) { throw "Missing $key in .env" }
}
foreach ($key in 'DISCORD_CLIENT_ID', 'DISCORD_GUILD_ID') {
    if ($settings[$key] -notmatch '^\d{17,20}$') { throw "Invalid Discord snowflake: $key" }
}

$lifetime = if ([string]::IsNullOrWhiteSpace($settings['MILLWRIGHT_AUTH_TOKEN_LIFETIME'])) {
    '604800'
} else {
    $settings['MILLWRIGHT_AUTH_TOKEN_LIFETIME']
}
$parsedLifetime = 0L
if (-not [long]::TryParse($lifetime, [ref]$parsedLifetime) -or $parsedLifetime -le 0) {
    throw 'MILLWRIGHT_AUTH_TOKEN_LIFETIME must be a positive integer (seconds).'
}

$dataRoot = [Environment]::ExpandEnvironmentVariables($settings['MILLWRIGHT_DATA_DIR'])
if (-not [IO.Path]::IsPathRooted($dataRoot)) { $dataRoot = Join-Path $root $dataRoot }
$caddyfile = Join-Path $dataRoot 'config/ingress/Caddyfile'
if (-not (Test-Path -LiteralPath $caddyfile -PathType Leaf)) {
    throw "Missing primary Caddyfile: $caddyfile"
}

# Match the fixed file-backed secret paths declared in compose.yml.
$secretPath = Join-Path $dataRoot 'secrets/discord-client-secret'
if (-not (Test-Path -LiteralPath $secretPath -PathType Leaf)) {
    throw "Discord client secret file missing: $secretPath"
}
if ((Get-Item -LiteralPath $secretPath).Length -eq 0) {
    throw "Discord client secret file is empty: $secretPath"
}

$signingPath = Join-Path $dataRoot 'secrets/authcrunch-signing-key'
if (-not (Test-Path -LiteralPath $signingPath -PathType Leaf)) {
    throw "Signing key missing: $signingPath (run Install-Millwright.ps1)"
}
if ((Get-Item -LiteralPath $signingPath).Length -eq 0) {
    throw "Signing key file is empty: $signingPath"
}

# The felddy image installs from a version-specific ZIP in /data/container_cache.
# Initialization retains the operator's original archive name under sources/.
$archiveSetting = [string]$settings['FOUNDRY_ARCHIVE']
if ([string]::IsNullOrWhiteSpace($archiveSetting)) { throw 'FOUNDRY_ARCHIVE is missing; rerun storage initialization.' }
$archivePath = [Environment]::ExpandEnvironmentVariables($archiveSetting)
if (-not [IO.Path]::IsPathRooted($archivePath)) { $archivePath = Join-Path $dataRoot $archivePath }
if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) { throw "Managed Foundry archive missing: $archivePath" }
$cacheDir = Join-Path $dataRoot 'foundry/container_cache'
$cacheArchive = Join-Path $cacheDir 'foundryvtt-14.369.zip'
if ($ValidateOnly) {
    Write-Host "Managed Foundry archive verified: $archivePath"
} else {
    if (-not (Test-Path -LiteralPath $cacheDir -PathType Container)) {
        New-Item -ItemType Directory -Path $cacheDir -Force -ErrorAction Stop | Out-Null
    }
    $sourceHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash
    $cacheReady = (Test-Path -LiteralPath $cacheArchive -PathType Leaf) -and
        ((Get-FileHash -LiteralPath $cacheArchive -Algorithm SHA256).Hash -eq $sourceHash)
    if (-not $cacheReady) {
        $temporaryCache = Join-Path $cacheDir ('.foundry-' + [guid]::NewGuid().ToString('N') + '.tmp')
        try {
            Copy-Item -LiteralPath $archivePath -Destination $temporaryCache -ErrorAction Stop
            if ((Get-FileHash -LiteralPath $temporaryCache -Algorithm SHA256).Hash -ne $sourceHash) {
                throw 'Foundry container cache archive checksum verification failed.'
            }
            Move-Item -LiteralPath $temporaryCache -Destination $cacheArchive -Force -ErrorAction Stop
        } finally {
            Remove-Item -LiteralPath $temporaryCache -Force -ErrorAction SilentlyContinue
        }
    }
    Write-Host "Foundry container cache ready: $cacheArchive"
}

# The Foundry data directory is persistent; deploy the bundled world module there
# on each startup so fresh installs and repository updates both receive it.
& (Join-Path $PSScriptRoot 'Install-FoundryModule.ps1') -DataRoot $dataRoot -ValidateOnly:$ValidateOnly
if (-not $?) { throw 'Bundled Foundry module deployment failed.' }

# Network reconciliation is the sole source of the current LAN address.
# The shared network configuration script discovers the selected interface and
# handles UPnP; the firewall is a separate OS-specific implementation.
$hostPort = 8443
if (-not [string]::IsNullOrWhiteSpace($settings['MILLWRIGHT_HTTPS_PORT']) -and
    (-not [int]::TryParse($settings['MILLWRIGHT_HTTPS_PORT'], [ref]$hostPort) -or $hostPort -lt 1 -or $hostPort -gt 65535)) {
    throw 'Invalid MILLWRIGHT_HTTPS_PORT.'
}
$forwardingScript = Join-Path $PSScriptRoot 'Set-PortForwardingConfig.ps1'
if ($ValidateOnly) {
    $lanIP = & $forwardingScript -EnvPath $envFile -CheckOnly -PassThruLanIP
} else {
    $lanIP = & $forwardingScript -EnvPath $envFile -Reconcile -PassThruLanIP
}
if ($lanIP -notmatch '^\d{1,3}(\.\d{1,3}){3}$') { throw 'Network reconciliation returned an invalid LAN IPv4 address.' }
Write-Host "Detected host LAN IPv4: $lanIP"

# Preserve any environment values that existed before this script was invoked.
$keys = @(
    'MILLWRIGHT_DATA_DIR', 'DISCORD_CLIENT_ID', 'DISCORD_GUILD_ID',
    'MILLWRIGHT_AUTH_TOKEN_LIFETIME'
)
$previous = @{}
foreach ($key in $keys) {
    $previous[$key] = @{
        Existed = Test-Path -LiteralPath "Env:$key"
        Value = [Environment]::GetEnvironmentVariable($key, 'Process')
    }
}

try {
    [Environment]::SetEnvironmentVariable('MILLWRIGHT_DATA_DIR', $dataRoot, 'Process')
    foreach ($key in 'DISCORD_CLIENT_ID', 'DISCORD_GUILD_ID') {
        [Environment]::SetEnvironmentVariable($key, $settings[$key], 'Process')
    }
    [Environment]::SetEnvironmentVariable('MILLWRIGHT_AUTH_TOKEN_LIFETIME', $lifetime, 'Process')
    & docker compose --project-directory $root -f $composeFile --profile middleware config --quiet
    if ($LASTEXITCODE -ne 0) { throw 'Docker Compose validation failed' }
    Write-Host 'Primary Compose configuration validated.'

    if (-not $ValidateOnly) {
        $upArguments = @('compose', '--project-directory', $root, '-f', $composeFile, '--profile', 'middleware', 'up', '-d')
        if ($ForceRebuild) {
            Write-Host 'Force rebuild requested: rebuilding locally built images before startup.'
            $upArguments += '--build'
        }
        $upArguments += @('middleware', 'foundry', 'restart-helper', 'caddy')
        & docker @upArguments
        if ($LASTEXITCODE -ne 0) { throw 'Docker Compose startup failed' }

        # Query the actual middleware bootstrap state. Never infer completion from
        # the presence of a secret or from a successful container start.
        $challengePath = Join-Path $dataRoot 'secrets/administrator-bootstrap-challenge'
        if (-not (Test-Path -LiteralPath $challengePath -PathType Leaf)) {
            throw "Administrator bootstrap challenge file missing: $challengePath"
        }
        $bootstrapQuery = @'
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/var/lib/millwright/millwright.sqlite', { readOnly: true });
try {
  const row = db.prepare('SELECT completed_at FROM administrator_bootstrap WHERE id = 1').get();
  if (!row) process.exitCode = 2;
  else process.stdout.write(row.completed_at === null ? 'PENDING' : 'COMPLETE');
} finally { db.close(); }
'@
        # Middleware may still be initializing SQLite immediately after Compose starts it.
        # Give initialization a brief head start, then retry transient query failures.
        Start-Sleep -Milliseconds 500
        $bootstrapState = $null
        $bootstrapQuerySucceeded = $false
        for ($attempt = 1; $attempt -le 10; $attempt++) {
            $queryOutput = & docker exec millwright-middleware-1 node --disable-warning=ExperimentalWarning -e $bootstrapQuery 2>&1
            if ($LASTEXITCODE -eq 0 -and $queryOutput -in @('PENDING', 'COMPLETE')) {
                $bootstrapState = [string]$queryOutput
                $bootstrapQuerySucceeded = $true
                break
            }
            if ($attempt -lt 10) { Start-Sleep -Milliseconds 500 }
        }
        if (-not $bootstrapQuerySucceeded) {
            Write-Warning 'Unable to verify administrator bootstrap status; challenge not displayed.'
        } elseif ($bootstrapState -eq 'PENDING') {
            $challenge = [IO.File]::ReadAllText($challengePath).Trim()
            if ($challenge -notmatch '^[a-f0-9]{64}$') { throw 'Administrator bootstrap challenge is invalid.' }
            Write-Host ''
            Write-Host '=== First administrator setup ===' -ForegroundColor Cyan
            Write-Host 'Enter this one-time challenge on the Millwright Administrator Setup page:'
            Write-Host $challenge -ForegroundColor Yellow
            Write-Host 'Keep this console private. The challenge will stop appearing after a successful administrator claim.'
        } else {
            Write-Host 'Administrator bootstrap already completed.'
        }
    }
} finally {
    foreach ($key in $keys) {
        if ($previous[$key].Existed) {
            [Environment]::SetEnvironmentVariable($key, $previous[$key].Value, 'Process')
        } else {
            Remove-Item -LiteralPath "Env:$key" -ErrorAction SilentlyContinue
        }
    }
}
