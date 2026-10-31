#Requires -Version 7.0
# Shared configuration discovery. The repository .env is a link to the
# authoritative deployment .env, not a second configuration copy.
function Read-MillwrightEnv {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path)
    $settings = @{}
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Missing configuration file: $Path"
    }
    foreach ($line in [IO.File]::ReadAllLines($Path)) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
        if ($trimmed -notmatch '^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
            throw "Invalid .env entry: $trimmed"
        }
        $key = $Matches[1]
        $value = $Matches[2].Trim()
        if ($value.Length -ge 2 -and
            (($value.StartsWith('"') -and $value.EndsWith('"')) -or
             ($value.StartsWith("'") -and $value.EndsWith("'")))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        if ($settings.ContainsKey($key)) { throw "Duplicate .env key: $key" }
        $settings[$key] = $value
    }
    return $settings
}

function Assert-MillwrightDataDirectory {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$RepositoryRoot
    )
    if (-not [IO.Path]::IsPathFullyQualified($Path)) {
        throw 'MILLWRIGHT_DATA_DIR must be an absolute path.'
    }
    $data = [IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetFullPath($Path))
    $repo = [IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetFullPath($RepositoryRoot))
    $comparison = if ($IsWindows) { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
    if ($data.Equals($repo, $comparison) -or
        $data.StartsWith($repo + [IO.Path]::DirectorySeparatorChar, $comparison)) {
        throw 'MILLWRIGHT_DATA_DIR must be outside the repository.'
    }
    $parent = [IO.Directory]::GetParent($data)
    if ($null -eq $parent -or -not $parent.Exists) {
        throw "Parent directory unavailable: $Path"
    }
    return $data
}

function Assert-MillwrightEnvLink {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$RepositoryRoot,
        [Parameter(Mandatory)][string]$DataDirectory
    )
    $link = Join-Path $RepositoryRoot '.env'
    $target = Join-Path $DataDirectory '.env'
    $item = Get-Item -LiteralPath $link -Force -ErrorAction SilentlyContinue
    if ($null -eq $item) { return $false }
    if ($item.LinkType -ne 'SymbolicLink') {
        throw "Repository .env is a regular file, not a symbolic link: $link. Migrate it explicitly; it will not be overwritten."
    }
    $resolvedTarget = [IO.Path]::GetFullPath([string]$item.Target)
    $expectedTarget = [IO.Path]::GetFullPath($target)
    $comparison = if ($IsWindows) { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
    if (-not $resolvedTarget.Equals($expectedTarget, $comparison)) {
        throw "Repository .env points to another deployment: $resolvedTarget"
    }
    if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
        throw "Repository .env link is broken: $target"
    }
    return $true
}
