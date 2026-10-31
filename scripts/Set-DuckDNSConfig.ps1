#Requires -Version 7.0
<#
.SYNOPSIS
    Configure Millwright's DuckDNS hostname and API token.
.DESCRIPTION
    Preserves existing values unless -Reconfigure is specified. Writes the
    DuckDNS token to persistent storage, not to .env. Does not contact DuckDNS
    or modify public DNS records; API verification is a separate step.
.EXAMPLE
    pwsh ./scripts/Set-DuckDNSConfig.ps1
.EXAMPLE
    pwsh ./scripts/Set-DuckDNSConfig.ps1 -Reconfigure
#>
[CmdletBinding()]
param(
    [string] $EnvPath = (Join-Path (Split-Path -Parent $PSScriptRoot) '.env'),
    [switch] $Reconfigure
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($IsWindows) { . (Join-Path $PSScriptRoot 'Initialize-MillwrightPermissions.ps1') }
function Protect-MillwrightWrittenFile([string]$Path) {
    if ($IsWindows) {
        $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
        Set-MillwrightAcl -Path $Path -OperatorSid $sid
    }
}

function Read-DotEnv([string] $Path) {
    $values = [ordered]@{}
    if (Test-Path -LiteralPath $Path) {
        foreach ($line in [IO.File]::ReadAllLines($Path)) {
            if ($line -match '^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') {
                $value = $Matches[2]
                if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) {
                    $value = $value.Substring(1, $value.Length - 2)
                } else { $value = ($value -replace '\s+#.*$', '').Trim() }
                $values[$Matches[1]] = $value
            }
        }
    }
    return $values
}

function Save-DotEnv([string] $Path, [System.Collections.IDictionary] $Updates) {
    # Write to the persistent target, never replace the repository's .env symlink.
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        if ($item.LinkType -ne 'SymbolicLink' -or -not $item.Target) {
            throw "Unsupported .env link: $Path"
        }
        $target = [string]$item.Target
        if (-not [IO.Path]::IsPathRooted($target)) {
            $target = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $Path) $target))
        }
        if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
            throw "Persistent .env link target is missing: $target"
        }
        $Path = $target
    }

    [string[]] $lines = if (Test-Path -LiteralPath $Path) { [IO.File]::ReadAllLines($Path) } else { @() }
    foreach ($key in $Updates.Keys) {
        $value = [string]$Updates[$key]
        if ($value -match '[\r\n]') { throw "Invalid newline in configuration value: $key" }
        $entry = "$key=$value"
        $found = $false
        for ($i = 0; $i -lt $lines.Count; $i++) {
            if ($lines[$i] -match ('^\s*(?:export\s+)?' + [regex]::Escape($key) + '\s*=')) {
                if ($found) { throw "Duplicate .env key encountered: $key" }
                $lines[$i] = $entry
                $found = $true
            }
        }
        if (-not $found) { $lines = @($lines) + @($entry) }
    }
    $directory = Split-Path -Parent $Path
    $temp = Join-Path $directory ('.env.' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [IO.File]::WriteAllLines($temp, $lines, [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temp -Destination $Path -Force
        Protect-MillwrightWrittenFile $Path
    } finally { if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force } }
}

$envFile = [IO.Path]::GetFullPath($EnvPath)
if (-not (Test-Path -LiteralPath $envFile)) { throw "Missing .env file: $envFile. Initialize Millwright first." }
$settings = Read-DotEnv $envFile
$repoRoot = Split-Path -Parent $envFile
$dataRoot = [string]$settings['MILLWRIGHT_DATA_DIR']
if ([string]::IsNullOrWhiteSpace($dataRoot)) { throw 'MILLWRIGHT_DATA_DIR must be configured in .env.' }
$dataRoot = [Environment]::ExpandEnvironmentVariables($dataRoot)
if (-not [IO.Path]::IsPathRooted($dataRoot)) { $dataRoot = Join-Path $repoRoot $dataRoot }
$dataRoot = [IO.Path]::GetFullPath($dataRoot)
if (-not (Test-Path -LiteralPath $dataRoot -PathType Container)) { throw "Persistent data directory not found: $dataRoot" }

$provider = [string]$settings['MILLWRIGHT_DNS_PROVIDER']
if ($provider -and $provider -ne 'duckdns' -and -not $Reconfigure) {
    throw "DNS provider is '$provider'. Use -Reconfigure to switch to DuckDNS."
}

$currentHostname = ([string]$settings['MILLWRIGHT_PUBLIC_HOSTNAME']).Trim().ToLowerInvariant()
# Always ask, offering the saved value as the default on Enter.
$answer = Read-Host "DuckDNS hostname [$currentHostname]"
$hostname = if ([string]::IsNullOrWhiteSpace($answer)) { $currentHostname } else { $answer.Trim().ToLowerInvariant() }
if ($hostname -notmatch '^(?=.{1,63}\.duckdns\.org$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.duckdns\.org$') {
    throw 'Hostname must be a single DuckDNS subdomain, e.g. example-vtt.duckdns.org.'
}

$secretDirectory = Join-Path $dataRoot 'secrets'
$secretPath = Join-Path $secretDirectory 'duckdns-token'
$hasToken = (Test-Path -LiteralPath $secretPath -PathType Leaf) -and (([IO.File]::ReadAllText($secretPath)).Trim().Length -gt 0)
$replaceToken = -not $hasToken
if ($hasToken -and $Reconfigure) {
    $response = Read-Host 'Replace existing DuckDNS token? [y/N]'
    $replaceToken = $response -match '^(?i:y|yes)$'
}
if ($replaceToken) {
    $secureToken = Read-Host 'DuckDNS API token' -AsSecureString
    $pointer = [IntPtr]::Zero
    try {
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
        $plainToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
        if ($plainToken -notmatch '^[a-zA-Z0-9-]{8,128}$') { throw 'Token has an unexpected format or is empty.' }
        if (-not (Test-Path -LiteralPath $secretDirectory)) { New-Item -ItemType Directory -Path $secretDirectory -Force | Out-Null }
        $tempSecret = Join-Path $secretDirectory ('.duckdns-token.' + [guid]::NewGuid().ToString('N') + '.tmp')
        try {
            [IO.File]::WriteAllText($tempSecret, $plainToken, [Text.UTF8Encoding]::new($false))
            if (-not $IsWindows) {
                & chmod 600 -- $tempSecret
                if ($LASTEXITCODE -ne 0) { throw 'Could not restrict token file permissions.' }
            }
            Move-Item -LiteralPath $tempSecret -Destination $secretPath -Force
            Protect-MillwrightWrittenFile $secretPath
        } finally { if (Test-Path -LiteralPath $tempSecret) { Remove-Item -LiteralPath $tempSecret -Force } }
    } finally {
        if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
        Remove-Variable plainToken -ErrorAction SilentlyContinue
    }

}

Save-DotEnv $envFile ([ordered]@{
    MILLWRIGHT_PUBLIC_HOSTNAME = $hostname
    MILLWRIGHT_DNS_PROVIDER = 'duckdns'
})
Write-Host "DuckDNS hostname: $hostname"
Write-Host "DuckDNS token: $(if ($replaceToken) { 'saved' } else { 'existing token preserved' })"
Write-Host "Configuration updated: $envFile"
Write-Host 'No DNS update or certificate request was performed.'
