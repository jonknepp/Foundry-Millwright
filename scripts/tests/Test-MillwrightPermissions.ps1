#Requires -Version 7.0
# Run on Windows: pwsh -NoProfile -File scripts/tests/Test-MillwrightPermissions.ps1
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Windows required.' }
. (Join-Path $PSScriptRoot '../Initialize-MillwrightPermissions.ps1')
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$root = Join-Path ([IO.Path]::GetTempPath()) ('millwright-acl-' + [guid]::NewGuid().ToString('N'))
try {
    $nested = Join-Path $root 'nested'
    [void](New-Item -ItemType Directory -Path $nested -Force)
    $file = Join-Path $nested 'existing.txt'
    [IO.File]::WriteAllText($file, 'preserve this content')
    foreach ($path in @($root, $nested, $file)) {
        Set-MillwrightAcl -Path $path -OperatorSid $sid
        Set-MillwrightAcl -Path $path -OperatorSid $sid
    }
    if ([IO.File]::ReadAllText($file) -cne 'preserve this content') {
        throw 'File content changed during ACL enforcement.'
    }
    $newFile = Join-Path $nested 'new.txt'
    [IO.File]::WriteAllText($newFile, 'new content')
    Set-MillwrightAcl -Path $newFile -OperatorSid $sid
    $acl = Get-Acl -LiteralPath $newFile
    if (-not $acl.AreAccessRulesProtected) { throw 'New file ACL still inherits permissions.' }
    Write-Host 'PASS: existing and new file ACLs, nested directories, idempotence, and content preservation.'
}
finally {
    if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
}
