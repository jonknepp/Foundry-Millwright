#Requires -Version 7.0
# First-run Windows path selection helpers. Dot-source from the interactive,
# unelevated PowerShell session before initialization requests UAC.
function Read-MillwrightPathSelectionMode {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Purpose)

    while ($true) {
        Write-Host ''
        Write-Host $Purpose
        Write-Host '  [1] Browse using a Windows dialog'
        Write-Host '  [2] Enter or paste the full path'
        $choice = (Read-Host 'Choose 1 or 2 (default: 1)').Trim()
        switch ($choice) {
            { $_ -eq '' -or $_ -eq '1' } { return 'Browse' }
            '2' { return 'Manual' }
            default { Write-Host 'Invalid choice. Enter 1 or 2.' }
        }
    }
}

function Select-MillwrightFolder {
    [CmdletBinding()]
    param([string]$Description = 'Select Millwright persistent data directory')
    $mode = Read-MillwrightPathSelectionMode -Purpose 'Choose how to select the persistent Millwright data directory.'
    if ($mode -eq 'Browse' -and $IsWindows -and [Environment]::UserInteractive -and [Threading.Thread]::CurrentThread.GetApartmentState() -eq [Threading.ApartmentState]::STA) {
        try {
            Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
            $dialog = [System.Windows.Forms.FolderBrowserDialog]::new()
            try {
                $dialog.Description = $Description
                $dialog.ShowNewFolderButton = $true
                if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
                    return $dialog.SelectedPath
                }
                throw [System.OperationCanceledException]::new('Folder selection cancelled.')
            }
            finally { $dialog.Dispose() }
        }
        catch [System.OperationCanceledException] { throw }
        catch {
            Write-Warning "Folder picker unavailable: $($_.Exception.Message). Using console input."
        }
    }
    if ($mode -eq 'Browse' -and $IsWindows -and [Environment]::UserInteractive -and [Threading.Thread]::CurrentThread.GetApartmentState() -ne [Threading.ApartmentState]::STA) {
        Write-Host 'Windows folder dialog requires an STA thread; using console selection.'
    }
    $path = Read-Host $Description
    if ([string]::IsNullOrWhiteSpace($path)) {
        throw [System.OperationCanceledException]::new('Folder selection cancelled.')
    }
    return $path.Trim().Trim('"')
}

function Select-MillwrightFoundryArchive {
    [CmdletBinding()]
    param()
    $mode = Read-MillwrightPathSelectionMode -Purpose 'Choose how to select the Foundry VTT Node.js ZIP archive.'
    if ($mode -eq 'Browse' -and $IsWindows -and [Environment]::UserInteractive) {
        try {
            Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
            $dialog = [System.Windows.Forms.OpenFileDialog]::new()
            try {
                $dialog.Title = 'Select the Foundry VTT Node.js distribution ZIP'
                $dialog.Filter = 'ZIP archives (*.zip)|*.zip'
                $dialog.CheckFileExists = $true
                $dialog.Multiselect = $false
                if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
                    return $dialog.FileName
                }
                throw [System.OperationCanceledException]::new('Foundry archive selection cancelled.')
            }
            finally { $dialog.Dispose() }
        }
        catch [System.OperationCanceledException] { throw }
        catch {
            Write-Warning "Archive picker unavailable: $($_.Exception.Message). Using console input."
        }
    }
    if ($mode -eq 'Browse' -and $IsWindows -and [Environment]::UserInteractive -and [Threading.Thread]::CurrentThread.GetApartmentState() -ne [Threading.ApartmentState]::STA) {
        Write-Host 'Windows file dialog requires an STA thread; using console selection.'
    }
    $path = Read-Host 'Full path to Foundry VTT Node.js distribution ZIP'
    if ([string]::IsNullOrWhiteSpace($path)) {
        throw [System.OperationCanceledException]::new('Foundry archive selection cancelled.')
    }
    $path = $path.Trim().Trim('"')
    if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or
        [IO.Path]::GetExtension($path) -ine '.zip') {
        throw "Expected an existing ZIP archive: $path"
    }
    return $path
}
