#!/bin/sh
# PID-1 payload for the AgentRunner image (tini execs this, this execs the daemon).
#
# Its ONE job before serving: create the HOME the daemon points CLI children at, on the volume, at
# RUNTIME. It cannot be done at image build time - the /data volume is mounted over whatever the image
# has there, so a build-time mkdir simply disappears and every contained CLI login fails with a bare
# ENOENT. The app-data root itself is created here too (mode 0755) so the unprivileged `agent` user can
# traverse into its home; the daemon then creates `secrets/` under it as root-0700, which is the line
# that keeps a prompt-injected run away from the bearer and the master key.
#
# Every argument is forwarded to `serve`, so `docker run <image> --url <backend> --enroll <code>` works
# and a compose file can pass the same values as AGENTRUNNER_BACKEND_URL / AGENTRUNNER_ENROLL.
set -eu

# Mirrors the daemon's own resolution: $XDG_DATA_HOME (baked to /data in the image) + the app dir name.
APP_DATA="${XDG_DATA_HOME:-/data}/agentrunner"

mkdir -p "${APP_DATA}/home"
# Shared between BOTH identities that use it, because they are not the same one. Codex RUN children drop
# to uid 1000 (`agent`), but the Claude Agent-SDK child and every CLI LOGIN run as the daemon ROOT - and
# root here has no CAP_DAC_OVERRIDE (the image is run --cap-drop ALL), so an `agent`-OWNED home
# would be one the root children could neither read nor write. So: root owns it, `agent` is the group,
# and 2770 gives both full access while giving other users none. The setgid bit is the point of the 2:
# it makes a directory either side creates inherit the `agent` group instead of landing in a group only
# its author is in.
#
# ORDER IS LOAD-BEARING. `chmod` runs FIRST, while the group is still root's own: without CAP_FSETID
# (also dropped) the kernel SILENTLY strips setgid when the target group is not one the caller is in,
# and chmod still exits 0 - so doing it after the chown would look right and quietly leave 0770. A
# directory's setgid bit survives a later chown on Linux, so this order keeps it.
chmod 2770 "${APP_DATA}/home"
chown 0:1000 "${APP_DATA}/home"

# The DAEMON's own HOME, DERIVED from the same app-data root rather than assumed - the image bakes the
# identical value as `ENV HOME`, and this keeps the two in step even when $XDG_DATA_HOME is overridden.
# It has to match: the daemon resolves a CLI's login source through `homedir()` (Codex's `~/.codex`, the
# Claude SDK's `~/.claude`), and a daemon left on /root would seed a run from an EMPTY home while the
# login child wrote its credential here.
export HOME="${APP_DATA}/home"

exec agentrunner serve "$@"
