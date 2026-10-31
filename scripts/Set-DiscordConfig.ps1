#Requires -Version 7.0
<#
.SYNOPSIS
    Configure Millwright's Discord OAuth2 application and server.
.DESCRIPTION
    Loads .env, prompts for missing application credentials, authenticates the
    operator via Discord OAuth2, lists eligible guilds, and saves the chosen guild ID. On Windows, the operator's OAuth2
    tokens are cached using current-user DPAPI encryption for subsequent runs. The bot is used for REST member discovery; no running bot or privileged gateway intents are required.

    Register http://127.0.0.1:8765/callback/ as a Redirect URI under
    Discord Developer Portal > OAuth2 before running.
.EXAMPLE
    pwsh ./scripts/Set-DiscordConfig.ps1
.EXAMPLE
    pwsh ./scripts/Set-DiscordConfig.ps1 -Reconfigure
#>
[CmdletBinding()]
param(
    [string] $EnvPath = (Join-Path (Split-Path -Parent $PSScriptRoot) '.env'),
    [string] $RedirectUri = 'http://127.0.0.1:8765/callback/',
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
$api = 'https://discord.com/api/v10'
# Discord recommends an identifying User-Agent; apply it to every API request.
$discordUserAgent = 'DiscordBot (https://github.com/jonknepp/millwright, 1.0)'

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

    [string[]]$lines = if (Test-Path -LiteralPath $Path) {
        [IO.File]::ReadAllLines($Path)
    } else { @() }
    foreach ($key in $Updates.Keys) {
        $value = [string] $Updates[$key]
        if ($value -match '[\r\n]') { throw "Invalid newline in configuration value: $key" }
        $escaped = if ($value -match '[\s#"'']') { '"' + ($value -replace '\\', '\\' -replace '"', '\"') + '"' } else { $value }
        $entry = "$key=$escaped"
        $found = $false
        for ($i = 0; $i -lt $lines.Count; $i++) {
            if ($lines[$i] -match ('^\s*(?:export\s+)?' + [regex]::Escape($key) + '\s*=')) {
                if (-not $found) { $lines[$i] = $entry; $found = $true }
                else { throw "Duplicate .env key encountered: $key. Remove duplicates before rerunning." }
            }
        }
        if (-not $found) { $lines = @($lines) + @($entry) }
    }
    $parent = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    $temp = Join-Path $parent ('.env.' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [IO.File]::WriteAllLines($temp, $lines, [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temp -Destination $Path -Force
        Protect-MillwrightWrittenFile $Path
    } finally { if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force } }
}

function Read-Required([string] $Label, [string] $Current, [switch] $Secret) {
    if (-not $Reconfigure -and -not [string]::IsNullOrWhiteSpace($Current)) { return $Current }
    if ($Secret) { $inputValue = Read-Host $Label -MaskInput }
    else { $inputValue = Read-Host $Label }
    if ([string]::IsNullOrWhiteSpace($inputValue)) {
        if (-not [string]::IsNullOrWhiteSpace($Current)) { return $Current }
        throw "$Label is required."
    }
    return $inputValue.Trim()
}

function Resolve-SecretPath([string] $Root, [string] $Configured, [string] $DefaultName) {
    if ([string]::IsNullOrWhiteSpace($Configured)) { return Join-Path (Join-Path $Root 'secrets') $DefaultName }
    if ([IO.Path]::IsPathRooted($Configured)) { return $Configured }
    return Join-Path $Root $Configured
}

function Get-Secret([string] $Path, [string] $Label) {
    $existing = if (Test-Path -LiteralPath $Path) { [IO.File]::ReadAllText($Path).Trim() } else { '' }
    $value = Read-Required -Label $Label -Current $existing -Secret
    if ($value -ne $existing) {
        $directory = Split-Path -Parent $Path
        if (-not (Test-Path -LiteralPath $directory)) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
        [IO.File]::WriteAllText($Path, $value, [Text.UTF8Encoding]::new($false))
        Protect-MillwrightWrittenFile $Path
        if (-not $IsWindows) {
            & chmod 600 -- $Path
            if ($LASTEXITCODE -ne 0) { throw "Could not restrict permissions on $Path" }
        }
    }
    return $value
}

function New-Base64Url([byte[]] $Bytes) {
    return [Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+','-').Replace('/','_')
}

function ConvertTo-FormBody([System.Collections.IDictionary] $Values) {
    return ($Values.GetEnumerator() | ForEach-Object {
        [uri]::EscapeDataString([string]$_.Key) + '=' + [uri]::EscapeDataString([string]$_.Value)
    }) -join '&'
}

function Select-Item([object[]] $Items, [string] $Prompt, [scriptblock] $Display) {
    if ($Items.Count -eq 0) { throw "No choices available for $Prompt." }
    for ($i = 0; $i -lt $Items.Count; $i++) { Write-Host ('[{0}] {1}' -f ($i + 1), (& $Display $Items[$i])) }
    while ($true) {
        $answer = Read-Host "$Prompt (1-$($Items.Count))"
        $number = 0
        if ([int]::TryParse($answer, [ref]$number) -and $number -ge 1 -and $number -le $Items.Count) {
            return $Items[$number - 1]
        }
        Write-Warning 'Select a number from the list.'
    }
}

function Save-OAuthCache([string] $Path, [object] $Token, [string] $ClientId, [string] $RedirectUri) {
    if (-not $IsWindows) { return }
    $record = @{
        client_id = $ClientId
        redirect_uri = $RedirectUri
        access_token = [string]$Token.access_token
        refresh_token = [string]$Token.refresh_token
        expires_at = [DateTimeOffset]::UtcNow.AddSeconds([int]$Token.expires_in).ToUnixTimeSeconds()
    }
    $bytes = [Text.Encoding]::UTF8.GetBytes(($record | ConvertTo-Json -Compress))
    $encrypted = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    $dir = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $temp = "$Path.$([guid]::NewGuid().ToString('N')).tmp"
    try {
        [IO.File]::WriteAllBytes($temp, $encrypted)
        Move-Item -LiteralPath $temp -Destination $Path -Force
        Protect-MillwrightWrittenFile $Path
    } finally { if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force } }
}

function Read-OAuthCache([string] $Path, [string] $ClientId, [string] $RedirectUri) {
    if (-not $IsWindows -or -not (Test-Path -LiteralPath $Path)) { return $null }
    try {
        $encrypted = [IO.File]::ReadAllBytes($Path)
        $bytes = [Security.Cryptography.ProtectedData]::Unprotect($encrypted, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
        $record = [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json
        if ($record.client_id -ne $ClientId -or $record.redirect_uri -ne $RedirectUri) { return $null }
        return $record
    } catch {
        Write-Warning 'Saved Discord OAuth2 session could not be read; browser authentication may be required.'
        return $null
    }
}

function Request-OAuthRefresh([object] $Record, [string] $ClientId, [string] $ClientSecret) {
    $body = ConvertTo-FormBody ([ordered]@{
        client_id = $ClientId
        client_secret = $ClientSecret
        grant_type = 'refresh_token'
        refresh_token = [string]$Record.refresh_token
    })
    return Invoke-RestMethod -UserAgent $discordUserAgent -Method Post -Uri 'https://discord.com/api/v10/oauth2/token' -ContentType 'application/x-www-form-urlencoded' -Body $body
}

$envFile = [IO.Path]::GetFullPath($EnvPath)
$settings = Read-DotEnv $envFile
$repoRoot = Split-Path -Parent $envFile
$dataRoot = if ($settings['MILLWRIGHT_DATA_DIR']) { [Environment]::ExpandEnvironmentVariables($settings['MILLWRIGHT_DATA_DIR']) } else { Join-Path $repoRoot 'data' }
if (-not [IO.Path]::IsPathRooted($dataRoot)) { $dataRoot = Join-Path $repoRoot $dataRoot }
$dataRoot = [IO.Path]::GetFullPath($dataRoot)

# Persist each completed input before OAuth2 so an interrupted run can resume.
$clientId = Read-Required 'Discord Application (Client) ID' ([string]$settings['DISCORD_CLIENT_ID'])
if ($clientId -notmatch '^\d{17,22}$') { throw 'Discord Client ID must be a numeric snowflake.' }
Save-DotEnv $envFile ([ordered]@{ DISCORD_CLIENT_ID = $clientId })

$clientSecretPath = Resolve-SecretPath $dataRoot ([string]$settings['DISCORD_CLIENT_SECRET_FILE']) 'discord-client-secret'
$botTokenPath = Resolve-SecretPath $dataRoot ([string]$settings['DISCORD_BOT_TOKEN_FILE']) 'discord-bot-token'

# Record secret paths before prompting. Get-Secret saves a supplied credential
# immediately, and future runs read the file without prompting again.
Save-DotEnv $envFile ([ordered]@{ DISCORD_CLIENT_SECRET_FILE = $clientSecretPath })
$clientSecret = Get-Secret $clientSecretPath 'Discord OAuth2 client secret'
Save-DotEnv $envFile ([ordered]@{ DISCORD_BOT_TOKEN_FILE = $botTokenPath })
$botToken = Get-Secret $botTokenPath 'Discord bot token'

# Keep the accumulated values for the final guild update.
$updates = [ordered]@{
    DISCORD_CLIENT_ID = $clientId
    DISCORD_CLIENT_SECRET_FILE = $clientSecretPath
    DISCORD_BOT_TOKEN_FILE = $botTokenPath
}

# Verify the bot credential before initiating interactive OAuth2.
try {
    $bot = Invoke-RestMethod -UserAgent $discordUserAgent -Method Get -Uri "$api/users/@me" -Headers @{ Authorization = "Bot $botToken" }
    Write-Host "Bot authenticated: $($bot.username)"
} catch { throw "Discord bot authentication failed. Check the token. $($_.Exception.Message)" }

$redirect = [uri]$RedirectUri
if ($redirect.Scheme -ne 'http' -or $redirect.Host -notin @('127.0.0.1', 'localhost') -or $redirect.AbsolutePath -ne '/callback/') {
    throw 'RedirectUri must be a loopback HTTP URL with path /callback/.'
}
$cachePath = Join-Path (Join-Path $dataRoot 'secrets') 'discord-operator-oauth.dpapi'
$accessToken = $null
$cache = Read-OAuthCache $cachePath $clientId $RedirectUri
if ($cache -and -not $Reconfigure) {
    if ([long]$cache.expires_at -gt [DateTimeOffset]::UtcNow.AddMinutes(2).ToUnixTimeSeconds()) {
        $accessToken = [string]$cache.access_token
        Write-Host 'Reusing cached Discord operator authentication.'
    } elseif (-not [string]::IsNullOrWhiteSpace([string]$cache.refresh_token)) {
        try {
            $refreshed = Request-OAuthRefresh $cache $clientId $clientSecret
            Save-OAuthCache $cachePath $refreshed $clientId $RedirectUri
            $accessToken = [string]$refreshed.access_token
            Write-Host 'Refreshed cached Discord operator authentication.'
        } catch { Write-Warning 'Discord OAuth2 refresh failed; opening interactive login.' }
    }
}
if ($accessToken) {
    try {
        $null = Invoke-RestMethod -UserAgent $discordUserAgent -Method Get -Uri "$api/users/@me" -Headers @{ Authorization = "Bearer $accessToken" }
    } catch {
        Write-Warning 'Cached access token was rejected; opening interactive login.'
        $accessToken = $null
    }
}
if (-not $accessToken) {
    $listener = [Net.HttpListener]::new()
    $listener.Prefixes.Add($RedirectUri)
    $random = [byte[]]::new(32)
    [Security.Cryptography.RandomNumberGenerator]::Fill($random)
    $state = New-Base64Url $random
    $randomVerifier = [byte[]]::new(32)
    [Security.Cryptography.RandomNumberGenerator]::Fill($randomVerifier)
    $verifier = New-Base64Url $randomVerifier
    $challenge = New-Base64Url ([Security.Cryptography.SHA256]::HashData([Text.Encoding]::ASCII.GetBytes($verifier)))
    $authorizeQuery = ConvertTo-FormBody ([ordered]@{
        client_id = $clientId
        response_type = 'code'
        redirect_uri = $RedirectUri
        scope = 'identify guilds guilds.members.read'
        state = $state
        code_challenge = $challenge
        code_challenge_method = 'S256'
    })
    $authorizeUrl = "https://discord.com/oauth2/authorize?$authorizeQuery"
    try {
        try { $listener.Start() } catch { throw "Cannot listen on $RedirectUri. Check port availability and URL permissions. $($_.Exception.Message)" }
        Write-Host "Opening Discord OAuth2 login. Redirect URI registered in Discord must exactly match: $RedirectUri"
        Start-Process $authorizeUrl
        $pending = $listener.GetContextAsync()
        if (-not $pending.Wait([TimeSpan]::FromMinutes(3))) { throw 'Timed out waiting for Discord OAuth2 callback.' }
        $context = $pending.GetAwaiter().GetResult()
        $query = $context.Request.QueryString
        $validState = ($query['state'] -ceq $state)
        $code = $query['code']
        $oauthError = $query['error']
        $message = if (-not $validState) { 'Invalid OAuth2 state. Authorization rejected.' } elseif ($oauthError) { "Discord authorization failed: $oauthError" } elseif (-not $code) { 'Missing authorization code.' } else { 'Discord authorization received. You may close this tab.' }
        $response = [Text.Encoding]::UTF8.GetBytes($message)
        $context.Response.ContentType = 'text/plain; charset=utf-8'
        $context.Response.ContentLength64 = $response.Length
        $context.Response.OutputStream.Write($response, 0, $response.Length)
        $context.Response.Close()
        if (-not $validState -or $oauthError -or -not $code) { throw $message }
        $tokenBody = ConvertTo-FormBody ([ordered]@{
            client_id = $clientId
            client_secret = $clientSecret
            grant_type = 'authorization_code'
            code = $code
            redirect_uri = $RedirectUri
            code_verifier = $verifier
        })
        $tokenResponse = Invoke-RestMethod -UserAgent $discordUserAgent -Method Post -Uri 'https://discord.com/api/v10/oauth2/token' -ContentType 'application/x-www-form-urlencoded' -Body $tokenBody
        $accessToken = [string]$tokenResponse.access_token
        Save-OAuthCache $cachePath $tokenResponse $clientId $RedirectUri
        if (-not $IsWindows) { Write-Warning 'Persistent OAuth2 caching is currently implemented only on Windows; Linux support is deferred.' }
    } finally {
        if ($listener.IsListening) { $listener.Stop() }
        $listener.Close()
    }
}
try {
    $userHeaders = @{ Authorization = "Bearer $accessToken" }
    $operator = Invoke-RestMethod -UserAgent $discordUserAgent -Method Get -Uri "$api/users/@me" -Headers $userHeaders
    Write-Host "Authenticated operator: $($operator.username)"
    $guilds = @(Invoke-RestMethod -UserAgent $discordUserAgent -Method Get -Uri "$api/users/@me/guilds" -Headers $userHeaders | ForEach-Object { $_ })
    # Discord's permissions field is a string-encoded bitmask. Manage Guild = 0x20, Administrator = 0x8.
    $eligibleGuilds = @($guilds | Where-Object {
        if ($_.owner -eq $true) { return $true }
        $permissions = [bigint]::Zero
        if (-not [bigint]::TryParse([string]$_.permissions, [ref]$permissions)) {
            Write-Warning "Skipping guild with missing or invalid permissions: $($_.name)"
            return $false
        }
        ($permissions -band [bigint]0x28) -ne 0
    } | Sort-Object name)
    if ($eligibleGuilds.Count -eq 0) { throw 'No guilds with owner, Administrator, or Manage Server permissions were found.' }
    $guild = Select-Item $eligibleGuilds 'Choose Discord server' { param($g) "$($g.name) ($($g.id))" }

    $updates['DISCORD_GUILD_ID'] = [string]$guild.id
    Save-DotEnv $envFile $updates
    Write-Host "Saved Discord configuration to $envFile"
    Write-Host "Server: $($guild.name) ($($guild.id))"
} finally {
    Remove-Variable clientSecret,botToken,accessToken -ErrorAction SilentlyContinue
}
