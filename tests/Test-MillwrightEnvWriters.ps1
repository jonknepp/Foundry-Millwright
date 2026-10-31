#Requires -Version 7.0
<#
.SYNOPSIS
    Verify that configuration writers preserve a repository .env symbolic link.
.DESCRIPTION
    Extracts Save-DotEnv functions without running interactive configuration.
    Uses disposable files under the Windows temporary directory only.
    Does not touch the active Millwright deployment.
#>
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$writers = @('Set-DiscordConfig.ps1', 'Set-DuckDNSConfig.ps1', 'Set-PortForwardingConfig.ps1')
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('millwright-env-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testRoot -Force | Out-Null

try {
    foreach ($writer in $writers) {
        $source = Join-Path (Join-Path $root 'scripts') $writer
        $tokens = $null
        $parseErrors = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$parseErrors)
        if ($parseErrors.Count -gt 0) { throw "Syntax errors in ${writer}: $($parseErrors[0].Message)" }
        $functions = @($ast.FindAll({
            param($node)
            $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Save-DotEnv'
        }, $true))
        if ($functions.Count -ne 1) { throw "Expected exactly one Save-DotEnv function in $writer" }

        $fixture = Join-Path $testRoot ([IO.Path]::GetFileNameWithoutExtension($writer))
        New-Item -ItemType Directory -Path $fixture | Out-Null
        $persistent = Join-Path $fixture 'persistent.env'
        $link = Join-Path $fixture '.env'
        [IO.File]::WriteAllText($persistent, "EXISTING_VALUE=preserve`n", [Text.UTF8Encoding]::new($false))
        try {
            New-Item -ItemType SymbolicLink -Path $link -Target $persistent -ErrorAction Stop | Out-Null
        }
        catch {
            throw "Cannot create test symlink. On Windows, run PowerShell as administrator or enable Developer Mode. Details: $($_.Exception.Message)"
        }

        # Define only the writer function; never execute its interactive script body.
        . ([scriptblock]::Create($functions[0].Extent.Text))
        Save-DotEnv $link ([ordered]@{ TEST_WRITER = $writer })

        $item = Get-Item -LiteralPath $link -Force
        if ($item.LinkType -ne 'SymbolicLink') { throw "$writer replaced the .env symbolic link" }
        $target = [IO.Path]::GetFullPath([string]$item.Target)
        if ($target -ne [IO.Path]::GetFullPath($persistent)) { throw "$writer changed the symlink target" }
        $text = [IO.File]::ReadAllText($persistent)
        $entries = @($text -split '\r?\n')
        if (($entries -notcontains 'EXISTING_VALUE=preserve') -or ($entries -notcontains "TEST_WRITER=$writer")) {
            throw "$writer failed to preserve existing data or write to persistent target"
        }
        Write-Host "PASS: $writer preserved link and updated persistent target" -ForegroundColor Green
    }
    Write-Host 'PASS: All three configuration writers passed.' -ForegroundColor Green
}
finally {
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
