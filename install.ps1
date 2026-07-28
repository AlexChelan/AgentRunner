# OpenCompanion installer for Windows. One command, no npm:
#
#   $env:OPENCOMPANION_BACKEND_URL='https://your-saas.example/api'; irm https://github.com/AlexChelan/OpenCompanion/releases/latest/download/install.ps1 | iex
#
# It downloads the self-contained OpenCompanion daemon for your architecture, verifies it against the
# release SHA256SUMS, installs it under %LOCALAPPDATA%\opencompanion, adds it to your PATH, then runs
# `opencompanion setup` (pair + connect your CLIs + install the always-on Scheduled Task). Re-run any
# time to upgrade in place; uninstall with `opencompanion uninstall`.
#
# Set OPENCOMPANION_APP_SCOPED=1 (or pass -AppScoped) to install the binary only and SKIP setup - the
# product app then drives pairing and starts the daemon itself, so no always-on task is installed.
#
# Nothing is baked in. No backend URL is embedded: set OPENCOMPANION_BACKEND_URL (or pass -Url when you
# run a saved copy of this script) to pair with your SaaS at setup time. Point OPENCOMPANION_RELEASE_BASE
# at a mirror to fetch the daemon elsewhere.
param([string]$Url = $env:OPENCOMPANION_BACKEND_URL, [switch]$AppScoped)
$ErrorActionPreference = 'Stop'
# App-scoped is driven by the -AppScoped switch or OPENCOMPANION_APP_SCOPED=1 (the `irm | iex` one-liner
# cannot pass a switch, so the env var is its channel). The env var is compared to '1' explicitly: a
# [bool] cast would make ANY non-empty value truthy, so '0' would wrongly mean app-scoped.
$appScopedMode = $AppScoped.IsPresent -or ($env:OPENCOMPANION_APP_SCOPED -eq '1')

$ReleaseBase = if ($env:OPENCOMPANION_RELEASE_BASE) { $env:OPENCOMPANION_RELEASE_BASE } else { 'https://github.com/AlexChelan/OpenCompanion/releases/latest/download' }
$InstallDir  = if ($env:OPENCOMPANION_HOME)         { $env:OPENCOMPANION_HOME }         else { Join-Path $env:LOCALAPPDATA 'opencompanion' }

function Fail($msg) { Write-Host "error: $msg" -ForegroundColor Red; exit 1 }

# PROCESSOR_ARCHITECTURE reports the shell's arch (x86 under a 32-bit PowerShell); on ARM64 Windows in that case the real OS arch is in PROCESSOR_ARCHITEW6432.
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } else { 'x64' }
$artifact = "opencompanion-win32-$arch.tar.gz"
$base = $ReleaseBase.TrimEnd('/')

