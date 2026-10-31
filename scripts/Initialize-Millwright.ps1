#Requires -Version 7.0
[CmdletBinding()]
param(
    [string]$OperatorSid,
    [string]$ElevationLog,
    [string]$SelectedDataDirectory,
    [string]$SelectedArchive
)

$ErrorActionPreference = 'Stop'

try {
    if (-not $ElevationLog) {
        Write-Host ''
        Write-Host '=== Foundry-Millwright | Storage Initialization ===' -ForegroundColor Cyan
        Write-Host 'This setup prepares the persistent storage used by your Foundry hosting environment.'
        Write-Host 'It will identify your data directory and Foundry Node.js ZIP, validate both paths,'
        Write-Host 'create or reuse configuration, and initialize required folders and local secrets.'
        Write-Host 'Existing configuration and deployment data are preserved where possible.'
        Write-Host 'This step does not start Foundry, configure Discord, or expose services to the internet.'
        Write-Host ''
    }
    $repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
    . (Join-Path $PSScriptRoot 'MillwrightConfiguration.ps1')
    . (Join-Path $PSScriptRoot 'Select-MillwrightPaths.ps1')
    $envFile = Join-Path $repositoryRoot '.env'
    $existingItem = Get-Item -LiteralPath $envFile -Force -ErrorAction SilentlyContinue
    if (-not $SelectedDataDirectory) {
        Write-Host '[1/4] Locate persistent deployment storage.' -ForegroundColor Cyan
        if ($null -ne $existingItem) {
            if ($existingItem.LinkType -eq 'SymbolicLink') {
                $linkTarget = [string]$existingItem.Target
                if (-not [IO.Path]::IsPathFullyQualified($linkTarget)) {
                    $linkTarget = [IO.Path]::GetFullPath((Join-Path $repositoryRoot $linkTarget))
                }
                $SelectedDataDirectory = Split-Path -Parent $linkTarget
            }
            elseif (Test-Path -LiteralPath $envFile -PathType Leaf) {
                throw 'Existing repository .env is a regular file. Migration must be performed explicitly; no files changed.'
            }
            else {
                throw "Repository .env is not a usable file: $envFile"
            }
        }
        else {
            Write-Host 'Select the directory for persistent Millwright configuration and data.'
            $SelectedDataDirectory = Select-MillwrightFolder
            Write-Host "Selected persistent data directory: $SelectedDataDirectory"
        }
    }
    Write-Host 'Validating persistent data directory...'
    $SelectedDataDirectory = Assert-MillwrightDataDirectory -Path $SelectedDataDirectory -RepositoryRoot $repositoryRoot
    Write-Host "Validated data directory: $SelectedDataDirectory"
    $persistentEnv = Join-Path $SelectedDataDirectory '.env'
    if ($null -ne $existingItem) {
        $null = Assert-MillwrightEnvLink -RepositoryRoot $repositoryRoot -DataDirectory $SelectedDataDirectory
    }
    if (Test-Path -LiteralPath $persistentEnv -PathType Leaf) {
        Write-Host "Found existing persistent configuration: $persistentEnv"
        $persistentSettings = Read-MillwrightEnv -Path $persistentEnv
        if ([string]::IsNullOrWhiteSpace($persistentSettings['MILLWRIGHT_DATA_DIR'])) {
            throw "Existing deployment .env is missing MILLWRIGHT_DATA_DIR: $persistentEnv"
        }
        if (-not ([IO.Path]::GetFullPath($persistentSettings['MILLWRIGHT_DATA_DIR']).Equals(
                $SelectedDataDirectory, [StringComparison]::OrdinalIgnoreCase))) {
            throw "Existing deployment .env identifies a different data directory: $($persistentSettings['MILLWRIGHT_DATA_DIR'])"
        }
    }
    elseif ($null -ne $existingItem) {
        throw "Missing persistent configuration: $persistentEnv"
    }
    if (-not $SelectedArchive) {
        Write-Host '[2/4] Locate the Foundry Node.js distribution ZIP.' -ForegroundColor Cyan
        $configuredArchive = if (Test-Path -LiteralPath $persistentEnv -PathType Leaf) {
            (Read-MillwrightEnv -Path $persistentEnv)['FOUNDRY_ARCHIVE']
        } else { '' }
        if ($configuredArchive -and (Test-Path -LiteralPath $configuredArchive -PathType Leaf)) {
            $SelectedArchive = $configuredArchive
        }
        else {
            if ($ElevationLog) { throw 'Archive selection was not passed to the elevated initializer.' }
            Write-Host 'Select the Foundry VTT Node.js distribution ZIP archive.'
            $SelectedArchive = Select-MillwrightFoundryArchive
            Write-Host "Selected Foundry archive: $SelectedArchive"
        }
    }
    if (-not (Test-Path -LiteralPath $SelectedArchive -PathType Leaf) -or
        [IO.Path]::GetExtension($SelectedArchive) -ine '.zip') {
        throw "Foundry archive must be an existing ZIP: $SelectedArchive"
    }
    $SelectedArchive = [IO.Path]::GetFullPath($SelectedArchive)
    Write-Host "Using Foundry archive: $SelectedArchive"
    if ($IsWindows) {
        Write-Host '[3/4] Prepare administrator-authorized initialization.' -ForegroundColor Cyan
        $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
        if (-not $OperatorSid) { $OperatorSid = $identity.User.Value }
        try {
            $null = [System.Security.Principal.SecurityIdentifier]::new($OperatorSid)
        }
        catch {
            throw "Invalid operator SID: $($_.Exception.Message)"
        }
        $isAdmin = [System.Security.Principal.WindowsPrincipal]::new($identity).IsInRole(
            [System.Security.Principal.WindowsBuiltInRole]::Administrator)
        if (-not $isAdmin) {
            $log = Join-Path ([System.IO.Path]::GetTempPath()) ('millwright-init-' + [guid]::NewGuid().ToString('N') + '.log')
            try {
                Write-Host "Persistent data directory: $SelectedDataDirectory"
                Write-Host "Foundry archive: $SelectedArchive"
                Write-Host ''
                Write-Host 'Administrator approval required' -ForegroundColor Yellow
                Write-Host 'The next steps create the persistent configuration link, initialize protected'
                Write-Host 'storage, and apply filesystem permissions. These operations require elevation.'
                Write-Host 'After you continue, Windows will display a User Account Control (UAC) prompt.'
                Write-Host 'Approve that prompt to continue initialization.'
                Write-Host ''
                $confirmation = Read-Host 'Press Enter to request administrator access, or type C to cancel'
                if ($confirmation.Trim() -ne '') {
                    if ($confirmation.Trim() -match '^(?i:c|cancel)$') {
                        throw 'Initialization cancelled before administrator elevation.'
                    }
                    throw 'Unrecognized response. Initialization stopped before elevation; rerun to continue.'
                }
                Write-Host 'Requesting administrator approval from Windows...'
                # Pass arguments individually. ProcessStartInfo quotes Windows paths correctly,
                # including spaces and embedded quotation marks.
                $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
                $startInfo.FileName = (Get-Process -Id $PID).Path
                $startInfo.UseShellExecute = $true
                $startInfo.Verb = 'runas'
                foreach ($argument in @(
                    '-NoProfile', '-File', $PSCommandPath,
                    '-OperatorSid', $OperatorSid,
                    '-ElevationLog', $log,
                    '-SelectedDataDirectory', $SelectedDataDirectory,
                    '-SelectedArchive', $SelectedArchive
                )) {
                    $startInfo.ArgumentList.Add([string]$argument)
                }
                $child = [System.Diagnostics.Process]::Start($startInfo)
                if ($null -eq $child) { throw 'Windows did not start the elevated initializer.' }
                try {
                    $child.WaitForExit()
                    $elevatedExitCode = $child.ExitCode
                }
                finally { $child.Dispose() }
                if (Test-Path -LiteralPath $log -PathType Leaf) {
                    $lines = @(Get-Content -LiteralPath $log -ErrorAction Stop)
                    $markers = @(
                        for ($i = 0; $i -lt $lines.Count; $i++) {
                            if ($lines[$i] -eq '**********************') { $i }
                        }
                    )
                    # Transcript format: opening separator, header closing separator,
                    # footer opening separator, final separator.
                    if ($markers.Count -ge 4) {
                        for ($i = $markers[1] + 1; $i -lt $markers[$markers.Count - 2]; $i++) {
                            Write-Host $lines[$i]
                        }
                    }
                    else {
                        foreach ($line in $lines) { Write-Host $line }
                    }
                }
                if ($elevatedExitCode -ne 0) {
                    throw "Elevated initialization failed (exit code $elevatedExitCode)."
                }
                return
            }
            finally {
                Remove-Item -LiteralPath $log -Force -ErrorAction SilentlyContinue
            }
        }
        if ($ElevationLog) {
            # Capture host output and errors for the unelevated caller.
            Start-Transcript -LiteralPath $ElevationLog -Force -ErrorAction Stop | Out-Null
        }
    }
    Write-Host '[4/4] Initialize persistent configuration, managed archive, directories, and secrets.' -ForegroundColor Cyan
    Write-Host 'Preparing persistent storage and configuration...'
    if (-not (Test-Path -LiteralPath $SelectedDataDirectory -PathType Container)) {
        New-Item -ItemType Directory -Path $SelectedDataDirectory -ErrorAction Stop | Out-Null
    }
    if (-not (Test-Path -LiteralPath $persistentEnv -PathType Leaf)) {
        $template = Join-Path $repositoryRoot '.env.example'
        if (-not (Test-Path -LiteralPath $template -PathType Leaf)) { throw "Missing template: $template" }
        $lines = [IO.File]::ReadAllLines($template)
        $found = $false
        for ($i = 0; $i -lt $lines.Length; $i++) {
            if ($lines[$i] -match '^MILLWRIGHT_DATA_DIR=') {
                $lines[$i] = 'MILLWRIGHT_DATA_DIR=' + $SelectedDataDirectory.Replace([IO.Path]::DirectorySeparatorChar, '/')
                $found = $true
            }
        }
        if (-not $found) { throw 'Template lacks MILLWRIGHT_DATA_DIR.' }
        $tempEnv = Join-Path $SelectedDataDirectory ('.env.' + [guid]::NewGuid().ToString('N') + '.tmp')
        try {
            [IO.File]::WriteAllLines($tempEnv, $lines, [Text.UTF8Encoding]::new($false))
            Move-Item -LiteralPath $tempEnv -Destination $persistentEnv -ErrorAction Stop
        }
        finally { Remove-Item -LiteralPath $tempEnv -Force -ErrorAction SilentlyContinue }
        Write-Host "Created persistent configuration: $persistentEnv"
    }
    if (-not (Assert-MillwrightEnvLink -RepositoryRoot $repositoryRoot -DataDirectory $SelectedDataDirectory)) {
        New-Item -ItemType SymbolicLink -Path $envFile -Target $persistentEnv -ErrorAction Stop | Out-Null
        Write-Host "Linked repository configuration: $envFile -> $persistentEnv"
    }
    Write-Host 'Validating Foundry archive contents...'
    # Copy the selected archive to persistent storage, verifying its checksum.
    $zip = [System.IO.Compression.ZipFile]::OpenRead($SelectedArchive)
    try {
        $foundPackage = $false
        foreach ($entry in $zip.Entries) {
            if ($entry.FullName.EndsWith('/package.json') -or $entry.FullName -eq 'package.json') {
                $foundPackage = $true
                break
            }
        }
        if (-not $foundPackage) { throw 'Selected ZIP does not contain a Node.js package.json.' }
    }
    finally { $zip.Dispose() }

    Write-Host 'Foundry archive structure validated.'
    $sources = Join-Path $SelectedDataDirectory 'sources'
    New-Item -ItemType Directory -Path $sources -Force | Out-Null
    $destination = Join-Path $sources ([IO.Path]::GetFileName($SelectedArchive))
    Write-Host 'Preparing the managed Foundry distribution archive...'
    Write-Host "  Source:      $SelectedArchive"
    Write-Host "  Destination: $destination"
    if (-not ([IO.Path]::GetFullPath($SelectedArchive).Equals([IO.Path]::GetFullPath($destination), [StringComparison]::OrdinalIgnoreCase))) {
        $hash = (Get-FileHash -LiteralPath $SelectedArchive -Algorithm SHA256).Hash
        if (Test-Path -LiteralPath $destination -PathType Leaf) {
            if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -ne $hash) {
                throw "Different archive already exists: $destination"
            }
            Write-Host 'Archive already present; SHA-256 checksum matches. No copy needed.'
        }
        else {
            $temporary = Join-Path $sources ('.archive-' + [guid]::NewGuid().ToString('N') + '.tmp')
            try {
                Write-Host 'Copying archive to persistent storage (this may take a moment)...'
                Copy-Item -LiteralPath $SelectedArchive -Destination $temporary -ErrorAction Stop
                if ((Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash -ne $hash) {
                    throw 'Archive checksum verification failed.'
                }
                Move-Item -LiteralPath $temporary -Destination $destination -ErrorAction Stop
                Write-Host 'Archive copy complete. SHA-256 verification passed.'
            }
            finally { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
        }
    }
    else {
        Write-Host 'Selected archive is already in the managed location. No copy needed.'
    }
    Write-Host "Managed Foundry archive ready: $destination"

    Write-Host "Configuring managed archive path: $destination"
    $lines = [IO.File]::ReadAllLines($persistentEnv)
    $archiveLine = 'FOUNDRY_ARCHIVE=' + $destination.Replace([IO.Path]::DirectorySeparatorChar, '/')
    $foundArchiveLine = $false
    for ($i = 0; $i -lt $lines.Length; $i++) {
        if ($lines[$i].StartsWith('FOUNDRY_ARCHIVE=')) {
            $lines[$i] = $archiveLine
            $foundArchiveLine = $true
        }
    }
    if (-not $foundArchiveLine) { $lines += $archiveLine }
    $temporaryEnv = Join-Path $SelectedDataDirectory ('.env-' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [IO.File]::WriteAllLines($temporaryEnv, $lines, [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temporaryEnv -Destination $persistentEnv -Force -ErrorAction Stop
    }
    finally { Remove-Item -LiteralPath $temporaryEnv -Force -ErrorAction SilentlyContinue }
    Write-Host 'Reading persistent configuration through repository link...'
    $settings = Read-MillwrightEnv -Path $envFile

    $dataDir = $settings['MILLWRIGHT_DATA_DIR']
    if ([string]::IsNullOrWhiteSpace($dataDir)) {
        throw 'MILLWRIGHT_DATA_DIR must be set in .env.'
    }
    if (-not [System.IO.Path]::IsPathFullyQualified($dataDir)) {
        throw 'MILLWRIGHT_DATA_DIR must be an absolute path.'
    }

    $dataDir = [System.IO.Path]::GetFullPath($dataDir)
    if (-not $dataDir.Equals($SelectedDataDirectory, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Persistent .env data directory does not match selected deployment.'
    }
    $repoCanonical = [System.IO.Path]::TrimEndingDirectorySeparator($repositoryRoot)
    $dataCanonical = [System.IO.Path]::TrimEndingDirectorySeparator($dataDir)
    $comparison = if ($IsWindows) { [System.StringComparison]::OrdinalIgnoreCase } else { [System.StringComparison]::Ordinal }
    $separator = [System.IO.Path]::DirectorySeparatorChar

    if ($dataCanonical.Equals($repoCanonical, $comparison) -or
        $dataCanonical.StartsWith($repoCanonical + $separator, $comparison)) {
        throw 'MILLWRIGHT_DATA_DIR must be outside the repository.'
    }

    # Require the parent directory to exist: never silently recreate a missing mount or drive.
    $parent = [System.IO.Directory]::GetParent($dataCanonical)
    if ($null -eq $parent -or -not $parent.Exists) {
        throw "Parent directory is unavailable: $($parent.FullName). Check that the storage device is mounted."
    }

    $directories = @(
        'config', 'config/ingress', 'config/auth', 'config/dns',
        'secrets', 'certificates', 'certificates/caddy', 'foundry', 'foundry/Config',
        'config/ingress/caddy-state', 'middleware', 'backups', 'logs'
    )

    if (-not (Test-Path -LiteralPath $dataCanonical -PathType Container)) {
        New-Item -ItemType Directory -Path $dataCanonical -ErrorAction Stop | Out-Null
        Write-Host "Created: $dataCanonical"
    }

    foreach ($relativePath in $directories) {
        $path = Join-Path $dataCanonical $relativePath
        if (Test-Path -LiteralPath $path) {
            if (-not (Test-Path -LiteralPath $path -PathType Container)) {
                throw "Expected a directory but found a file: $path"
            }
            Write-Host "Exists:  $path"
        }
        else {
            New-Item -ItemType Directory -Path $path -ErrorAction Stop | Out-Null
            Write-Host "Created: $path"
        }
    }

    if ($IsWindows) {
        . (Join-Path $PSScriptRoot 'Initialize-MillwrightPermissions.ps1')
        $currentSid = [System.Security.Principal.SecurityIdentifier]::new($OperatorSid)
    }
    else {
        Write-Warning 'Windows ACL hardening skipped on non-Windows host.'
    }

    # Confirm the storage is writable without altering existing data.
    $probe = Join-Path $dataCanonical ([System.IO.Path]::GetRandomFileName())
    try {
        [System.IO.File]::WriteAllText($probe, 'Millwright write test')
    }
    finally {
        if (Test-Path -LiteralPath $probe) { Remove-Item -LiteralPath $probe -Force }
    }

    # Generate once. Never overwrite an existing proxy authentication secret.
    $proxyKeyPath = Join-Path $dataCanonical 'secrets/middleware-proxy-key'
    if (-not (Test-Path -LiteralPath $proxyKeyPath)) {
        $bytes = [byte[]]::new(32)
        [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
        $key = [Convert]::ToHexString($bytes).ToLowerInvariant()
        [System.IO.File]::WriteAllText($proxyKeyPath, $key)
        Write-Host 'Created middleware proxy authentication secret.'
    }
    elseif (-not (Test-Path -LiteralPath $proxyKeyPath -PathType Leaf)) {
        throw "Expected a file: $proxyKeyPath"
    }

    # Generate the one-time administrator claim challenge; never rotate it on reinitialization.
    $bootstrapPath = Join-Path $dataCanonical 'secrets/administrator-bootstrap-challenge'
    if (-not (Test-Path -LiteralPath $bootstrapPath)) {
        $bytes = [byte[]]::new(32)
        [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
        $challenge = [Convert]::ToHexString($bytes).ToLowerInvariant()
        [System.IO.File]::WriteAllText($bootstrapPath, $challenge)
        Write-Host 'Created administrator bootstrap challenge (retrieve from the protected secrets directory).'
    }
    elseif (-not (Test-Path -LiteralPath $bootstrapPath -PathType Leaf)) {
        throw "Expected a file: $bootstrapPath"
    }

    # Generate once. Never overwrite the persistent service credential encryption key.
    $credentialKeyPath = Join-Path $dataCanonical 'secrets/service-credential-key'
    if (-not (Test-Path -LiteralPath $credentialKeyPath)) {
        $bytes = [byte[]]::new(32)
        [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
        [System.IO.File]::WriteAllText($credentialKeyPath, [Convert]::ToHexString($bytes).ToLowerInvariant())
        Write-Host 'Created service credential encryption key. Back up this secret securely.'
    }
    elseif (-not (Test-Path -LiteralPath $credentialKeyPath -PathType Leaf)) {
        throw "Expected a file: $credentialKeyPath"
    }
    else {
        $existingCredentialKey = [System.IO.File]::ReadAllText($credentialKeyPath)
        if ($existingCredentialKey.Trim() -cnotmatch '^[0-9a-f]{64}$') {
            throw "Invalid service credential encryption key: $credentialKeyPath"
        }
    }

    # Provision ingress templates without replacing operator configuration.
    foreach ($caddyFileName in @('Caddyfile')) {
        $caddyTemplate = Join-Path $repositoryRoot "config/ingress/$caddyFileName"
        $caddyDestination = Join-Path $dataCanonical "config/ingress/$caddyFileName"

        if (Test-Path -LiteralPath $caddyDestination) {
            if (-not (Test-Path -LiteralPath $caddyDestination -PathType Leaf)) {
                throw "Expected a Caddyfile but found a directory: $caddyDestination"
            }
            Write-Host "Preserved existing Caddyfile: $caddyDestination"
        }
        else {
            if (-not (Test-Path -LiteralPath $caddyTemplate -PathType Leaf)) {
                throw "Missing repository Caddyfile template: $caddyTemplate"
            }
            Copy-Item -LiteralPath $caddyTemplate -Destination $caddyDestination -ErrorAction Stop
            Write-Host "Installed Caddyfile: $caddyDestination"
        }
    }

    # Harden sensitive files after all initialization writes. Restricting the
    # entire data root would interfere with Docker Desktop / WSL2 bind mounts.
    if ($IsWindows) {
        Write-Host 'Applying restrictive Windows ACLs to persistent configuration and secrets...'
        Set-MillwrightAcl -Path $persistentEnv -OperatorSid $currentSid
        $secretRoot = Join-Path $dataCanonical 'secrets'
        Set-MillwrightAcl -Path $secretRoot -OperatorSid $currentSid
        foreach ($secretItem in @(Get-ChildItem -LiteralPath $secretRoot -Force -Recurse -ErrorAction Stop)) {
            if ($secretItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Refusing to apply ACLs through a link in secrets directory: $($secretItem.FullName)"
            }
            Set-MillwrightAcl -Path $secretItem.FullName -OperatorSid $currentSid
        }
        Write-Host 'Sensitive configuration and secret ACLs verified.'
    }

    Write-Host ""
    Write-Host "Storage initialization complete: $dataCanonical" -ForegroundColor Green
    Write-Host "Persistent configuration: $persistentEnv"
    Write-Host "Managed Foundry ZIP: $destination"
    Write-Host "Repository configuration link: $envFile"
    Write-Host "No services have been started. Continue with the remaining deployment configuration before starting Millwright."
}
catch {
    Write-Host "Initialization failed: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
finally {
    if ($ElevationLog) {
        try { Stop-Transcript -ErrorAction SilentlyContinue | Out-Null } catch {}
    }
}
