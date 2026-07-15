# Installs the latest imp release into %LOCALAPPDATA%\imp\bin.
#
#   irm https://raw.githubusercontent.com/imp-build/imp/main/install.ps1 | iex
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/imp-build/imp/main/install.ps1))) -Draft

[CmdletBinding()]
param(
    [switch]$Draft
)

$ErrorActionPreference = "Stop"

$repo = "imp-build/imp"
$installDir = if ($env:IMP_INSTALL_DIR) { $env:IMP_INSTALL_DIR } else { "$env:LOCALAPPDATA\imp\bin" }

$target = "x86_64-pc-windows-msvc"
$asset = "imp-$target.zip"

$tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path $tmpDir | Out-Null

try {
    $zipPath = Join-Path $tmpDir $asset
    if ($Draft) {
        if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
            throw "-Draft requires the GitHub CLI; install gh and authenticate with 'gh auth login'"
        }
        Write-Host "Downloading $asset from the main-preview draft"
        & gh release download main-preview --repo $repo --pattern $asset --dir $tmpDir
        if ($LASTEXITCODE -ne 0) {
            throw "GitHub CLI failed to download $asset from the main-preview draft"
        }
    } else {
        $url = "https://github.com/$repo/releases/latest/download/$asset"
        Write-Host "Downloading $url"
        Invoke-WebRequest -Uri $url -OutFile $zipPath
    }

    Expand-Archive -Path $zipPath -DestinationPath $tmpDir -Force

    New-Item -ItemType Directory -Force -Path $installDir | Out-Null
    Move-Item -Force (Join-Path $tmpDir "imp.exe") (Join-Path $installDir "imp.exe")

    Write-Host "Installed imp to $installDir\imp.exe"

    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if (-not ($userPath -split ";" | Where-Object { $_ -eq $installDir })) {
        [Environment]::SetEnvironmentVariable("Path", "$userPath;$installDir", "User")
        Write-Host "Added $installDir to your user PATH. Restart your shell to pick it up."
    }
} finally {
    Remove-Item -Recurse -Force $tmpDir
}
