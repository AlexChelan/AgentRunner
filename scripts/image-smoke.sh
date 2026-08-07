#!/usr/bin/env bash
# Smoke-tests a locally built AgentRunner image BEFORE anything is pushed to a registry.
#
#   docker build -t ghcr.io/alexchelan/agentrunner:smoke .
#   IMAGE=ghcr.io/alexchelan/agentrunner:smoke scripts/image-smoke.sh
#
# Every container it starts runs under the EXACT hardening docker-compose.yml documents, so a capability
# the daemon quietly started needing fails here rather than on a buyer's first `docker compose up`. It
# asserts the six properties the image exists to provide - boots healthy, survives a refused enrollment
# without a restart loop, keeps the secrets root-0700 and unreadable by the unprivileged `agent`
# identity, puts managed CLIs on the volume, and refuses the two host-install paths - and exits non-zero
# on the first failure. Requires only docker and network egress.
set -euo pipefail

DEFAULT_IMAGE="ghcr.io/alexchelan/agentrunner:smoke"
IMAGE="${IMAGE:-${1:-$DEFAULT_IMAGE}}"

BIN="agentrunner"
# The app-data root the image resolves ($XDG_DATA_HOME=/data plus the daemon's app dir name), and the two
# subdirectories whose PLACEMENT is the point: both must sit on the volume, not in the image layer.
APP_DATA="/data/agentrunner"
SECRETS="/data/agentrunner/secrets"
MANAGED="/data/agentrunner/managed-clis"

# Byte-for-byte the posture docker-compose.yml ships: drop everything, keep only what the daemon needs to
# drop its CLI children to the unprivileged `agent` user inside its own volume, and never gain more.
HARDENED=(--cap-drop ALL --cap-add SETUID --cap-add SETGID --cap-add CHOWN --security-opt no-new-privileges:true)

# Budgets, overridable for a slow runner. The health budget covers the image's own --start-period.
HEALTH_TIMEOUT="${SMOKE_HEALTH_TIMEOUT:-180}"
CRASHLOOP_WINDOW="${SMOKE_CRASHLOOP_WINDOW:-20}"
INSTALL_TIMEOUT="${SMOKE_INSTALL_TIMEOUT:-300}"

MAIN="agentrunner-smoke-$$"
ENROLLED="agentrunner-smoke-enroll-$$"
MAIN_VOL="agentrunner-smoke-data-$$"
ENROLLED_VOL="agentrunner-smoke-enroll-data-$$"

