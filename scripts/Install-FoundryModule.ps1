#requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$DataRoot,
    [switch]$ValidateOnly
)
$ErrorActionPreference = 'Stop'
$source = Join-Path (Split-Path -Parent $PSScriptRoot) 'foundry-module'
$manifest = Join-Path $source 'module.json'
if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) { throw "Bundled Millwright module manifest missing: $manifest" }
$metadata = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
if ($metadata.id -ne 'millwright') { throw 'Bundled module ID must be millwright.' }
$files = @('module.json') + @(Get-ChildItem -LiteralPath (Join-Path $source 'scripts') -File -Recurse | ForEach-Object {
    [IO.Path]::GetRelativePath($source, $_.FullName)
})
foreach ($relative in $files) {
    if (-not (Test-Path -LiteralPath (Join-Path $source $relative) -PathType Leaf)) {
        throw "Bundled module file missing: $relative"
    }
}
foreach ($entry in $metadata.esmodules) {
    if (-not (Test-Path -LiteralPath (Join-Path $source $entry) -PathType Leaf)) {
        throw "Bundled module entry point missing: $entry"
    }
}
$target = Join-Path $DataRoot 'foundry/Data/modules/millwright'
if (Test-Path -LiteralPath $target) {
    $item = Get-Item -LiteralPath $target -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "Refusing to modify linked module directory: $target"
    }
    $installedManifest = Join-Path $target 'module.json'
    if (Test-Path -LiteralPath $installedManifest -PathType Leaf) {
        $installed = Get-Content -LiteralPath $installedManifest -Raw | ConvertFrom-Json
        if ($installed.id -ne 'millwright') { throw "Module directory belongs to another module: $target" }
    } elseif (@(Get-ChildItem -LiteralPath $target -Force).Count -gt 0) {
        throw "Refusing to overwrite unrecognized module directory: $target"
    }
}
# Reject junctions/symlinks anywhere along the destination path, including
# the persistent data root and intermediate module subdirectories.
function Assert-UnlinkedPath([string]$Path) {
    $current = [IO.Path]::GetFullPath($Path)
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Refusing to write through linked path: $current"
            }
        }
        $parent = [IO.Path]::GetDirectoryName($current)
        if (-not $parent -or $parent -eq $current) { break }
        $current = $parent
    }
}
Assert-UnlinkedPath $target
if ($ValidateOnly) {
    foreach ($relative in $files) {
        Assert-UnlinkedPath (Join-Path $target $relative)
    }
    Write-Host "Bundled Millwright module and destination paths validated ($($files.Count) files)."
    return
}
$changed = 0
foreach ($relative in $files) {
    $from = Join-Path $source $relative
    $to = Join-Path $target $relative
    if (Test-Path -LiteralPath $to) {
        $item = Get-Item -LiteralPath $to -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "Refusing to overwrite linked module file: $to"
        }
        if ((Get-FileHash -LiteralPath $from -Algorithm SHA256).Hash -eq
            (Get-FileHash -LiteralPath $to -Algorithm SHA256).Hash) { continue }
    }
    $parent = Split-Path -Parent $to
    Assert-UnlinkedPath $to
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    Copy-Item -LiteralPath $from -Destination $to -Force
    $changed++
}
if ($changed -eq 0) { Write-Host 'Millwright Foundry module unchanged.' }
else { Write-Host "Millwright Foundry module installed/updated ($changed files): $target" }
