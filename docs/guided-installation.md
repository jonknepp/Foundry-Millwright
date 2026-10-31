# Guided installation (pre-release)

Run from the repository root in PowerShell 7:

```powershell
.\Install-Millwright.ps1
```

The installer checks for Git, PowerShell 7, a running Docker engine, Docker Compose, and WSL, then guides the operator through persistent storage and Foundry archive selection, Discord OAuth2, DuckDNS, and port forwarding. Existing configuration is reused; rerun the same command after an interruption. Each phase can be revisited or skipped when already configured.

The installer creates the deployment signing key before validation. It then runs the existing startup validator, displays a non-secret configuration summary, and asks for **explicit activation approval**. Answering no leaves operational containers stopped.

To prepare and validate without offering activation:

```powershell
.\Install-Millwright.ps1 -SkipActivation
```

**Important:** Network configuration may create a router UPnP mapping and a Windows Firewall rule before service activation. These are not operational containers. Do not run setup against a production data directory when performing disposable installation tests.

## Prerequisites

The operator must install and configure PowerShell 7, Git, and Docker Desktop **using the WSL2 backend, not Docker VMM**, before running this installer. Use Docker Desktop's standard WSL2 prerequisites; Millwright does not require separate WSL2 setup beyond what Docker Desktop needs. The installer verifies dependency availability but does not install these dependencies. A licensed Foundry VTT Node.js distribution ZIP is required. The Discord application, bot, and DuckDNS account must be created separately.

## First administrator login

After activation, the installer prints the one-time administrator bootstrap challenge in the **host PowerShell console**, provided the initial administrator role has not yet been claimed. Sign in through the Millwright gateway with Discord and enter the displayed challenge on the **Millwright Administrator Setup** page.

If the console was closed before setup was completed, open PowerShell in the repository directory and run:

```powershell
.\scripts\Start-Millwright.ps1
```

The challenge is shown again only while administrator setup remains incomplete. After a successful claim, subsequent startup commands do not reveal it. Keep the host console private while the challenge is visible; do not paste the challenge into logs or support requests.

## Startup and maintenance

Use the supported startup script rather than invoking Docker Compose directly. The script resolves the persistent data directory and supplies the Discord configuration required for Compose interpolation. A manual Compose invocation can fail when process environment variables are empty or the persistent data directory is not exported.

From the repository root:

```powershell
.\scripts\Start-Millwright.ps1                # normal start
.\scripts\Start-Millwright.ps1 -ForceRebuild  # rebuild local images and start
.\scripts\Start-Millwright.ps1 -ValidateOnly # validate without starting
```

The rebuild option preserves persistent data and administrator registration. After a code update, use `-ForceRebuild` to deploy the updated middleware or gateway.

Before release, check all repository PowerShell scripts for syntax errors:

```powershell
.\scripts\Test-PowerShellSyntax.ps1
```

Network reconciliation should report whether configuration was updated or unchanged. Validation-only mode must not write the configuration file.

## Bundled Foundry module

Millwright installs its bundled Foundry module from `foundry-module/` into the persistent Foundry data directory at `foundry/Data/modules/millwright` during activation and on subsequent starts. Unchanged files are not rewritten; updated bundled files are copied on startup. Validation-only mode checks the bundle without modifying persistent data.

After creating a world and entering it as a Gamemaster, open **Game Settings → Manage Modules**, enable **Millwright**, and save. On first activation, Millwright automatically offers to provision its dedicated service account through a native Foundry confirmation dialog. Confirm to create it, or decline and provision later from **Game Settings → Millwright → Service Account**. If a partial service account already exists, use that settings interface for recovery. After successful provisioning, Millwright offers to link the current Foundry Gamemaster to the authenticated Discord administrator. Confirm only when those identities belong to the same person; otherwise decline and use Discord Account Linking separately. Existing mappings are not overwritten. If the optional link fails, service account provisioning remains complete. The module is world-scoped, so enabling it is a separate step for each world.

### Guided Discord account linking tutorial

After service account provisioning and optional GM linking, Millwright launches a six-step, non-destructive walkthrough: (1) find and open the Settings sidebar, (2) open Discord Account Linking, (3) link existing Foundry accounts, (4) create and link a player, (5) assign Foundry roles, and (6) finish. The tutorial highlights the relevant controls, advances when the GM clicks the Settings or Discord Account Linking buttons, and offers Next, Back, Skip Tutorial, and Finish. It never creates accounts or changes permissions.

