#Requires -Version 7.0
<#
.SYNOPSIS
    Configure Millwright's port forwarding mode, network interface, and HTTPS ports.
.DESCRIPTION
    Interactive configuration and UPnP mapping reconciliation.
    Does not change Docker/Caddy configuration.
    Preserves existing settings unless -Reconfigure is specified.
.EXAMPLE
    pwsh ./scripts/Set-PortForwardingConfig.ps1
.EXAMPLE
    pwsh ./scripts/Set-PortForwardingConfig.ps1 -Reconfigure
#>
[CmdletBinding()]
param(
    [string] $EnvPath = (Join-Path (Split-Path -Parent $PSScriptRoot) '.env'),
    [switch] $Reconfigure,
    [switch] $Reconcile,
    [switch] $CheckOnly,
    [switch] $RemoveOwnedUpnp,
    [switch] $PassThruLanIP,
    [switch] $CleanupNetwork,
    [switch] $FirewallApply,
    [switch] $FirewallRemove,
    [ValidateRange(1,65535)][int] $FirewallPort
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# Internal elevated entrypoints: invoked only by this script after UAC consent.
$firewallName = 'Millwright HTTPS Inbound'
function Test-FirewallAdmin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    return ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
function Get-ManagedFirewallRule {
    $rules = @(Get-NetFirewallRule -DisplayName $firewallName -ErrorAction SilentlyContinue)
    if ($rules.Count -gt 1) { throw "Ambiguous firewall rules named '$firewallName'." }
    if ($rules.Count -eq 0) { return $null }
    $rule = $rules[0]
    $filters = @(Get-NetFirewallPortFilter -AssociatedNetFirewallRule $rule)
    if ($rule.Direction -ne 'Inbound' -or $rule.Action -ne 'Allow' -or $filters.Count -ne 1 -or $filters[0].Protocol -ne 'TCP') {
        throw "Rule '$firewallName' is not a recognized TCP inbound allow rule; refusing modification."
    }
    return $rule
}
function Test-FirewallCorrect([int]$Port) {
    $rule = Get-ManagedFirewallRule
    if ($null -eq $rule) { return $false }
    $filter = Get-NetFirewallPortFilter -AssociatedNetFirewallRule $rule
    $address = @(Get-NetFirewallAddressFilter -AssociatedNetFirewallRule $rule)
    return ($rule.Enabled -eq 'True' -and $rule.Profile -eq 'Any' -and
        [string]$filter.LocalPort -eq [string]$Port -and
        $address.Count -eq 1 -and [string]$address[0].RemoteAddress -eq 'Any')
}
function Invoke-FirewallChange([int]$Port, [bool]$Remove) {
    if ($Remove) {
        $rule = Get-ManagedFirewallRule
        if ($null -ne $rule) { Remove-NetFirewallRule -InputObject $rule -ErrorAction Stop }
        return
    }
    if ($Port -lt 1 -or $Port -gt 65535) { throw 'Firewall port must be between 1 and 65535.' }
    $rule = Get-ManagedFirewallRule
    if ($null -eq $rule) {
        New-NetFirewallRule -DisplayName $firewallName -Direction Inbound -Action Allow -Enabled True -Profile Any -Protocol TCP -LocalPort $Port -RemoteAddress Any -ErrorAction Stop | Out-Null
    } else {
        Set-NetFirewallRule -InputObject $rule -Enabled True -Profile Any -ErrorAction Stop | Out-Null
        $filter = Get-NetFirewallPortFilter -AssociatedNetFirewallRule $rule
        Set-NetFirewallPortFilter -InputObject $filter -LocalPort $Port -ErrorAction Stop | Out-Null
        $address = Get-NetFirewallAddressFilter -AssociatedNetFirewallRule $rule
        Set-NetFirewallAddressFilter -InputObject $address -RemoteAddress Any -ErrorAction Stop | Out-Null
    }
}
function Ensure-Firewall([int]$Port, [bool]$CheckOnly, [bool]$Remove) {
    if (-not $IsWindows) { throw 'Windows firewall implementation requires Windows.' }
    $needsChange = if ($Remove) { $null -ne (Get-ManagedFirewallRule) } else { -not (Test-FirewallCorrect $Port) }
    if (-not $needsChange) {
        if ($Remove) {
            Write-Host 'Windows Firewall: managed rule is absent; no removal needed.'
        } else {
            Write-Host "Windows Firewall: managed inbound TCP $Port rule is present and correctly configured."
        }
        return
    }
    if ($CheckOnly) {
        if ($Remove) {
            throw 'Windows Firewall: managed rule is still present; removal required.'
        }
        throw "Windows Firewall: managed inbound TCP $Port rule is missing or incorrectly configured."
    }
    if (Test-FirewallAdmin) {
        Invoke-FirewallChange -Port $Port -Remove $Remove
    } else {
        $shell = (Get-Process -Id $PID).Path
        $operation = if ($Remove) { '-FirewallRemove' } else { '-FirewallApply' }
        $args = @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + $PSCommandPath + '"'),$operation)
        if (-not $Remove) { $args += @('-FirewallPort', [string]$Port) }
        try {
            $child = Start-Process -FilePath $shell -ArgumentList $args -Verb RunAs -Wait -PassThru -ErrorAction Stop
        } catch { throw "Windows Firewall update requires UAC approval: $($_.Exception.Message)" }
        if ($child.ExitCode -ne 0) { throw "Elevated firewall operation failed (exit $($child.ExitCode))." }
    }
    if ($Remove) {
        if ($null -ne (Get-ManagedFirewallRule)) { throw 'Firewall removal could not be verified.' }
    } elseif (-not (Test-FirewallCorrect $Port)) { throw "Firewall TCP $Port configuration could not be verified." }
    Write-Host 'Windows Firewall configuration verified.'
}
if ($FirewallApply -or $FirewallRemove) {
    if ($FirewallApply -and $FirewallRemove) { throw 'Choose one internal firewall operation.' }
    if (-not (Test-FirewallAdmin)) { throw 'Elevated firewall operation requires administrator privileges.' }
    if ($FirewallApply -and $FirewallPort -lt 1) { throw 'FirewallPort is required.' }
    try { Invoke-FirewallChange -Port $FirewallPort -Remove ([bool]$FirewallRemove); exit 0 }
    catch { Write-Error $_; exit 1 }
}