cleanup() {
  docker rm -f "${MAIN}" "${ENROLLED}" >/dev/null 2>&1 || true
  docker volume rm -f "${MAIN_VOL}" "${ENROLLED_VOL}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

step() { printf '\n== %s\n' "$1"; }
ok() { printf 'ok: %s\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }
# One inspect field, empty when the container is gone (so a caller compares rather than crashing).
inspect() { docker inspect -f "$1" "$2" 2>/dev/null || printf ''; }

printf 'Smoke-testing %s\n' "${IMAGE}"

# 1. An unpaired container is a NORMAL state, and the healthcheck must say so: a runner waiting for its
#    enrollment that presents as unhealthy makes every orchestrator restart or drain it forever.
step "the container boots healthy under the hardened flags"
docker run -d --name "${MAIN}" "${HARDENED[@]}" -v "${MAIN_VOL}:/data" "${IMAGE}" >/dev/null
health=""
deadline=$((SECONDS + HEALTH_TIMEOUT))
while [ "${SECONDS}" -lt "${deadline}" ]; do
  health="$(inspect '{{ .State.Health.Status }}' "${MAIN}")"
  if [ "${health}" = "healthy" ]; then break; fi
  if [ "$(inspect '{{ .State.Running }}' "${MAIN}")" != "true" ]; then
    docker logs "${MAIN}" || true
    fail "the container exited before it became healthy"
  fi
  sleep 3
done
if [ "${health}" != "healthy" ]; then
  docker logs "${MAIN}" || true
  fail "the healthcheck never reported healthy within ${HEALTH_TIMEOUT}s (last: ${health:-none})"
fi
ok "unpaired-idle reports healthy"

# 2. THE crash-loop guard. Under `restart: unless-stopped` a daemon that exits on a refused enrollment is
#    not a visible failure - it is a loop that hammers the backend. The container must stay up instead and
#    re-read its pairing state on an interval, so a human can pair it in place against the same volume.
step "a refused enrollment code leaves the container up, with no restart loop"
docker run -d --name "${ENROLLED}" --restart unless-stopped "${HARDENED[@]}" -v "${ENROLLED_VOL}:/data" \
  "${IMAGE}" --url https://127.0.0.1:9/api --enroll not-a-real-enrollment-code >/dev/null
sleep "${CRASHLOOP_WINDOW}"
running="$(inspect '{{ .State.Running }}' "${ENROLLED}")"
restarts="$(inspect '{{ .RestartCount }}' "${ENROLLED}")"
if [ "${running}" != "true" ]; then
  docker logs "${ENROLLED}" || true
  fail "an invalid --enroll took the container down within ${CRASHLOOP_WINDOW}s"
fi
if [ "${restarts}" != "0" ]; then
  docker logs "${ENROLLED}" || true
  fail "an invalid --enroll restarted the container ${restarts} time(s): that is the crash loop"
fi
ok "still running after ${CRASHLOOP_WINDOW}s, RestartCount 0"

# 3-4. The line between a prompt-injected run and the backend bearer + the secret-store master key. The
#      secrets dir is root-owned 0700 while the CLI children run as uid 1000, so the run path cannot read
#      it - but that same identity must still own its HOME on the volume, or every CLI login fails.
step "the secrets live root-owned 0700 on the volume, unreadable by the agent identity"
docker exec "${MAIN}" "${BIN}" status --json >/dev/null
mode="$(docker exec "${MAIN}" stat -c '%u:%g:%a' "${SECRETS}" 2>/dev/null || printf '')"
if [ "${mode}" != "0:0:700" ]; then fail "${SECRETS} is uid:gid:mode ${mode}, expected 0:0:700"; fi
if docker exec -u 1000:1000 "${MAIN}" sh -c "ls -1 ${SECRETS}" >/dev/null 2>&1; then
  fail "uid 1000 could list ${SECRETS}"
fi
docker exec -u 1000:1000 "${MAIN}" sh -c "test -w ${APP_DATA}/home" ||
  fail "uid 1000 cannot write its own HOME at ${APP_DATA}/home"
ok "root-0700 secrets, agent-writable HOME"

# 5. A managed CLI is tens of megabytes: landing it in the image layer means every `docker rm` re-downloads
#    it, and a `docker compose pull` silently discards a working install. It belongs on the volume.
step "a managed CLI install lands on the volume, not in the image layer"
docker exec -d "${MAIN}" sh -c "${BIN} connect claude-code --local </dev/null >/data/connect.log 2>&1"
installed=""
deadline=$((SECONDS + INSTALL_TIMEOUT))
while [ "${SECONDS}" -lt "${deadline}" ]; do
  if docker exec "${MAIN}" test -x "${MANAGED}/clis/claude-code/claude"; then
    installed="yes"
    break
  fi
  sleep 5
done
if [ -z "${installed}" ]; then
  docker exec "${MAIN}" sh -c "cat /data/connect.log" || true
  fail "no managed CLI appeared under ${MANAGED} within ${INSTALL_TIMEOUT}s"
fi
docker exec "${MAIN}" sh -c "test ! -e /root/.local/share/agentrunner && test ! -e /opt/${BIN}/managed-clis" ||
  fail "app data was written outside the /data volume (it would be lost on 'docker rm')"
ok "managed CLI under ${MANAGED}, nothing outside /data"

# 6. Container mode is explicit, and it disables the two paths that make no sense inside an image: the
#    image is the update unit, and the container's restart policy is already the service.
step "container mode refuses the host-install paths"
contained="$(docker exec "${MAIN}" printenv AGENTRUNNER_CONTAINED 2>/dev/null || printf '')"
if [ "${contained}" != "1" ]; then fail "AGENTRUNNER_CONTAINED is '${contained}', expected 1"; fi
# `agentrunner update` must name the image path (a pull) instead of staging a release into a layer
# the next pull discards - on the bare apply AND on the --check that would otherwise reach the network.
for mode in "" "--check"; do
  out="$(docker exec "${MAIN}" sh -c "${BIN} update ${mode} 2>&1" || true)"
  case "${out}" in
    *"docker compose pull"*) ;;
    *) fail "'${BIN} update ${mode}' did not refuse in container mode: ${out}" ;;
  esac
done
# `agentrunner service install` must fail AND leave nothing registered: a unit written inside the
# image would be a second supervisor for a daemon the container already supervises.
if docker exec "${MAIN}" "${BIN}" service install >/dev/null 2>&1; then
  fail "'${BIN} service install' must not succeed inside a container"
fi
if docker exec "${MAIN}" sh -c "ls -1 /root/.config/systemd/user 2>/dev/null | grep -q ."; then
  fail "'${BIN} service install' registered a unit inside the container"
fi
ok "self-update and service install both refused"

printf '\nAll image smoke checks passed for %s\n' "${IMAGE}"
