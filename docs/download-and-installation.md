# Downloading and updating Millwright

This guide explains how to obtain Millwright on Windows **with or without Git**. Millwright is pre-release; when published releases become available, use a release rather than an in-development branch.

## Before you begin

You need a browser and a permanent folder for the project files. Running Millwright additionally requires PowerShell 7, Docker Desktop configured to use the WSL2 backend rather than Docker VMM, and a licensed Foundry VTT distribution. No WSL2 setup beyond Docker Desktop's requirements is needed.

Keep **project source** (for example, `C:\Millwright`) separate from **persistent game data** (for example, `C:\MillwrightData`). The `MILLWRIGHT_DATA_DIR` setting must point outside the project directory. Never delete that data directory during source updates.

## Option A: Download a ZIP — Git not required

1. Open the [Foundry-Millwright GitHub repository](https://github.com/jonknepp/Foundry-Millwright). The repository must be made public before general users can access it.
2. When releases are published, select **Releases**, open the desired version, and download its ZIP archive. For development testing only, select the intended branch, click the green **Code** button, then **Download ZIP**.
3. In File Explorer, right-click the downloaded ZIP and select **Extract All**.
4. Move or rename the extracted folder to `C:\Millwright` (or another permanent location). The `scripts`, `config`, `middleware`, and `foundry-module` folders should be directly inside it.
5. Open PowerShell 7:

   ```powershell
   Set-Location 'C:\Millwright'
   ```

Downloading the files is **not** the same as installing or starting the stack. Continue with the [initialization walkthrough](initial-installation.md).

### Updating without Git

1. Schedule downtime: the update may restart Foundry and interrupt games.
2. Back up the persistent data directory, including its authoritative `.env`, secrets, and worlds. Record the existing persistent data path.
3. Download the new release ZIP and extract it to a **separate** folder.
4. Replace the old project source with the new version. Do not blindly overwrite new release files with old customized source files. **Do not replace or delete `MILLWRIGHT_DATA_DIR`.**
5. Before running an update script, [restore the repository `.env` symbolic link](initial-installation.md#recovering-the-env-link-after-replacing-source-files) if the new source directory does not have it. This is a link-only operation; **do not rerun initialization just to recreate the link**, and do not copy the persistent `.env` into the source directory.
6. Verify the restored link points to the intended persistent deployment. Then, from PowerShell 7 in the updated project directory, run:

   ```powershell
   .\scripts\Update-Millwright.ps1
   ```

The script deploys the locally available source files without requiring Git. Do not pass `-Pull` for a ZIP installation. The update script expects an already initialized, running stack; it is **not** an initial installation command. Review prompts, container status, and release notes before declaring success.

## Option B: Clone with Git — recommended for ongoing maintenance

1. Install [Git for Windows](https://git-scm.com/downloads/win).
2. Open PowerShell 7 and confirm installation:

   ```powershell
   git --version
   ```

3. Clone the repository:

   ```powershell
   Set-Location 'C:\'
   git clone https://github.com/jonknepp/Foundry-Millwright.git Millwright
   Set-Location 'C:\Millwright'
   ```

4. **Pre-release testers only:** switch to the designated development branch if instructed:

   ```powershell
   git switch feature/middleware-foundation
   ```

Cloning obtains the source files; it does not configure Docker, Discord, or Foundry.

### Updating with Git

Arrange downtime and back up data. In PowerShell 7:

```powershell
Set-Location 'C:\Millwright'
.\scripts\Update-Millwright.ps1 -Pull
```

The `-Pull` option downloads changes using `git pull --ff-only` and then runs the deployment workflow. It refuses to pull when the Git working tree has uncommitted changes. Review changes rather than discarding them.

**Why choose Git?** It tracks the installed source revision, simplifies retrieving updates, and makes troubleshooting and comparing changes easier. It does not replace backups or deployment validation. Prefer documented stable release tags or branches once available.

## Files, privileges, and security

The source directory contains scripts and templates. Persistent Foundry worlds, deployed configuration, secrets, and backups belong under `MILLWRIGHT_DATA_DIR`. The project-root `.env` is a symbolic link to the authoritative `.env` inside `MILLWRIGHT_DATA_DIR`. If the source directory is replaced during a ZIP upgrade, use the [link-only recovery procedure](initial-installation.md#recovering-the-env-link-after-replacing-source-files). Rerunning initialization is not necessary for link recovery and may require access to the original Foundry ZIP. Never replace persistent configuration with a template. Never commit or share `.env` or secret files.

`Initialize-Millwright.ps1` **requests Windows Administrator elevation through UAC** to apply filesystem access-control protections. Installing Docker Desktop or enabling WSL2 features can also require elevation. Routine operation should use a normal PowerShell session with appropriate Docker and filesystem access.

## Related documentation

- [Initial installation and storage setup](initial-installation.md)
- [Project overview](../README.md)
- [Discord setup](discord-setup.md) — current OAuth2 authentication and world-specific account mapping instructions
- [Millwright Service](../middleware/README.md)
- [Millwright Module](../foundry-module/README.md)