if ($RemoveOwnedUpnp -and ($Reconfigure -or $Reconcile -or $CheckOnly -or $PassThruLanIP)) { throw 'RemoveOwnedUpnp must be used alone.' }
if ($Reconfigure -and ($Reconcile -or $CheckOnly)) { throw 'Reconfigure cannot be combined with Reconcile or CheckOnly.' }
if ($Reconcile -and $CheckOnly) { throw 'Select either Reconcile or CheckOnly.' }

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
    # Avoid rewriting an unchanged configuration (and its modification timestamp).
    $originalLines = if (Test-Path -LiteralPath $Path) { [IO.File]::ReadAllLines($Path) } else { @() }
    if ([string]::Join("`n", $originalLines) -ceq [string]::Join("`n", $lines)) { return $false }
    $directory = Split-Path -Parent $Path
    $temp = Join-Path $directory ('.env.' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [IO.File]::WriteAllLines($temp, $lines, [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temp -Destination $Path -Force
    } finally { if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force } }
    return $true
}

function Read-Port([string] $Label, [int] $Default) {
    while ($true) {
        $answer = Read-Host "$Label [$Default]"
        if ([string]::IsNullOrWhiteSpace($answer)) { return $Default }
        $port = 0
        if ([int]::TryParse($answer.Trim(), [ref]$port) -and $port -ge 1 -and $port -le 65535) {
            return $port
        }
        Write-Warning 'Enter a TCP port between 1 and 65535.'
    }
}

function Get-ConfiguredPort([string] $Value, [int] $Default, [string] $Name) {
    if ([string]::IsNullOrWhiteSpace($Value)) { return $Default }
    $port = 0
    if (-not [int]::TryParse($Value, [ref]$port) -or $port -lt 1 -or $port -gt 65535) {
        throw "$Name must be a TCP port between 1 and 65535."
    }
    return $port
}

