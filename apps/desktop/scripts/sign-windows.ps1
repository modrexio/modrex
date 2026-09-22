# Tauri runs this for the app exe, the NSIS uninstaller and the installer.
# Swapping the signing provider means changing only this file and its secrets.
param([Parameter(Mandatory)][string]$Path)

$ErrorActionPreference = 'Stop'

artifact-signing-cli `
    --endpoint https://eus.codesigning.azure.net `
    --account modrexsigning `
    --certificate modrex-public `
    --description Modrex `
    $Path

if ($LASTEXITCODE -ne 0) {
    throw "artifact-signing-cli exited with $LASTEXITCODE while signing $Path"
}
