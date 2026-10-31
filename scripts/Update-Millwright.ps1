#Requires -Version 7.0
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [switch]$Pull,
    [switch]$Test,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

function Invoke-Checked {
    param([string]$Executable, [string[]]$Arguments)
    Write-Host ('> ' + $Executable + ' ' + ($Arguments -join ' '))
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Executable exited with code $LASTEXITCODE" }
}

function Get-EnvValue {
    param([string]$Name)
    $file = Join-Path $root '.env'
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing .env: $file" }
    foreach ($line in [IO.File]::ReadAllLines($file)) {
        if ($line -match '^\s*' + [regex]::Escape($Name) + '\s*=\s*(.*?)\s*$') {
            $value = $Matches[1].Trim()
            if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) {
                $value = $value.Substring(1, $value.Length - 2)
            }
            return $value
        }
    }
    throw "Missing $Name in .env"
}

try {
    Push-Location $root
    try {
        if ($Pull -and -not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'Git is required when using -Pull.' }
        if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Docker CLI is required.' }
        if ($Pull) {
            $changes = @(& git status --porcelain --untracked-files=normal)
            if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect Git working tree.' }
            if ($changes.Count -gt 0) { throw 'Working tree is not clean; commit or stash changes before -Pull.' }
            if ($PSCmdlet.ShouldProcess('Git repository', 'git pull --ff-only')) {
                Invoke-Checked git @('pull', '--ff-only')
            }
        }
        $dataDir = Get-EnvValue 'MILLWRIGHT_DATA_DIR'
        if (-not [IO.Path]::IsPathFullyQualified($dataDir)) { throw 'MILLWRIGHT_DATA_DIR must be absolute.' }
        $dataDir = [IO.Path]::GetFullPath($dataDir)
        if (-not (Test-Path -LiteralPath $dataDir -PathType Container)) { throw "Persistent storage unavailable: $dataDir" }
        $moduleSource = Join-Path $root 'foundry-module'
        $moduleDestination = Join-Path $dataDir 'foundry/Data/modules/millwright'
        if (-not (Test-Path -LiteralPath (Join-Path $moduleSource 'module.json'))) { throw 'Bundled module is missing.' }
        if (-not (Test-Path -LiteralPath (Join-Path $dataDir 'foundry/Data') -PathType Container)) {
            throw 'Foundry data directory not found. Start Foundry once before deploying the module.'
        }

        $caddySource = Join-Path $root 'config/ingress/Caddyfile'
        $caddyTarget = Join-Path $dataDir 'config/ingress/Caddyfile'
        if (-not (Test-Path -LiteralPath $caddyTarget -PathType Leaf)) { throw "Missing Caddyfile: $caddyTarget" }
        if ((Get-FileHash $caddySource -Algorithm SHA256).Hash -ne (Get-FileHash $caddyTarget -Algorithm SHA256).Hash) {
            Write-Warning 'Repository and deployed Caddyfiles differ.'
            if (-not $WhatIfPreference -and (Read-Host 'Replace deployed Caddyfile? Backup will be saved. [y/N]') -match '^(y|yes)$') {
                if ($PSCmdlet.ShouldProcess($caddyTarget, 'Validate and replace Caddyfile')) {
                    $container = & docker compose --profile middleware ps -q caddy
                    if ($LASTEXITCODE -ne 0 -or -not $container) { throw 'Caddy must be running.' }
                    $candidate = '/tmp/millwright-candidate-' + [guid]::NewGuid().ToString('N')
                    try {
                        Invoke-Checked docker @('cp', $caddySource, "${container}:$candidate")
                        Invoke-Checked docker @('compose', '--profile', 'middleware', 'exec', '-T', 'caddy', 'caddy', 'validate', '--config', $candidate, '--adapter', 'caddyfile')
                        $backup = $caddyTarget + '.bak-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
                        Copy-Item -LiteralPath $caddyTarget -Destination $backup
                        try {
                            Copy-Item -LiteralPath $caddySource -Destination $caddyTarget -Force -ErrorAction Stop
                            try {
                                Invoke-Checked docker @('compose', '--profile', 'middleware', 'exec', '-T', 'caddy',
                                    'caddy', 'reload', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile')
                            }
                            catch {
                                Write-Warning 'Caddy reload failed; attempting container restart.'
                                Invoke-Checked docker @('compose', '--profile', 'middleware', 'restart', 'caddy')
                            }
                            $running = @(& docker compose --profile middleware ps --status running --services caddy)
                            if ($LASTEXITCODE -ne 0 -or $running -notcontains 'caddy') {
                                throw 'Caddy is not running after configuration activation.'
                            }
                        }
                        catch {
                            $activationError = $_.Exception.Message
                            Copy-Item -LiteralPath $backup -Destination $caddyTarget -Force -ErrorAction Stop
                            Invoke-Checked docker @('compose', '--profile', 'middleware', 'restart', 'caddy')
                            throw "Caddyfile activation failed; restored backup and restarted Caddy. $activationError"
                        }
                        Write-Host "Caddyfile updated; backup: $backup"
                    }
                    finally { & docker compose --profile middleware exec -T caddy rm -f $candidate 2>$null | Out-Null }
                }
            }
            else { Write-Host 'Deployed Caddyfile preserved.' }
        }
        else { Write-Host 'Caddyfile unchanged.' }

        if ($Test) {
            if ($PSCmdlet.ShouldProcess('Middleware test suite', 'Run TypeScript build and all *.test.ts tests in Node 22 container')) {
                Invoke-Checked docker @('run', '--rm', '-v', "${root}/middleware:/app", '-w', '/app', 'node:22-alpine', 'sh', '-c',
                    'npm install --no-audit --no-fund && npm run build && npx tsx --test src/*.test.ts')
            }
        }

        $sourceFiles = @(Get-ChildItem -LiteralPath $moduleSource -File -Recurse)
        $moduleChanged = $Force -or -not (Test-Path -LiteralPath (Join-Path $moduleDestination 'module.json'))
        if (-not $moduleChanged) {
            foreach ($file in $sourceFiles) {
                $relative = [IO.Path]::GetRelativePath($moduleSource, $file.FullName)
                $target = Join-Path $moduleDestination $relative
                if (-not (Test-Path -LiteralPath $target -PathType Leaf) -or
                    (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash -ne
                    (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash) {
                    $moduleChanged = $true
                    break
                }
            }
        }

        # A successful Compose invocation is necessary before reporting deployment success.
        if ($PSCmdlet.ShouldProcess('Millwright middleware', 'Build and recreate middleware container')) {
            Invoke-Checked docker @('compose', '--profile', 'middleware', 'up', '-d', '--build', '--no-deps', 'middleware')
        }

        if ($moduleChanged) {
            if ($PSCmdlet.ShouldProcess($moduleDestination, 'Copy bundled Foundry module and restart Foundry (interrupts active games)')) {
                New-Item -ItemType Directory -Path $moduleDestination -Force | Out-Null
                foreach ($file in $sourceFiles) {
                    $relative = [IO.Path]::GetRelativePath($moduleSource, $file.FullName)
                    $target = Join-Path $moduleDestination $relative
                    $parent = Split-Path -Parent $target
                    if (-not (Test-Path -LiteralPath $parent)) {
                        New-Item -ItemType Directory -Path $parent -Force | Out-Null
                    }
                    Copy-Item -LiteralPath $file.FullName -Destination $target -Force
                }
                Invoke-Checked docker @('compose', 'restart', 'foundry')
            }
            else {
                Write-Warning 'Foundry module deployment was declined or previewed; module update remains pending.'
            }
        }
        else { Write-Host 'Foundry module files unchanged; no Foundry restart required.' }

        if (-not $WhatIfPreference) {
            # Verify the files that the running Foundry container actually sees.
            # This catches incorrect host paths and stale container mounts.
            $containerRunning = @(& docker compose ps --status running --services foundry)
            if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect Foundry container status.' }
            if ($containerRunning -notcontains 'foundry') {
                throw 'Foundry is not running; installed module verification cannot complete.'
            }
            foreach ($file in $sourceFiles) {
                $relative = [IO.Path]::GetRelativePath($moduleSource, $file.FullName).Replace([char]92, '/')
                $containerPath = '/data/Data/modules/millwright/' + $relative
                $output = @(& docker compose exec -T foundry sha256sum $containerPath)
                if ($LASTEXITCODE -ne 0 -or $output.Count -ne 1 -or
                    $output[0] -notmatch '^([a-fA-F0-9]{64})\s+') {
                    throw "Cannot verify installed Foundry module file: $containerPath"
                }
                $expected = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
                if ($expected -ne $Matches[1]) {
                    throw "Installed Foundry module differs from repository: $relative"
                }
            }
            Write-Host "PASS: Verified $($sourceFiles.Count) Foundry module files against the running container (SHA-256)."
            Invoke-Checked docker @('compose', '--profile', 'middleware', 'ps')
        }
        Write-Host 'Update workflow finished. Review container status and application behavior before marking deployment validated.'
    }
    finally { Pop-Location }
}
catch {
    Write-Error "Millwright update failed: $($_.Exception.Message)"
    exit 1
}