function Invoke-IgdAction {
    param([uri] $ControlUrl, [string] $ServiceType, [string] $Action, [string] $Arguments = '')
    $body = '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:' + $Action + ' xmlns:u="' + $ServiceType + '">' + $Arguments + '</u:' + $Action + '></s:Body></s:Envelope>'
    $headers = @{
        SOAPAction = "`"$ServiceType#$Action`""
    }
    $response = Invoke-WebRequest `
        -Uri $ControlUrl `
        -Method Post `
        -Headers $headers `
        -ContentType 'text/xml; charset=utf-8' `
        -Body $body `
        -TimeoutSec 8 `
        -SkipHttpErrorCheck    
    $status = [int]$response.StatusCode
    $content = [string]$response.Content
    if ($status -lt 200 -or $status -ge 300) {
        $errorCode = [regex]::Match($content, '<(?:\w+:)?errorCode>\s*(\d+)\s*</(?:\w+:)?errorCode>')
        if ($Action -eq 'GetSpecificPortMappingEntry' -and $status -eq 500 -and $errorCode.Success -and $errorCode.Groups[1].Value -eq '714') {
            return $null # UPnP error 714: NoSuchEntryInArray
        }
        $detail = if ($errorCode.Success) { " UPnP error $($errorCode.Groups[1].Value)." } else { '' }
        throw "UPnP SOAP action $Action failed with HTTP $status.$detail"
    }
    try { return [xml]$content }
    catch { throw "UPnP SOAP action $Action returned invalid XML: $($_.Exception.Message)" }
}

function Get-XmlElementText {
    param([xml] $Document, [string] $ElementName)
    $node = $Document.SelectSingleNode("//*[local-name()='$ElementName']")
    if ($null -eq $node) { return $null }
    return $node.InnerText
}

function Invoke-UpnpDiscovery {
    param([string] $LocalIPv4, [string] $ExpectedGateway)
    $client = [Net.Sockets.UdpClient]::new([Net.IPEndPoint]::new([Net.IPAddress]::Parse($LocalIPv4), 0))
    try {
        $client.Client.ReceiveTimeout = 3500
        $client.Client.SetSocketOption([Net.Sockets.SocketOptionLevel]::IP, [Net.Sockets.SocketOptionName]::MulticastInterface, [Net.IPAddress]::Parse($LocalIPv4).GetAddressBytes())
        $request = "M-SEARCH * HTTP/1.1`r`nHOST: 239.255.255.250:1900`r`nMAN: `"ssdp:discover`"`r`nMX: 2`r`nST: urn:schemas-upnp-org:device:InternetGatewayDevice:1`r`n`r`n"
        $bytes = [Text.Encoding]::ASCII.GetBytes($request)
        $destination = [Net.IPEndPoint]::new([Net.IPAddress]::Parse('239.255.255.250'), 1900)
        [void]$client.Send($bytes, $bytes.Length, $destination)
        $locations = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        $deadline = [DateTime]::UtcNow.AddSeconds(4)
        while ([DateTime]::UtcNow -lt $deadline) {
            $sender = [Net.IPEndPoint]::new([Net.IPAddress]::Any, 0)
            try { $reply = [Text.Encoding]::ASCII.GetString($client.Receive([ref]$sender)) }
            catch [Net.Sockets.SocketException] {
                if ($_.Exception.SocketErrorCode -eq [Net.Sockets.SocketError]::TimedOut) { break }
                throw
            }
            if ($reply -match '(?im)^LOCATION:\s*(https?://\S+)\s*$') {
                [void]$locations.Add($Matches[1].Trim())
            }
        }
    } finally { $client.Dispose() }
    if ($locations.Count -eq 0) { throw "No UPnP IGD responded via $LocalIPv4." }
    foreach ($location in $locations) {
        Write-Host "IGD description: $location"
        $descriptionUri = [uri]$location
        if ($descriptionUri.Host -ne $ExpectedGateway) {
            Write-Warning "Ignoring UPnP device $($descriptionUri.Host): not the selected gateway $ExpectedGateway."
            continue
        }
        $description = [xml](Invoke-WebRequest -Uri $descriptionUri -TimeoutSec 8 -ErrorAction Stop).Content
        $urlBase = Get-XmlElementText $description 'URLBase'
        $baseUri = if ($urlBase) { [uri]$urlBase } else { $descriptionUri }
        $services = @($description.SelectNodes("//*[local-name()='service']"))
        foreach ($service in $services) {
            $type = $service.SelectSingleNode("./*[local-name()='serviceType']").InnerText
            if ($type -notmatch '^urn:schemas-upnp-org:service:WAN(?:IP|PPP)Connection:\d+$') { continue }
            $path = $service.SelectSingleNode("./*[local-name()='controlURL']").InnerText
            $control = [uri]::new($baseUri, $path)
            Write-Host "WAN service: $type"
            if ($control.Host -ne $ExpectedGateway) { throw "UPnP control URL host $($control.Host) differs from selected gateway $ExpectedGateway." }
            Write-Host "SOAP control: $control"
            $ipResult = Invoke-IgdAction -ControlUrl $control -ServiceType $type -Action 'GetExternalIPAddress'
            $wanIP = Get-XmlElementText $ipResult 'NewExternalIPAddress'
            Write-Host "Router-reported external IP: $wanIP"
            return [pscustomobject]@{ ControlUrl = $control; ServiceType = $type; ExternalIP = $wanIP }

        }
    }
    throw 'No WANIPConnection or WANPPPConnection service found in discovered IGD descriptions.'
}

