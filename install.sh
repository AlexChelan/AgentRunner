#!/usr/bin/env bash
# AgentRunner installer for macOS and Linux. One command, no npm:
#
#   curl -fsSL https://github.com/AlexChelan/AgentRunner/releases/latest/download/install.sh | sh -s -- --url https://your-saas.example/api
#
# It downloads the self-contained AgentRunner daemon (a vendored Node runtime + the bundled daemon)
# for your OS and architecture, verifies it against the release SHA256SUMS, installs it under
# ~/.agentrunner, links the `agentrunner` launcher onto your PATH, then runs `agentrunner setup` (pair +
# connect your CLIs + install the always-on service). Re-run any time to upgrade in place;
# uninstall with `agentrunner uninstall`.
#
# Pass --app-scoped (or set AGENTRUNNER_APP_SCOPED=1) to install the binary only and SKIP setup - the
# product app then drives pairing and starts the daemon itself, so no always-on service is installed.
#
# Nothing is baked in. The daemon is fetched from the GitHub release by default; point
# AGENTRUNNER_RELEASE_BASE at a mirror to fetch it elsewhere. No backend URL is embedded: pass
# `--url <backend>` (or set AGENTRUNNER_BACKEND_URL) to pair with your SaaS at setup time.
#
# Pass --enroll <code> (or set AGENTRUNNER_ENROLL) to pair with a one-time enrollment code from your
# app instead of the interactive device flow - the whole install then needs no further input.
set -eu

RELEASE_BASE="${AGENTRUNNER_RELEASE_BASE:-https://github.com/AlexChelan/AgentRunner/releases/latest/download}"
INSTALL_DIR="${AGENTRUNNER_HOME:-$HOME/.agentrunner}"
BIN_DIR="${AGENTRUNNER_BIN_DIR:-$HOME/.local/bin}"
BACKEND_URL="${AGENTRUNNER_BACKEND_URL:-}"
ENROLL="${AGENTRUNNER_ENROLL:-}"
# App-scoped is driven by the --app-scoped flag below or AGENTRUNNER_APP_SCOPED=1. The env is compared to
# `1` exactly (never `-n`, which any non-empty value satisfies, so `0` would wrongly mean app-scoped).
APP_SCOPED="${AGENTRUNNER_APP_SCOPED:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --url) BACKEND_URL="${2:-}"; shift 2 ;;
    --url=*) BACKEND_URL="${1#--url=}"; shift ;;
    --enroll) ENROLL="${2:-}"; shift 2 ;;
    --enroll=*) ENROLL="${1#--enroll=}"; shift ;;
    --app-scoped) APP_SCOPED=1; shift ;;
    *) shift ;;
  esac
done

if [ -t 1 ]; then
  BOLD='\033[1m'; DIM='\033[2m'; RED='\033[31m'; GREEN='\033[32m'; NC='\033[0m'
else
  BOLD=''; DIM=''; RED=''; GREEN=''; NC=''
fi
info() { printf "${DIM}%s${NC}\n" "$1"; }
ok() { printf "${GREEN}%s${NC}\n" "$1"; }
fail() { printf "${RED}error:${NC} %s\n" "$1" >&2; exit 1; }

os="$(uname -s)"; arch="$(uname -m)"
case "${os}" in
  Darwin) os="darwin" ;;
  Linux) os="linux" ;;
  *) fail "Unsupported OS: ${os} (macOS and Linux only; use install.ps1 on Windows)." ;;
esac
case "${arch}" in
  x86_64|amd64) arch="x64" ;;
  arm64|aarch64) arch="arm64" ;;
  *) fail "Unsupported architecture: ${arch}." ;;
esac
artifact="agentrunner-${os}-${arch}.tar.gz"

download() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then wget -qO "$2" "$1"
  else fail "Need curl or wget to download AgentRunner."; fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  else fail "Need sha256sum or shasum to verify the download."; fi
}

printf "${BOLD}Installing AgentRunner${NC} (${os}/${arch})\n"
tmp="$(mktemp -d)"; trap 'rm -rf "${tmp}"' EXIT
base="${RELEASE_BASE%/}"

info "Downloading ${base}/${artifact}"
download "${base}/${artifact}" "${tmp}/${artifact}" || fail "Download failed. Check that the release for ${os}/${arch} exists at ${base}."
info "Downloading ${base}/SHA256SUMS"
download "${base}/SHA256SUMS" "${tmp}/SHA256SUMS" || fail "Could not fetch SHA256SUMS. Refusing to install an unverified download."

# Verification is mandatory: no matching, present checksum means we abort rather than install.
expected="$(awk -v f="${artifact}" '$2 == f || $2 == "*"f { print $1; exit }' "${tmp}/SHA256SUMS")"
[ -n "${expected}" ] || fail "No checksum for ${artifact} in SHA256SUMS."
actual="$(sha256_of "${tmp}/${artifact}")"
[ "${actual}" = "${expected}" ] || fail "Checksum mismatch for ${artifact} (expected ${expected}, got ${actual}). Refusing to install."
ok "Checksum verified."

