# Initial installation: persistent storage initialization (Windows)

This walkthrough covers the **standalone storage-initialization phase** of Foundry-Millwright. For the tested end-to-end setup path, use the [guided installer](guided-installation.md) instead. Initializing storage does **not** start containers, configure Discord or DuckDNS, or expose Foundry to the internet.

## Prerequisites

Before starting, the operator must install and configure:

- Windows with **PowerShell 7**.
- **Docker Desktop configured to use the WSL2 backend (not Docker VMM)**, running and usable by the operator. Docker Desktop's own WSL2 prerequisites are sufficient.
- The Millwright source directory, obtained by Git clone or ZIP extraction. See [Downloading and updating Millwright](download-and-installation.md). Git is optional for ZIP installs.
- A valid Foundry VTT license and the **Foundry VTT Node.js distribution ZIP** downloaded from the operator's Foundry account.
- A persistent storage location on a suitable local drive, **outside** the Millwright source directory.
- Permission to approve a Windows **User Account Control (UAC)** elevation request.

The initializer does not install or configure PowerShell, Docker Desktop, WSL2, Git, or a Discord application. The operator is responsible for those prerequisites.

## 1. Open PowerShell 7 in the source directory

Use a normal, non-elevated PowerShell 7 session. Substitute your actual source location:

```powershell
Set-Location 'C:\Millwright'
```

Verify that `scripts\Initialize-Millwright.ps1` exists. Do **not** put persistent data inside the source directory: source updates may replace that directory.

## 2. Run guided initialization

```powershell
.\scripts\Initialize-Millwright.ps1
```

The script explains its objectives and walks through path selection, validation, elevation, and storage creation.

**Persistent data directory:** Choose either a Windows folder picker or manual path entry. For example, `F:\GameNight\Millwright`. The script echoes the selection and validates it. The parent directory must exist, and the selected data location must not be inside the repository.

**Foundry distribution ZIP:** Choose either a Windows file picker or manual path entry. Select the **Node.js distribution ZIP**, not an extracted directory or the Millwright source ZIP. The script echoes the selection and validates the ZIP structure.

**Administrator approval:** Before elevation, the script explains why it needs administrator privileges and waits. Press **Enter** to request elevation or enter **C** to cancel. Windows then displays its UAC prompt. The selected paths are passed to the elevated process; you should not have to choose them again.