function Get-Mapping {
    param($Igd, [int]$Port)
    $arguments = '<NewRemoteHost></NewRemoteHost><NewExternalPort>' + $Port + '</NewExternalPort><NewProtocol>TCP</NewProtocol>'
    $result = Invoke-IgdAction -ControlUrl $Igd.ControlUrl -ServiceType $Igd.ServiceType -Action 'GetSpecificPortMappingEntry' -Arguments $arguments
    if ($null -eq $result) { return $null }
    return [pscustomobject]@{
        InternalClient = (Get-XmlElementText $result 'NewInternalClient')
        InternalPort = (Get-XmlElementText $result 'NewInternalPort')
        Description = (Get-XmlElementText $result 'NewPortMappingDescription')
        Enabled = (Get-XmlElementText $result 'NewEnabled')
    }
}

function Test-OwnedMapping {
    param($Mapping, $Record, [int]$Port, [string]$Gateway)
    return ($null -ne $Mapping -and $null -ne $Record -and
        $Record.ExternalPort -eq $Port -and $Record.Gateway -eq $Gateway -and
        $Record.InternalClient -eq $Mapping.InternalClient -and
        [string]$Record.InternalPort -eq [string]$Mapping.InternalPort -and
        $Mapping.Description -eq 'Millwright HTTPS' -and
        [string]$Mapping.Enabled -eq '1')
}

function Get-Record([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json)
}

