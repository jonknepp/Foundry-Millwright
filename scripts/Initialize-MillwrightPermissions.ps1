#Requires -Version 7.0
function Set-MillwrightAcl {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][System.Security.Principal.SecurityIdentifier]$OperatorSid
    )
    if (-not $IsWindows) { throw 'Windows NTFS ACLs are required.' }
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    # GetAccessControl/SetAccessControl explicitly operate on Access only; never SACL or owner.
    $section = [System.Security.AccessControl.AccessControlSections]::Access
    $acl = if ($item.PSIsContainer) {
        [System.IO.FileSystemAclExtensions]::GetAccessControl([System.IO.DirectoryInfo]::new($item.FullName), $section)
    } else {
        [System.IO.FileSystemAclExtensions]::GetAccessControl([System.IO.FileInfo]::new($item.FullName), $section)
    }
    $acl.SetAccessRuleProtection($true, $false)
    # Remove explicit rules through the native collection, avoiding PowerShell's null-array wrapping.
    foreach ($rule in $acl.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier])) {
        if ($null -ne $rule) { [void]$acl.RemoveAccessRuleSpecific($rule) }
    }
    $inheritance = if ($item.PSIsContainer) {
        [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
        [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    } else { [System.Security.AccessControl.InheritanceFlags]::None }
    $sids = @(
        $OperatorSid,
        [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'),
        [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
    )
    foreach ($sid in $sids) {
        $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
            $sid,
            [System.Security.AccessControl.FileSystemRights]::FullControl,
            $inheritance,
            [System.Security.AccessControl.PropagationFlags]::None,
            [System.Security.AccessControl.AccessControlType]::Allow
        ))
    }
    if ($item.PSIsContainer) {
        [System.IO.FileSystemAclExtensions]::SetAccessControl([System.IO.DirectoryInfo]::new($item.FullName), $acl)
        $actual = [System.IO.FileSystemAclExtensions]::GetAccessControl([System.IO.DirectoryInfo]::new($item.FullName), $section)
    } else {
        [System.IO.FileSystemAclExtensions]::SetAccessControl([System.IO.FileInfo]::new($item.FullName), $acl)
        $actual = [System.IO.FileSystemAclExtensions]::GetAccessControl([System.IO.FileInfo]::new($item.FullName), $section)
    }
    if (-not $actual.AreAccessRulesProtected) {
        throw "ACL inheritance was not disabled: $Path"
    }
    $rules = $actual.GetAccessRules(
        $true, $false, [System.Security.Principal.SecurityIdentifier])
    foreach ($sid in $sids) {
        $found = $false
        foreach ($rule in $rules) {
            if ($null -eq $rule -or $null -eq $rule.IdentityReference) { continue }
            if ($rule.IdentityReference.Value -eq $sid.Value -and
                $rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
                ($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq
                    [System.Security.AccessControl.FileSystemRights]::FullControl) {
                $found = $true
                break
            }
        }
        if (-not $found) { throw "ACL verification failed for $Path : $($sid.Value)" }
    }
}
