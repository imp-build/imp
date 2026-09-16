+++
title = "Installing Imp"
weight = 1
template = "page.html"
+++

This page is for users who need to install the `imp` command. It covers the
supported install scripts and the first check after installation.

## Install on Linux

Run the installer from a shell. It downloads the latest published release and
installs `imp` into `$HOME/.local/bin` by default.

**Runnable example**

```sh
curl -fsSL https://raw.githubusercontent.com/imp-build/imp/main/install.sh | sh
```

Set `IMP_INSTALL_DIR` to choose another install directory. Use `--draft` for
the rolling `main-preview` build; that mode requires an authenticated GitHub
CLI. Use `--local` only when installing a checkout for Imp development.

Add the install directory to `PATH` if the script reports that it is missing.
Then check the command:

**Runnable example**

```sh
export PATH="$HOME/.local/bin:$PATH"
imp --help
```

## Install on Windows

Run the PowerShell installer. It installs into `%LOCALAPPDATA%\imp\bin` and
adds that directory to the user `PATH`.

**Runnable example**

```powershell
irm https://raw.githubusercontent.com/imp-build/imp/main/install.ps1 | iex
```

Use `-Draft` for the rolling `main-preview` build. Use `-Local` only from a
checked-out Imp repository with Cargo installed. Open a new terminal after the
installer updates `PATH`, then run `imp --help`.

The help output confirms that the executable starts. It does not validate a
workspace. Continue with [Getting started](../getting-started/) from the
workspace you want to build.

## Platform limits

The installers currently support x86_64 Linux with musl and x86_64 Windows with
MSVC. A different operating system or architecture needs a compatible build of
Imp; these installers do not claim to support it.