**Archive management:** The script copies the Foundry ZIP into `<data directory>\sources\`, checks its SHA-256 checksum against the original, and reports when the managed archive is ready. If an identical managed archive already exists, it is reused rather than recopied. The managed path is written to `FOUNDRY_ARCHIVE`.

**Storage and configuration:** The initializer creates the persistent `.env`, required directories, protected local secrets, and the Gateway Caddyfile. It creates a **symbolic link** at `<source directory>\.env` pointing to `<data directory>\.env`. The persistent file is authoritative; the repository link is not a second configuration copy.

The script ends with a summary of the persistent configuration path, managed ZIP, and repository link. **No services are started by this step.**

## 3. Verify the result

From the source directory, run these read-only commands, substituting the data path you selected:

```powershell
Get-Item -Force '.\.env' | Select-Object FullName, LinkType, Target
Test-Path 'F:\GameNight\Millwright\.env'
Get-ChildItem 'F:\GameNight\Millwright\sources' -Filter '*.zip' | Select-Object Name, Length
```

Expected results:

- The repository `.env` has `LinkType` **SymbolicLink** and targets the persistent `.env`.
- The persistent `.env` exists.
- The managed Foundry ZIP exists in the persistent `sources` directory.
- The initializer reports successful archive checksum verification and storage initialization.

**Never paste the contents of `.env` or secret files into a support request.** Treat the `secrets` directory as sensitive and back it up securely.

## 4. Rerunning initialization and updating source files

Rerunning initialization against the same deployment should preserve the existing `.env`, secrets, Caddyfile, and data. It should reuse the existing managed ZIP when unchanged. The initialization workflow was tested for configuration and secret preservation; it is not a substitute for backups.

When replacing the source directory (including a ZIP-based update), preserve the **persistent data directory**. The new source directory may not contain the original `.env` symbolic link. **Recover that link using the procedure below before running update or configuration scripts.** Do not copy a template `.env` into the source directory.

The initializer intentionally rejects a conflicting regular `.env` file or a link pointing to a different deployment rather than silently overwriting it.

### Recovering the .env link after replacing source files

Use this **link-only** procedure when replacing or extracting the Millwright source directory. It does not modify the persistent `.env`, secrets, Foundry archive, or worlds, and does not run initialization.

1. Identify the **existing persistent data directory** from your backup or deployment records. Verify that its `.env` exists. Do not guess the path or create a new `.env`.
2. Open PowerShell 7 in the **new** source directory. Run the following block after editing both paths to match your installation:

   ```powershell
   $sourceDirectory = 'C:\Millwright'
   $persistentDirectory = 'F:\GameNight\Millwright'
   $persistentEnv = Join-Path $persistentDirectory '.env'
   $sourceEnv = Join-Path $sourceDirectory '.env'

   if (-not (Test-Path -LiteralPath $sourceDirectory -PathType Container)) {
       throw "Source directory does not exist: $sourceDirectory"
   }
   if (-not (Test-Path -LiteralPath $persistentEnv -PathType Leaf)) {
       throw "Persistent configuration is missing; stopping: $persistentEnv"
   }
   if (Get-Item -LiteralPath $sourceEnv -Force -ErrorAction SilentlyContinue) {
       throw "Source .env already exists; inspect it before proceeding: $sourceEnv"
   }

   New-Item -ItemType SymbolicLink -Path $sourceEnv -Target $persistentEnv -ErrorAction Stop | Out-Null
   Get-Item -LiteralPath $sourceEnv -Force | Select-Object FullName, LinkType, Target
   ```

3. Confirm that `LinkType` is `SymbolicLink` and `Target` is the **existing persistent** `.env` you intended. Do not proceed if the target is wrong.
4. Continue with the documented update workflow. **Do not run `Initialize-Millwright.ps1` solely to restore the link.** Initialization also validates the Foundry archive and can require you to select a ZIP again.

**If `source\.env` already exists:** Stop. If it is already the correct symbolic link, no recovery is needed. If it is a regular file, broken link, or link to another deployment, back it up and investigate; do not automatically overwrite or delete it.

**Windows permissions:** Creating a symbolic link may require an elevated PowerShell session unless Windows Developer Mode permits unprivileged link creation. Elevate only if the link operation reports a privilege error. Never run the update against a missing or ambiguous configuration link.

## 5. Continue deployment configuration

Storage initialization is only the first phase. The remaining setup includes:

1. [Discord application and bot setup](discord-setup.md) and the `Set-DiscordConfig.ps1` configuration workflow.
2. [DuckDNS hostname setup](duckdns-setup.md) and `Set-DuckDNSConfig.ps1`.
3. Router connectivity using `Set-PortForwardingConfig.ps1` (UPnP or manual forwarding as supported).
4. Configuration validation and stack startup, then Millwright administrator onboarding and Foundry configuration.

The guided clean-install and onboarding sequence has been exercised in a disposable deployment; see [Guided installation](guided-installation.md) for the current end-to-end workflow. This page focuses on standalone storage initialization. Do not expose Foundry's internal container port directly to the internet.

## Troubleshooting

- **PowerShell parser error:** Ensure your source checkout is current. Do not proceed with a partially updated script.
- **Folder rejected:** Use a path outside the source directory, with an existing parent directory.
- **ZIP rejected:** Download the Foundry **Node.js** distribution ZIP; verify it is intact.
- **UAC denied or cancelled:** Initialization stops; rerun and approve elevation when ready.
- **Repository `.env` is a regular file:** Back up and reconcile it explicitly before rerunning. The initializer will not overwrite it.
- **Existing managed ZIP differs from the selected ZIP:** Resolve the archive conflict deliberately; the initializer will not silently overwrite the existing managed archive.
- **Docker or network errors:** Storage initialization does not validate the complete running deployment. Verify Docker Desktop/WSL2 and later network configuration separately.