# Extract into a staging dir so we can read the payload's own version before committing it to a
# versioned slot. The archive holds the per-version launcher at ./agentrunner.
payload="${tmp}/payload"
mkdir -p "${payload}"
tar -xzf "${tmp}/${artifact}" -C "${payload}"
[ -f "${payload}/agentrunner" ] || fail "The downloaded archive did not contain the agentrunner launcher."
chmod +x "${payload}/agentrunner"

# The version names the install slot and the `current` pointer. Parse it from the payload's own
# `--version` (format: `agentrunner <semver>`) - the second whitespace-separated token.
version="$("${payload}/agentrunner" --version | awk '{ print $2; exit }')"
[ -n "${version}" ] || fail "Could not determine the downloaded version (agentrunner --version returned nothing)."

info "Installing AgentRunner ${version} to ${INSTALL_DIR}"

# Legacy flat install (pre-versioned layout): the old installer dropped node/daemon/agentrunner
# straight into ${INSTALL_DIR}. Detect it by a missing versions/ dir plus a present node entry, and
# remove ONLY those known payload entries - never the whole dir, which may hold the user's config.
if [ ! -d "${INSTALL_DIR}/versions" ] && [ -e "${INSTALL_DIR}/node" ]; then
  info "Migrating a pre-versioned install to the versioned layout."
  rm -rf "${INSTALL_DIR}/node" "${INSTALL_DIR}/daemon" "${INSTALL_DIR}/agentrunner" "${INSTALL_DIR}/agentrunner.cmd"
fi

# Commit the payload into versions/<version> (replacing that slot when reinstalling the same version).
mkdir -p "${INSTALL_DIR}/versions"
dest="${INSTALL_DIR}/versions/${version}"
rm -rf "${dest}"
mv "${payload}" "${dest}"

# The stable root launcher resolves the active version from `current` and execs that version's
# per-version launcher, exporting its own path so the boot service re-invokes it (not a versioned
# path) and so a later update that flips `current` is picked up without touching the OS unit.
cat > "${INSTALL_DIR}/agentrunner" <<'LAUNCHER'
#!/bin/sh
# AgentRunner stable launcher: resolves the active version from `current` and execs it.
# Follow `$0` through symlinks first (the PATH entry is a symlink into the install dir), so `dir` is
# the real install dir and not wherever the symlink lives. POSIX readlink loop - no `readlink -f`,
# which macOS lacks.
self="$0"
while [ -L "${self}" ]; do
  target="$(readlink "${self}")"
  case "${target}" in
    /*) self="${target}" ;;
    *) self="$(dirname -- "${self}")/${target}" ;;
  esac
done
dir="$(CDPATH= cd -- "$(dirname -- "${self}")" && pwd)"
current="$(cat "${dir}/current" 2>/dev/null || true)"
[ -n "${current}" ] || { echo "agentrunner: no installed version (missing ${dir}/current)" >&2; exit 1; }
AGENTRUNNER_ROOT_LAUNCHER="${dir}/agentrunner" exec "${dir}/versions/${current}/agentrunner" "$@"
LAUNCHER
chmod +x "${INSTALL_DIR}/agentrunner"

# Flip the pointer atomically (write a temp, then rename) so a reader never sees a half-written version.
printf '%s\n' "${version}" > "${INSTALL_DIR}/current.tmp"
mv "${INSTALL_DIR}/current.tmp" "${INSTALL_DIR}/current"

mkdir -p "${BIN_DIR}"
ln -sf "${INSTALL_DIR}/agentrunner" "${BIN_DIR}/agentrunner"
case ":${PATH}:" in
  *":${BIN_DIR}:"*) ;;
  *) info "Add ${BIN_DIR} to your PATH to run 'agentrunner' directly." ;;
esac

if [ "${APP_SCOPED}" = "1" ]; then
  # App-scoped: the product app supervises the daemon, so install the binary only and let the app drive
  # pairing + an app-scoped setup + a plain `serve`. Never install the always-on service from here.
  ok "Installed. The app will pair and start AgentRunner for you."
else
  ok "Installed. Running setup..."
  if [ -n "${BACKEND_URL}" ]; then set -- setup --url "${BACKEND_URL}"; else set -- setup; fi
  # A one-time enrollment code pairs without a prompt; without one, setup keeps its interactive flow.
  if [ -n "${ENROLL}" ]; then set -- "$@" --enroll "${ENROLL}"; fi
  # Piped installs (curl | sh) leave stdin on the exhausted script pipe; re-attach the real terminal
  # so setup's prompts and the CLIs' interactive logins still work. Headless (no controlling tty),
  # setup degrades gracefully: it pairs, reports the detected CLIs, and installs the service without
  # prompting. Probe the redirection itself (not just -e/-r): on a headless host /dev/tty can exist
  # and pass the permission tests yet fail to open with ENXIO. The `if` keeps `set -e` from aborting
  # on that expected headless failure; only a working /dev/tty takes the redirected path.
  if { : < /dev/tty; } 2>/dev/null; then
    "${INSTALL_DIR}/agentrunner" "$@" < /dev/tty
  else
    "${INSTALL_DIR}/agentrunner" "$@"
  fi
fi