function Save-Record([string]$Path, $Record) {
    $directory = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $directory)) { [void](New-Item -ItemType Directory -Path $directory -Force) }
    $temp = Join-Path $directory ([guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [IO.File]::WriteAllText($temp, ($Record | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temp -Destination $Path -Force
    } finally { if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force } }
}

function Remove-OwnedMapping {
    param($Igd, $Record, [string]$Gateway)
    $mapping = Get-Mapping -Igd $Igd -Port ([int]$Record.ExternalPort)
    if ($null -eq $mapping) { return }
    if (-not (Test-OwnedMapping $mapping $Record ([int]$Record.ExternalPort) $Gateway)) {
        throw "Cannot remove TCP $($Record.ExternalPort): existing mapping does not match Millwright ownership record."
    }
    $argsXml = '<NewRemoteHost></NewRemoteHost><NewExternalPort>' + $Record.ExternalPort + '</NewExternalPort><NewProtocol>TCP</NewProtocol>'
    [void](Invoke-IgdAction -ControlUrl $Igd.ControlUrl -ServiceType $Igd.ServiceType -Action 'DeletePortMapping' -Arguments $argsXml)
    Write-Host "Removed Millwright-owned TCP $($Record.ExternalPort) mapping."
}

function Set-UpnpMapping {
    param($Igd, [int]$PublicPort, [int]$HostPort, [string]$ClientIP, [string]$Gateway, [string]$RecordPath, [bool]$AllowChanges, [bool]$AllowAdoption)
    $record = Get-Record $RecordPath
    $mapping = Get-Mapping -Igd $Igd -Port $PublicPort
    if ($null -ne $mapping) {
        if (-not (Test-OwnedMapping $mapping $record $PublicPort $Gateway)) {
            $matchesExpected = ($null -eq $record -and
                $mapping.InternalClient -eq $ClientIP -and
                [string]$mapping.InternalPort -eq [string]$HostPort -and
                $mapping.Description -ceq 'Millwright HTTPS' -and
                [string]$mapping.Enabled -eq '1')
            if (-not $matchesExpected -or -not $AllowAdoption) {
                throw "TCP ${PublicPort} is already mapped to $($mapping.InternalClient):$($mapping.InternalPort) ('$($mapping.Description)'). Refusing to overwrite or adopt a mapping without a matching ownership record."
            }
            Write-Warning "Existing UPnP TCP ${PublicPort} -> ${ClientIP}:$HostPort ('Millwright HTTPS') matches this installation, but its ownership record is missing."
            Write-Warning 'Adoption only records ownership locally; it does not modify the router. Future cleanup may remove this mapping.'
            $answer = Read-Host 'Type ADOPT to claim this existing mapping'
            if ($answer -cne 'ADOPT') { throw 'UPnP mapping adoption declined; existing router mapping unchanged.' }
            Save-Record -Path $RecordPath -Record ([ordered]@{
                Gateway = $Gateway; ExternalPort = $PublicPort; InternalClient = $ClientIP; InternalPort = $HostPort
            })
            Write-Host "Adopted existing UPnP TCP ${PublicPort} -> ${ClientIP}:$HostPort; router mapping unchanged."
            return
        }
        if ($mapping.InternalClient -eq $ClientIP -and [int]$mapping.InternalPort -eq $HostPort) {
            Write-Host "UPnP TCP ${PublicPort} already forwards to ${ClientIP}:$HostPort."
            return
        }
        if (-not $AllowChanges) { throw 'UPnP destination changed; rerun with -Reconfigure to approve replacing the existing Millwright mapping.' }
        Remove-OwnedMapping -Igd $Igd -Record $record -Gateway $Gateway
        $mapping = $null
    }
    if ($null -ne $record -and ($record.ExternalPort -ne $PublicPort -or $record.Gateway -ne $Gateway)) {
        throw "Previous Millwright mapping TCP $($record.ExternalPort) on gateway $($record.Gateway) is recorded. Remove or reconcile it before changing ports or gateways."
    }
    $argsXml = '<NewRemoteHost></NewRemoteHost><NewExternalPort>' + $PublicPort + '</NewExternalPort><NewProtocol>TCP</NewProtocol><NewInternalPort>' + $HostPort + '</NewInternalPort><NewInternalClient>' + $ClientIP + '</NewInternalClient><NewEnabled>1</NewEnabled><NewPortMappingDescription>Millwright HTTPS</NewPortMappingDescription><NewLeaseDuration>0</NewLeaseDuration>'
    [void](Invoke-IgdAction -ControlUrl $Igd.ControlUrl -ServiceType $Igd.ServiceType -Action 'AddPortMapping' -Arguments $argsXml)
    $verified = Get-Mapping -Igd $Igd -Port $PublicPort
    if ($null -eq $verified -or $verified.InternalClient -ne $ClientIP -or [int]$verified.InternalPort -ne $HostPort -or $verified.Description -ne 'Millwright HTTPS' -or [string]$verified.Enabled -ne '1') {
        throw 'UPnP mapping creation could not be verified. Inspect the router before retrying.'
    }
    Save-Record -Path $RecordPath -Record ([ordered]@{
        Gateway = $Gateway; ExternalPort = $PublicPort; InternalClient = $ClientIP; InternalPort = $HostPort
    })
    Write-Host "Created and verified UPnP TCP ${PublicPort} -> ${ClientIP}:$HostPort."
}

function Get-SelectedLanIPv4 {
    param([int]$InterfaceIndex)
    if (-not $IsWindows) { throw 'Windows LAN discovery requires Windows; Linux implementation pending.' }
    $routes = @(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' |
        Where-Object { $_.InterfaceIndex -eq $InterfaceIndex -and $_.NextHop -ne '0.0.0.0' })
    $iface = Get-NetIPInterface -AddressFamily IPv4 -InterfaceIndex $InterfaceIndex -ErrorAction Stop
    if ($iface.ConnectionState -ne 'Connected' -or $routes.Count -eq 0) {
        throw "Configured interface $InterfaceIndex is not connected to a default gateway."
    }
    $addresses = @(Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $InterfaceIndex |
        Where-Object { $_.AddressState -eq 'Preferred' -and $_.IPAddress -notmatch '^(127\.|169\.254\.)' })
    if ($addresses.Count -ne 1) { throw "Expected one preferred LAN IPv4 address on interface $InterfaceIndex; found $($addresses.Count)." }
    return [string]$addresses[0].IPAddress
}

$envFile = [IO.Path]::GetFullPath($EnvPath)
if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) {
    throw "Missing .env file: $envFile. Initialize Millwright first."
}
$settings = Read-DotEnv $envFile
$existingMode = ([string]$settings['MILLWRIGHT_PORT_FORWARDING_MODE']).Trim().ToLowerInvariant()
if ($existingMode -and $existingMode -notin @('upnp','manual','none')) {
    throw "Unsupported MILLWRIGHT_PORT_FORWARDING_MODE: $existingMode"
}
if ($RemoveOwnedUpnp -or $CleanupNetwork) {
    $dataDir = [string]$settings['MILLWRIGHT_DATA_DIR']
    if ([string]::IsNullOrWhiteSpace($dataDir)) { throw 'MILLWRIGHT_DATA_DIR is missing.' }
    $recordPath = Join-Path (Join-Path $dataDir 'config') 'port-forwarding-mapping.json'
    $record = Get-Record $recordPath
    if ($null -eq $record) { Write-Host 'No Millwright-owned UPnP mapping recorded.'; if ($CleanupNetwork) { Ensure-Firewall -Port 0 -CheckOnly $false -Remove $true }; return }
    if (-not $IsWindows) { throw 'Windows UPnP discovery implementation requires Windows.' }
    $idx = 0
    if (-not [int]::TryParse([string]$settings['MILLWRIGHT_NETWORK_INTERFACE_INDEX'], [ref]$idx) -or $idx -lt 1) {
        throw 'Cannot safely remove UPnP mapping: configured interface index is missing.'
    }
    $lanIP = Get-SelectedLanIPv4 -InterfaceIndex $idx
    $gateway = @((Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' |
        Where-Object { $_.InterfaceIndex -eq $idx -and $_.NextHop -eq [string]$record.Gateway }))
    if ($gateway.Count -eq 0) { throw 'Recorded UPnP gateway is not reachable through the selected interface; refusing removal.' }
    $igd = Invoke-UpnpDiscovery -LocalIPv4 $lanIP -ExpectedGateway ([string]$record.Gateway)
    Remove-OwnedMapping -Igd $igd -Record $record -Gateway ([string]$record.Gateway)
    # An absent mapping is already clean; only delete the record after verified absence.
    if ($null -ne (Get-Mapping -Igd $igd -Port ([int]$record.ExternalPort))) {
        throw 'UPnP mapping still exists after removal; ownership record retained.'
    }
    Remove-Item -LiteralPath $recordPath -Force
    Write-Host 'UPnP ownership record cleared.'
    if ($CleanupNetwork) { Ensure-Firewall -Port 0 -CheckOnly $false -Remove $true }
    return
}
$mode = $existingMode
if (($Reconcile -or $CheckOnly) -and -not $mode) { throw 'Port forwarding mode has not been configured. Run Set-PortForwardingConfig.ps1 interactively first.' }
if (-not $mode -or $Reconfigure) {
    $defaultChoice = switch ($existingMode) { 'manual' {'2'} 'none' {'3'} default {'1'} }
    Write-Host "`nPort forwarding method:"
    Write-Host '  [1] UPnP (automatic)'
    Write-Host '  [2] Manual port forwarding'
    Write-Host '  [3] None (no router forwarding)'
    do {
        $choice = Read-Host "Selection [$defaultChoice]"
        if ([string]::IsNullOrWhiteSpace($choice)) { $choice = $defaultChoice }
    } until ($choice -in @('1','2','3'))
    $mode = @{ '1'='upnp'; '2'='manual'; '3'='none' }[$choice]
}
$hostPort = Get-ConfiguredPort ([string]$settings['MILLWRIGHT_HTTPS_PORT']) 8443 'MILLWRIGHT_HTTPS_PORT'
$publicPort = Get-ConfiguredPort ([string]$settings['MILLWRIGHT_PUBLIC_HTTPS_PORT']) $hostPort 'MILLWRIGHT_PUBLIC_HTTPS_PORT'
if ($Reconfigure -and -not ($Reconcile -or $CheckOnly)) {
    $publicPort = Read-Port 'Public HTTPS port' $publicPort
    $hostPort = Read-Port 'Docker host HTTPS port' $hostPort
}
if ($mode -eq 'upnp' -and $publicPort -lt 1024) {
    throw 'This router previously rejected UPnP TCP 443; select a public port of 1024 or higher.'
}
$updates = [ordered]@{
    MILLWRIGHT_PORT_FORWARDING_MODE = $mode
    MILLWRIGHT_PUBLIC_HTTPS_PORT = $publicPort
    MILLWRIGHT_HTTPS_PORT = $hostPort
}
$dataDir = [string]$settings['MILLWRIGHT_DATA_DIR']
if ([string]::IsNullOrWhiteSpace($dataDir)) { throw 'MILLWRIGHT_DATA_DIR is required to store UPnP mapping ownership records.' }
$recordPath = Join-Path (Join-Path $dataDir 'config') 'port-forwarding-mapping.json'
$record = Get-Record $recordPath
if ($true) {
    if (-not $IsWindows) { throw 'Network interface selection currently requires Windows.' }
    $candidates = @(
        Get-NetIPConfiguration | Where-Object {
            $_.IPv4DefaultGateway -and
            @($_.IPv4Address | Where-Object {
                $_.IPAddress -and $_.IPAddress -notmatch '^(127\.|169\.254\.)'
            }).Count -gt 0
        } | ForEach-Object {
            $config = $_
            $address = @($config.IPv4Address | Where-Object {
                $_.IPAddress -and $_.IPAddress -notmatch '^(127\.|169\.254\.)'
            })[0].IPAddress
            [pscustomobject]@{
                InterfaceIndex = [int]$config.InterfaceIndex
                InterfaceAlias = [string]$config.InterfaceAlias
                IPv4Address = [string]$address
                Gateway = [string]$config.IPv4DefaultGateway.NextHop
            }
        }
    )
    if ($candidates.Count -eq 0) { throw 'No eligible IPv4 network interface with a default gateway was found.' }
    $existingIndex = 0
    $hasExistingIndex = [int]::TryParse([string]$settings['MILLWRIGHT_NETWORK_INTERFACE_INDEX'], [ref]$existingIndex)
    $existing = @($candidates | Where-Object InterfaceIndex -eq $existingIndex)
    if (($Reconcile -or $CheckOnly) -and -not $hasExistingIndex) { throw 'Configured network interface index is missing.' }
    if ($hasExistingIndex -and $existing.Count -eq 0) { throw "Previously selected interface index $existingIndex is unavailable." }
    $selected = $null
    if ($existing.Count -eq 1 -and -not $Reconfigure) {
        $selected = $existing[0]
    } elseif ($Reconcile -or $CheckOnly) {
        throw 'Configured interface could not be selected without prompting.'
    } else {
        Write-Host "`nEligible network interfaces:"
        for ($i = 0; $i -lt $candidates.Count; $i++) {
            $c = $candidates[$i]
            Write-Host ('  [{0}] {1} (index {2}) - {3}, gateway {4}' -f ($i+1),$c.InterfaceAlias,$c.InterfaceIndex,$c.IPv4Address,$c.Gateway)
        }
        $defaultSelection = 1
        if ($existing.Count -eq 1) {
            for ($i = 0; $i -lt $candidates.Count; $i++) {
                if ($candidates[$i].InterfaceIndex -eq $existingIndex) { $defaultSelection = $i+1; break }
            }
        }
        while ($true) {
            $answer = Read-Host "Interface selection [$defaultSelection]"
            if ([string]::IsNullOrWhiteSpace($answer)) { $answer = [string]$defaultSelection }
            $number = 0
            if ([int]::TryParse($answer, [ref]$number) -and $number -ge 1 -and $number -le $candidates.Count) {
                $selected = $candidates[$number-1]
                break
            }
            Write-Warning 'Select a number from the list.'
        }
    }
    $updates['MILLWRIGHT_NETWORK_INTERFACE_INDEX'] = $selected.InterfaceIndex
    $selected.IPv4Address = Get-SelectedLanIPv4 -InterfaceIndex $selected.InterfaceIndex
    Write-Host "Selected interface: $($selected.InterfaceAlias) ($($selected.IPv4Address))"
    Ensure-Firewall -Port $hostPort -CheckOnly ([bool]$CheckOnly) -Remove $false
    if ($mode -eq 'none') {
        if ($null -ne $record) { Write-Warning 'An earlier UPnP mapping is recorded; remove it explicitly.' }
        Write-Host 'Port forwarding disabled; router mappings were not modified.'
    } elseif ($mode -eq 'manual') {
        if ($null -ne $record) { Write-Warning 'An earlier UPnP mapping is recorded. Remove it explicitly in the router before switching to manual forwarding.' }
        Write-Host "Configure router TCP $publicPort -> $($selected.IPv4Address):$hostPort."
        if ($Reconcile -or $CheckOnly) {
            $manualRecordPath = Join-Path (Join-Path $dataDir 'config') 'manual-forwarding-target.json'
            $previousManual = Get-Record $manualRecordPath
            if ($previousManual -and ($previousManual.IP -ne $selected.IPv4Address -or [int]$previousManual.Port -ne $hostPort -or [int]$previousManual.PublicPort -ne $publicPort)) {
                throw 'Manual forwarding target has changed. Update the router and rerun interactive configuration.'
            }
            if (-not $previousManual) { throw 'Manual forwarding cannot be verified automatically. Confirm the router mapping and run interactive configuration first.' }
        } else {
            Save-Record -Path (Join-Path (Join-Path $dataDir 'config') 'manual-forwarding-target.json') -Record ([ordered]@{ IP = $selected.IPv4Address; Port = $hostPort; PublicPort = $publicPort })
        }
    } else {
        $igd = Invoke-UpnpDiscovery -LocalIPv4 $selected.IPv4Address -ExpectedGateway $selected.Gateway
        if ($CheckOnly) {
            $mapping = Get-Mapping -Igd $igd -Port $publicPort
            if ($null -eq $mapping) { Write-Warning 'UPnP mapping absent; normal startup will create it.' }
            elseif (-not (Test-OwnedMapping $mapping $record $publicPort $selected.Gateway) -or
                $mapping.InternalClient -ne $selected.IPv4Address -or [int]$mapping.InternalPort -ne $hostPort) {
                throw 'UPnP mapping conflicts with expected Millwright ownership/destination.'
            } else { Write-Host 'UPnP mapping verified.' }
        } else {
            Set-UpnpMapping -Igd $igd -PublicPort $publicPort -HostPort $hostPort -ClientIP $selected.IPv4Address -Gateway $selected.Gateway -RecordPath $recordPath -AllowChanges ([bool]($Reconfigure -or $Reconcile)) -AllowAdoption ([bool](-not $Reconcile))
        }
    }
} else {
    if ($null -ne $record) { Write-Warning 'An earlier UPnP mapping is recorded. Remove it explicitly in the router before disabling forwarding.' }
    Write-Host 'Port forwarding disabled; router mappings were not modified.'
}
if ($CheckOnly) {
    Write-Host "Configuration validated (no changes): $envFile"
} elseif (Save-DotEnv $envFile $updates) {
    Write-Host "Configuration updated: $envFile"
} else {
    Write-Host "Configuration unchanged: $envFile"
}
Write-Host "Mode: $mode; public TCP port: $publicPort; host TCP port: $hostPort"
if ($publicPort -ne $hostPort) {
    Write-Warning 'Caddy authentication URLs still use MILLWRIGHT_HTTPS_PORT; update Caddy to use MILLWRIGHT_PUBLIC_HTTPS_PORT before deploying unequal ports.'
}

if ($PassThruLanIP) { Write-Output ([string]$selected.IPv4Address) }