**Foundry roles** determine in-world permissions: Player (default), Trusted Player, Assistant GM, and Gamemaster. **Discord OAuth2** authenticates entry through Millwright; world-specific Discord-to-Foundry account mappings determine which Foundry account a member uses. Linking an existing Foundry user does not change their role; the account-linking interface also allows GMs to change existing Foundry roles separately.

Completion is tracked per browser client independently of service account provisioning. Replay the walkthrough from **Game Settings → Millwright → Discord Account Linking Tutorial → Replay Tutorial**. The interface must be accessible to a Millwright administrator for the account inventory to load.

### Discord Account Linking in the Foundry sidebar

After enabling the Millwright module, look for the new **Discord Account Linking** button in Foundry's **Game Settings** sidebar, near Foundry's native **User Management** control. This is a Millwright addition, not a standard Foundry feature.

**Service Account** (under **Game Settings → Millwright**) provisions or repairs Millwright's dedicated GM integration account. **Discord Account Linking** manages associations between real Discord members and Foundry player/GM accounts. These are different tasks: the service account must not be linked to a human Discord identity.

The initial onboarding flow offers to link the current Gamemaster to the authenticated Discord administrator after service account provisioning. Use **Discord Account Linking** afterward to:

- Link an existing Foundry account to a Discord member, or change/remove an existing association.
- Create a new Foundry player account and associate it with a selected Discord member.
- Review which Foundry users are linked, along with their Foundry roles.

The interface lists Discord members by their friendly server display names and usernames. Millwright uses immutable Discord IDs internally to maintain mappings. Changes require Millwright administrator authorization in addition to being logged into Foundry as a GM. Linking a Discord identity does not change the Foundry account's native role or permissions.

**Onboarding check:** Open **Discord Account Linking** and verify that the initial Gamemaster association appears. Then use it to add players before inviting them to join through Millwright. Repeat account linking as needed for each world; mappings are world-specific.

Foundry's initial setup involves license activation, configuring its own administrator credentials in Application Configuration (which requires a restart), installing a game system, creating a world, and configuring the first Gamemaster user. The Foundry administrator password is distinct from the world Gamemaster password and must be entered in Millwright **Integration Settings** for automated administration.

## Clean-install test plan

1. Preserve any production deployment and backups; use a separate disposable persistent data directory.
2. Clone a clean checkout, run the installer, and confirm the selected data directory and archive.
3. Configure Discord, DuckDNS, and networking using test credentials or explicitly approved reusable credentials.
4. Decline activation and verify no operational containers were started.
5. Rerun the installer and confirm existing settings are retained.
6. Validate and approve activation; inspect container health, DNS, TLS, Discord OAuth2, and Foundry onboarding.
7. Stop the disposable deployment before cleanup. Remove only explicitly verified test paths.

## Verified installation and recovery results (October 2026)

A clean installation was exercised using a disposable data directory separate from the operator's existing Foundry data. The guided installer, initial Foundry configuration, Millwright administrator bootstrap, bundled module installation, service account provisioning, GM Discord linking, player linking, integration credential storage, and world persistence were tested successfully.

The Foundry, middleware, and gateway containers were each restarted successfully during testing. The Compose configuration uses `restart: unless-stopped` for all three services. The policy was verified on the deployed containers, but **automatic recovery after an unexpected application crash remains unverified**. An explicit `docker kill` left the middleware stopped; subsequent attempts to signal PID 1 from within the container did not terminate it. Do not represent those attempts as successful automatic recovery tests.

To inspect the active restart policies:

```powershell
 docker inspect --format '{{.Name}}: {{.HostConfig.RestartPolicy.Name}}' millwright-foundry-1 millwright-middleware-1 millwright-caddy-1
```

Normal operations and intentional shutdowns should continue to use Millwright's supported scripts. Do not use `docker kill` as a routine shutdown procedure.

**Still to verify before release:** actual automatic recovery after an unexpected container failure and final release checks. External player access through the public hostname was verified. The guided installer remains pre-release.