Write-Host "Installing OpenCompanion (win32/$arch)" -ForegroundColor White
$tmp = New-Item -ItemType Directory -Path (Join-Path $env:TEMP ("opencompanion-" + [guid]::NewGuid()))
try {
  $tar = Join-Path $tmp $artifact
  $tarUrl = "$base/$artifact"
  Write-Host "Downloading $tarUrl"
  try {
    Invoke-WebRequest -Uri $tarUrl -OutFile $tar -UseBasicParsing
  } catch {
    Fail "No build for win32/$arch at $tarUrl. Check that the release includes $artifact."
  }
  Write-Host "Downloading $base/SHA256SUMS"
  $sumsPath = Join-Path $tmp 'SHA256SUMS'
  try {
    Invoke-WebRequest -Uri "$base/SHA256SUMS" -OutFile $sumsPath -UseBasicParsing
  } catch {
    Fail "Could not fetch $base/SHA256SUMS. Refusing to install an unverified download."
  }

  # Verification is mandatory: no matching, present checksum means we abort rather than install.
  $expected = $null
  foreach ($line in Get-Content $sumsPath) {
    $parts = $line -split '\s+', 2
    if ($parts.Count -eq 2 -and ($parts[1].TrimStart('*') -eq $artifact)) { $expected = $parts[0].ToLower(); break }
  }
  if (-not $expected) { Fail "No checksum for $artifact in SHA256SUMS." }
  $actual = (Get-FileHash -Algorithm SHA256 -Path $tar).Hash.ToLower()
  if ($actual -ne $expected) { Fail "Checksum mismatch for $artifact (expected $expected, got $actual). Refusing to install." }
  Write-Host "Checksum verified." -ForegroundColor Green

  # Extract into a staging dir so we can read the payload's own version before committing it to a
  # versioned slot. The archive holds the per-version launcher at .\opencompanion.cmd.
  $payload = New-Item -ItemType Directory -Path (Join-Path $tmp 'payload')
  tar -xzf $tar -C $payload   # bsdtar ships with Windows 10 and later
  $payloadExe = Join-Path $payload 'opencompanion.cmd'
  if (-not (Test-Path $payloadExe)) { Fail "The downloaded archive did not contain the opencompanion launcher." }

  # The version names the install slot and the `current` pointer. Parse it from the payload's own
  # `--version` (format: `opencompanion <semver>`) - the second whitespace-separated token.
  $version = (((& $payloadExe --version) | Out-String).Trim() -split '\s+')[1]
  if (-not $version) { Fail "Could not determine the downloaded version (opencompanion --version returned nothing)." }

  Write-Host "Installing OpenCompanion $version to $InstallDir"

  # Legacy flat install (pre-versioned layout): the old installer dropped node.exe/daemon/opencompanion.cmd
  # straight into $InstallDir. Detect it by a missing versions\ dir plus a present node.exe, and remove
  # ONLY those known payload entries - never the whole dir, which may hold the user's config.
  if ((-not (Test-Path (Join-Path $InstallDir 'versions'))) -and (Test-Path (Join-Path $InstallDir 'node.exe'))) {
    Write-Host "Migrating a pre-versioned install to the versioned layout."
    foreach ($entry in 'node.exe', 'daemon', 'opencompanion', 'opencompanion.cmd') {
      Remove-Item -Recurse -Force (Join-Path $InstallDir $entry) -ErrorAction SilentlyContinue
    }
  }

  # Commit the payload into versions\<version> (replacing that slot when reinstalling the same version).
  $dest = Join-Path (Join-Path $InstallDir 'versions') $version
  New-Item -ItemType Directory -Path (Join-Path $InstallDir 'versions') -Force | Out-Null
  if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
  Move-Item -Path $payload -Destination $dest

  # The stable root launcher resolves the active version from `current` and execs that version's
  # per-version launcher, exporting its own path so the boot task re-invokes it (not a versioned path)
  # and so a later update that flips `current` is picked up without re-registering the task. Written as
  # ASCII (no BOM) so `set /p` reads a clean value.
  $exe = Join-Path $InstallDir 'opencompanion.cmd'
  $launcherBody = @'
@echo off
setlocal
set /p CUR=<"%~dp0current"
set "OPENCOMPANION_ROOT_LAUNCHER=%~dp0opencompanion.cmd"
"%~dp0versions\%CUR%\opencompanion.cmd" %*
endlocal & exit /b %ERRORLEVEL%
'@
  # cmd.exe batch parsing needs CRLF; this here-string is stored LF-only in the exported script, so
  # normalize to CRLF (collapse any CRLF first so re-running never doubles them) and add a trailing
  # CRLF, then write the exact bytes with -NoNewline so Set-Content adds no terminator of its own.
  $launcherBody = ($launcherBody -replace "`r`n", "`n" -replace "`n", "`r`n") + "`r`n"
  Set-Content -Path $exe -Value $launcherBody -NoNewline -Encoding ascii

  # Flip the pointer atomically (write a temp, then move over) so a reader never sees a half-written
  # version. No trailing newline, so `set /p CUR` reads exactly the version string.
  $pointerTmp = Join-Path $InstallDir 'current.tmp'
  Set-Content -Path $pointerTmp -Value $version -NoNewline -Encoding ascii
  Move-Item -Path $pointerTmp -Destination (Join-Path $InstallDir 'current') -Force

  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($userPath -notlike "*$InstallDir*") {
    [Environment]::SetEnvironmentVariable('Path', "$userPath;$InstallDir", 'User')
    Write-Host "Added $InstallDir to your PATH (restart the terminal to use 'opencompanion' directly)."
  }

  if ($appScopedMode) {
    # App-scoped: the product app supervises the daemon, so install the binary only and let the app drive
    # pairing + an app-scoped setup + a plain `serve`. Never install the always-on task from here.
    Write-Host "Installed. The app will pair and start OpenCompanion for you." -ForegroundColor Green
  } else {
    Write-Host "Installed. Running setup..." -ForegroundColor Green
    if ($Url) { & $exe setup --url $Url } else { & $exe setup }
  }
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
