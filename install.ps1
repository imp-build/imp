# Installs the latest imp release into %LOCALAPPDATA%\imp\bin.
#
#   irm https://raw.githubusercontent.com/imp-build/imp/main/install.ps1 | iex
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/imp-build/imp/main/install.ps1))) -Draft
#   .\install.ps1 -Local

[CmdletBinding()]
param(
    [switch]$Draft,
    [switch]$Local
)

$ErrorActionPreference = "Stop"

$repo = "imp-build/imp"
$installDir = if ($env:IMP_INSTALL_DIR) { $env:IMP_INSTALL_DIR } else { "$env:LOCALAPPDATA\imp\bin" }

if ($Draft -and $Local) {
    throw "-Draft and -Local cannot be used together"
}

function Add-InstallDirToUserPath {
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if (-not ($userPath -split ";" | Where-Object { $_ -eq $installDir })) {
        [Environment]::SetEnvironmentVariable("Path", "$userPath;$installDir", "User")
        Write-Host "Added $installDir to your user PATH. Restart your shell to pick it up."
    }
}

if ($Local) {
    if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
        throw "-Local requires cargo"
    }
    if (-not $MyInvocation.MyCommand.Path) {
        throw "-Local must be run from a local install.ps1 file, not piped via iex"
    }

    $repoDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $manifest = Join-Path $repoDir "crates\imp\Cargo.toml"
    $rulesDir = Join-Path $repoDir "rules"
    $targetDir = Join-Path $repoDir "target"
    $binary = Join-Path $targetDir "release\imp.exe"

    if (-not (Test-Path $manifest) -or -not (Test-Path $rulesDir)) {
        throw "-Local must be run from a checked-out imp repository"
    }

    Write-Host "Building optimized local imp"
    $env:CARGO_TARGET_DIR = $targetDir
    & cargo build --release --manifest-path $manifest
    if ($LASTEXITCODE -ne 0) {
        throw "cargo build failed"
    }

    New-Item -ItemType Directory -Force -Path $installDir | Out-Null

    # A stale imp.exe from a non-local install would shadow the shim, since
    # .exe resolves before .cmd on PATHEXT.
    $staleExe = Join-Path $installDir "imp.exe"
    if (Test-Path $staleExe) {
        Remove-Item -Force $staleExe
    }

    $shimPath = Join-Path $installDir "imp.cmd"
    $shimContent = @"
@echo off
set "IMP_RULES_DIR=$rulesDir"
set "CARGO_TARGET_DIR=$targetDir"
cargo build --release --manifest-path "$manifest" || exit /b 1
"$binary" %*
exit /b %ERRORLEVEL%
"@
    Set-Content -Path $shimPath -Value $shimContent -Encoding ascii -NoNewline

    # Bash (Git Bash/MSYS) does exact-name PATH lookup with no PATHEXT, so
    # "imp.cmd" alone won't resolve to a bare "imp" there. Native Windows
    # programs accept forward slashes too, so reuse the same paths as the
    # .cmd shim above, just with backslashes swapped for a POSIX-friendly sh script.
    $bashRulesDir = $rulesDir -replace '\\', '/'
    $bashTargetDir = $targetDir -replace '\\', '/'
    $bashManifest = $manifest -replace '\\', '/'
    $bashBinary = $binary -replace '\\', '/'
    $bashShimPath = Join-Path $installDir "imp"
    $bashShimLines = @(
        '#!/bin/sh',
        'set -e',
        "export IMP_RULES_DIR='$bashRulesDir'",
        "CARGO_TARGET_DIR='$bashTargetDir' cargo build --release --manifest-path '$bashManifest'",
        "exec '$bashBinary' `"`$@`""
    )
    Set-Content -Path $bashShimPath -Value (($bashShimLines -join "`n") + "`n") -Encoding ascii -NoNewline

    Write-Host "Installed local imp shim to $shimPath"
    Write-Host "Installed bash-compatible shim to $bashShimPath"
    Write-Host "Binary: $binary"
    Write-Host "Rules:  $rulesDir (live from this checkout, via IMP_RULES_DIR)"
    Write-Host "The shim will rebuild changed Rust code before each run."

    Add-InstallDirToUserPath
    exit 0
}

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

    # The archive is a self-contained prefix (bin\ + share\imp\rules\),
    # because the rule library is no longer compiled into the binary. Install
    # both, keeping the relative layout so imp finds its rules next to
    # itself: <installDir>\..\share\imp\rules.
    $stage = Join-Path $tmpDir "imp-$target"
    $stagedRules = Join-Path $stage "share\imp\rules"
    if (-not (Test-Path $stagedRules)) {
        throw "$asset is missing share\imp\rules; it predates on-disk rules - upgrade install.ps1"
    }

    $rulesRoot = if ($env:IMP_RULES_INSTALL_DIR) {
        $env:IMP_RULES_INSTALL_DIR
    } else {
        Join-Path (Split-Path -Parent $installDir) "share\imp\rules"
    }

    New-Item -ItemType Directory -Force -Path $installDir | Out-Null
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $rulesRoot) | Out-Null

    # Replace rather than merge: a rule deleted upstream would otherwise
    # linger and still resolve.
    if (Test-Path $rulesRoot) {
        Remove-Item -Recurse -Force $rulesRoot
    }
    Move-Item $stagedRules $rulesRoot
    Move-Item -Force (Join-Path $stage "bin\imp.exe") (Join-Path $installDir "imp.exe")

    Write-Host "Installed imp to $installDir\imp.exe"
    Write-Host "Installed rules to $rulesRoot"

    Add-InstallDirToUserPath
} finally {
    Remove-Item -Recurse -Force $tmpDir
}
