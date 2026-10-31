# Discord application and bot setup

Foundry-Millwright requires Discord integration. Discord OAuth2 authenticates users, while the **Millwright Gateway (Caddy)** and **Millwright Service** enforce access to Foundry using world-specific account mappings. A bot token supports Discord member lookup for account linking.

Each Millwright operator creates and controls their **own** Discord application. There is no shared Millwright bot or central Discord service. The bot does not need to run as a persistent Gateway client.

> **Keep secrets private.** Never commit the OAuth2 client secret or bot token to Git, paste them into support requests, or include them in screenshots. Application IDs and public keys are not secret.

## Before you begin

You need:

- A Discord account with ownership or **Manage Server** permission on the server you intend to use.
- A Discord server containing the gaming group's members.
- A configured Millwright data directory and `.env` file. The guided installer creates the persistent directories and secrets infrastructure; the standalone initializer is also available.
- Your public DuckDNS hostname and HTTPS port, plus the LAN IP if you want to authenticate through the local address.

Use the [Discord Developer Portal](https://discord.com/developers/applications) to complete the following steps. Discord may change interface labels over time.

## 1. Create the application

1. Open the Discord Developer Portal.
2. Select **New Application** or **Create**.
3. Enter a name, such as **Millwright**, and complete Discord's application creation flow.
4. Under **Overview → General Information**, confirm the application name.
5. Optionally enter a description and tags. Suggested tags: `access-control`, `tabletop-gaming`, `foundry-vtt`, `self-hosted`.
6. Locate the **Application ID** and use **Copy**. This is the **Discord Application (Client) ID** requested by Millwright.

Suggested description:

> Millwright is a self-hosted service stack for Foundry Virtual Tabletop that simplifies secure remote access, player onboarding, and account management. Discord integration provides identity verification and world-specific Foundry account mapping, allowing authorized gaming group members to access their Foundry instance.

**Leave these fields blank** for the current private deployment: Interactions Endpoint URL, Linked Roles Verification URL, Terms of Service URL, and Privacy Policy URL. The application Public Key does not need to be copied or configured.

## 2. Configure installation

Open **Overview → Installation**:

| Setting | Value |
| --- | --- |
| **User Install** | Off |
| **Guild Install** | On |
| **Install Link** | **None** |

The application is installed into your Discord server, not individually into each player's account. An Install Link of **None** does **not** prevent the server owner from installing the bot through a direct authorization URL.

Save changes when prompted.

## 3. Configure OAuth2

Open **Overview → OAuth2**.

1. Locate **Client Information**.
2. Copy the **Client ID** if you have not already done so.
3. Obtain the **Client Secret** and keep it private. This is distinct from the **bot token** obtained later.
4. Leave **Public Client** **off**.
5. Under **Redirects**, add the URLs that match the ways you intend to access Millwright.

### Redirect URIs

The first two are needed for the normal public deployment. The localhost and LAN callbacks are used when authenticating through those addresses.

| Scenario | Redirect URI |
| --- | --- |
| PowerShell setup callback | `http://127.0.0.1:8765/callback/` |
| Public DuckDNS hostname | `https://example-vtt.duckdns.org:8443/auth/oauth2/discord/authorization-code-callback` |
| Browser on the hosting computer | `https://localhost:8443/auth/oauth2/discord/authorization-code-callback` |
| Browser on the LAN, or on the hosting computer | `https://192.168.1.100:8443/auth/oauth2/discord/authorization-code-callback` |

**Replace** `example-vtt.duckdns.org`, `8443`, and `192.168.1.100` with your actual hostname, HTTPS port, and host LAN IP. The address `192.168.1.100` is an **example**, not a required value. Register the local callbacks only if you plan to use those access methods.

Discord requires an **exact match**, including scheme, host or IP, port, path, and trailing slash. Notice that the PowerShell setup callback **ends with `/callback/`**, while the Caddy OAuth2 callback **does not end with a slash**.

The PowerShell callback is for operator setup; the other callbacks are for users signing in through the reverse proxy. They are not interchangeable.

### Why the public hostname might fail inside your LAN

Your DuckDNS hostname normally resolves to your router's **public** IP. A device inside the LAN that connects to that address needs the router to send the connection back to the internal Millwright host. This is called **NAT loopback**, **hairpin NAT**, or **NAT reflection**. Some broadband routers do not support it.

Consequently, remote players may reach the public hostname successfully while a computer on your LAN cannot. When that happens, use the host's LAN IP address instead, with its matching Discord callback registered.

The host's LAN IP works **both from another LAN computer and from the hosting computer itself**. `localhost` works only on the hosting computer. Local connections also depend on the reverse proxy's bind address, host firewall, and local HTTPS certificate trust.

### Keep the LAN IP stable

For predictable port forwarding and OAuth2 callbacks, keep the Millwright host's LAN address consistent:

- **Recommended:** Create a **DHCP reservation** for the host in your broadband router.
- **Alternative:** Configure a **static IPv4 address** on the host, **outside the router's DHCP allocation range**, inside the correct subnet, and verified as unused. Configure the correct subnet mask, gateway, and DNS servers.

For example, `192.168.1.100` could be assigned through either method **if it fits the operator's actual LAN and DHCP configuration**. Do not assume every home network uses `192.168.1.0/24`.

If the host IP, public hostname, or HTTPS port changes, update the corresponding Discord redirects and review the router forwarding configuration. A local certificate trust warning is a **separate** HTTPS issue; registering an OAuth2 callback does not automatically establish trust in a local certificate authority.

### OAuth2 URL Generator

The **OAuth2 URL Generator** is **not** needed for normal operator sign-in: `Set-DiscordConfig.ps1` builds its own OAuth2 request using `identify`, `guilds`, and `guilds.members.read`.

You can use the generator to install the bot, however:

1. Under **Scopes**, select **bot** only.
2. Select the **Guild Install** context if prompted.
3. Leave **Bot Permissions** unchecked, giving **Permissions Integer `0`**.
4. Copy the generated authorization URL and use it as described in step 5.

Do not confuse the bot installation's `bot` scope with the operator authentication scopes.

## 4. Configure the bot

Open **Overview → Bot**.

| Setting | Value | Reason |
| --- | --- | --- |
| Bot username | `Millwright` or your preferred name | Display name only |
| **Public Bot** | **Off** | Restricts installation to the application owner |
| **Requires OAuth2 Code Grant** | **Off** | Not needed for this installation method |
| **Presence Intent** | **Off** | Not used |
| **Server Members Intent** | **On — required** | Required for guild member inventory used by Discord Account Linking |
| **Message Content Intent** | **Off** | Not used |
| **Bot Permissions** | **All unchecked** | No Discord server management permissions required |
| **Permissions Integer** | **`0`** | Verify after leaving permissions unchecked |

**Server Members Intent must be enabled.** The Foundry module's **Discord Account Linking** screen asks the Millwright Service for a list of guild members. The service retrieves those members through Discord's bot-authenticated REST API. This intent is required for that feature even though Millwright does not run a persistent Discord Gateway connection.

**Server Members Intent is not the same as the `guilds.members.read` OAuth2 scope**, and it is not the same as granting bot server permissions. Leave bot permissions at `0`.

Under **Token**, obtain the **bot token**. Discord may require you to select **Reset Token** to generate a new one. Copy it immediately and store it securely. **Resetting an existing token invalidates the old token**, so a deployed Millwright instance must be updated if you rotate it.

Save changes when prompted.

## 5. Install the bot in your Discord server

**Creating a Discord application and bot does not install the bot in a server.** This step is required so Millwright can retrieve the selected server's member list for Discord account linking. It is separate from the OAuth2 login used by players.

### Generate and open the installation link

1. In the [Discord Developer Portal](https://discord.com/developers/applications), open your Millwright application.
2. Under **General Information**, copy its numeric **Application ID** (not the client secret or bot token).
3. Open this URL in your browser, replacing `<APPLICATION_ID>` with that ID:

   ```text
   https://discord.com/oauth2/authorize?client_id=<APPLICATION_ID>&scope=bot&permissions=0
   ```

   Alternatively, use the **OAuth2 → URL Generator** with the `bot` scope and no bot permissions selected. Do not add permissions merely to make installation succeed.
4. Sign in to Discord using an account that owns or has permission to manage the intended server.

### Authorize installation in the server

1. In Discord's authorization dialog, select **Add to Server** (wording may vary).
2. Choose the server where your Foundry gaming group meets.
3. Review the requested permissions: the bot should request **no server permissions** (permissions integer `0`).
4. Select **Authorize** or **Continue** as prompted, and complete any confirmation or CAPTCHA.

If the server is not listed, check that you are signed in to the correct Discord account, that it has permission to manage the server, and that **Guild Install** is enabled for the application. Do not grant the bot Administrator permissions as a workaround.

### Verify that the bot was installed

1. Open the Discord desktop or web client and select the intended server.
2. Open the server menu (click the server name) and look for **Server Settings → Integrations**. Depending on the current Discord interface, installed apps may appear under **Bots and Apps**, **Integrations**, or an equivalent section.
3. Confirm that your Millwright application/bot is listed for that server. You may also see it in the server's member list.
4. **The bot may appear offline; this is expected.** Millwright uses its token for bot-authenticated Discord REST API calls. It does not run a persistent bot connection or need an online presence indicator.

Seeing the bot installed confirms authorization, but **does not by itself prove member discovery works**. The later Millwright configuration and account-linking steps must successfully retrieve the server's members. Ensure **Server Members Intent** was enabled in the Developer Portal's **Bot** settings.

### Troubleshooting installation

- **Server absent from selection:** Verify the signed-in Discord account and server management permissions; check the application's **Installation → Guild Install** setting.
- **Permission request includes Administrator or other privileges:** Cancel and regenerate the installation URL with `permissions=0`.
- **Bot not visible under server integrations:** Recheck the selected server and whether the authorization completed; retry the installation URL if necessary.
- **Bot shows offline:** Normal for Millwright; no persistent bot process is required.
- **Bot installed, but member lookup fails:** Check that the bot was installed in the same server selected in Millwright, that **Server Members Intent** is enabled, and that the stored bot token has not been reset or revoked. Consult Millwright's configuration error for the precise failure.

**Security:** Never paste a bot token or OAuth2 client secret into an installation URL, chat, screenshot, or support ticket. The URL needs only the public Application ID.

## 6. Select the server in PowerShell

**Recommended:** Run the [guided installer](guided-installation.md) from the repository root; it invokes Discord configuration at the appropriate stage. For standalone reconfiguration, run the following script in **PowerShell 7** after initializing the persistent data directory:

```powershell
.\scripts\Set-DiscordConfig.ps1
```

The script:

1. Reads the current `.env` configuration.
2. Requests the **Application (Client) ID**, **OAuth2 Client Secret**, and **bot token** if they are not already configured.
3. Stores the credentials in persistent secret files rather than putting their values in `.env`.
4. Verifies the bot token against Discord.
5. Opens a browser for the operator's Discord OAuth2 sign-in. The local callback must be registered as `http://127.0.0.1:8765/callback/`.
6. Lists Discord servers for which the signed-in operator is the owner or has **Administrator** or **Manage Server** permission.
7. Prompts you to choose the intended server by its **name**.
8. Saves the selected Discord guild ID in `.env`.

Foundry access requires an authenticated Discord identity and an authorized mapping to a Foundry account in the active world. No Discord role is required.

On Windows, the script can cache the operator's OAuth2 tokens encrypted for the current Windows user, allowing subsequent configuration runs to reuse or refresh the login.

To change the configured server or credentials, run:

```powershell
.\scripts\Set-DiscordConfig.ps1 -Reconfigure
```


## 7. Verify the configuration

Before starting the complete stack, check:

- The Discord application exists and its **Client ID** is recorded.
- The client secret and bot token are stored in Millwright's protected secrets directory.
- **Guild Install** is enabled; **User Install** is disabled; **Install Link** is **None**.
- The required public and setup redirect URIs are registered exactly.
- The bot is installed in the selected Discord server.
- **Server Members Intent** is **enabled**.
- **Bot Permissions Integer** is **`0`**.
- The intended server was selected successfully by `Set-DiscordConfig.ps1`.

After the rest of the Millwright configuration is complete, validate and start the stack:

```powershell
.\scripts\Start-Millwright.ps1 -ValidateOnly
.\scripts\Start-Millwright.ps1
```

The startup script includes the **Millwright Service**, **Foundry VTT**, and **Millwright Gateway**.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| **OAuth2 redirect URI mismatch** | Compare the complete requested URI with **OAuth2 → Redirects**. The setup callback has a trailing slash; the reverse proxy callback does not. |
| **Local OAuth2 callback fails** | Confirm `http://127.0.0.1:8765/callback/` is registered and port `8765` is available on the operator's computer. |
| **Bot authentication failed** | Verify the **bot token**, not the OAuth2 client secret, was supplied. If the token was reset, update the stored value. |
| **Missing Access (50001)** | Verify the bot is installed in the chosen Discord server. Use the installation URL printed by the script if provided. |
| **No eligible Discord servers** | Sign in with an account that owns the server or has **Manage Server** or **Administrator** permission. |
| **Discord Account Linking cannot list members** | Verify **Server Members Intent** is enabled, the bot token is valid, and the bot is installed in the configured server. |
| **Public hostname works remotely but not on LAN** | The router may lack **NAT loopback**. Try the host LAN IP with its registered Discord callback. |
| **LAN IP login fails after a network change** | Check the host's current IP, router forwarding, local firewall, and registered OAuth2 redirect. Prefer a DHCP reservation. |
| **Browser reports a local certificate warning** | Local TLS trust is separate from Discord callback registration. Verify the certificate and trust configuration. |

## Security and operational notes

- Discord credentials are **per deployment**. There is no centralized Millwright Discord application.
- Do not expose Foundry's internal container port directly to the internet; route users through the **Millwright Gateway**.
- Discord access and Foundry user permissions are separate security boundaries.
- Protect and back up Millwright's persistent secret files; losing them can interrupt authentication and administrative access.
- Revoke access through Millwright session management and the user's Foundry account mapping; Discord role changes do not control access.
