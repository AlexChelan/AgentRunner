# The AgentRunner daemon as a container, published as ghcr.io/alexchelan/agentrunner. One named volume at /data
# holds everything (state, secrets, managed CLIs, work folders, CLI credential homes), so the container
# itself is disposable: `docker rm` costs nothing, and the image is the update unit (`docker compose pull`).
#
#   docker build -t ghcr.io/alexchelan/agentrunner:dev .
#   docker run -d --name agentrunner --restart unless-stopped \
#     --cap-drop ALL --cap-add SETUID --cap-add SETGID --cap-add CHOWN \
#     --security-opt no-new-privileges:true -v agentrunner-data:/data \
#     ghcr.io/alexchelan/agentrunner:latest --url https://your-saas.example/api --enroll <one-time-code>
#
# The build context is this repo root and must already hold the standalone payload
# (`pnpm --filter agentrunner standalone`, one folder per target under daemon/dist-standalone/).
# Nothing is compiled here: the image ships the exact bundle the release tarballs ship.

# Stage 1 picks the payload for the target platform. `TARGETARCH` is set by buildx (amd64/arm64) and
# falls back to the build host's own architecture for a plain `docker build`; the standalone folder
# names it the Node way (x64/arm64), so the two are mapped rather than assumed equal.
ARG DIST_DIR=daemon/dist-standalone
FROM node:22-slim AS payload
ARG DIST_DIR
ARG TARGETARCH
COPY ${DIST_DIR}/ /payload/
RUN set -eu; \
    arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    case "${arch}" in amd64) node_arch=x64 ;; arm64) node_arch=arm64 ;; *) echo "unsupported architecture: ${arch}" >&2; exit 1 ;; esac; \
    src="/payload/agentrunner-linux-${node_arch}"; \
    test -x "${src}/agentrunner" || { echo "no standalone payload at ${src} - run 'pnpm --filter agentrunner standalone' first" >&2; exit 1; }; \
    mv "${src}" /opt/agentrunner

FROM node:22-slim

# git: the coding CLIs' VCS work. curl + ca-certificates: HTTPS to the backend and the npm registry.
# util-linux: `script(1)`, the PTY the login relay drives (no native node-pty in any bundle).
# tini: a real PID 1 that reaps the CLI children the daemon spawns.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git curl ca-certificates util-linux tini \
    && rm -rf /var/lib/apt/lists/*

# The unprivileged user Codex RUN children drop to (a login child stays the daemon, so the credential it
# writes is one the daemon can read back and hand on). uid/gid 1000 is a CONTRACT with the daemon
# (AGENT_UID/AGENT_GID in daemon/src/container.ts): a mismatch is silent and costly - the run path ends up
# unable to read the credential. The node base image already owns 1000 for its own `node` user, so that
# one is removed first.
RUN userdel -r node 2>/dev/null || true; \
    groupdel node 2>/dev/null || true; \
    groupadd -g 1000 agent \
    && useradd -u 1000 -g 1000 -m -d /home/agent -s /bin/sh agent

COPY --from=payload /opt/agentrunner /opt/agentrunner
COPY entrypoint.sh /entrypoint.sh
RUN chmod 0755 /entrypoint.sh && ln -s /opt/agentrunner/agentrunner /usr/local/bin/agentrunner

# Container mode is EXPLICIT, never guessed from /.dockerenv: it disables the self-updater, refuses
# `service install` (the restart policy is the service), and switches the sandbox rules to uid separation.
ENV AGENTRUNNER_CONTAINED=1
# The daemon resolves its app-data root the XDG way (`$XDG_DATA_HOME/agentrunner`), so pointing
# XDG at the volume is what puts the pairing, the secrets, the managed CLIs and the CLI homes on /data.
# Without this the daemon would write under /root and every `docker rm` would lose the pairing.
ENV XDG_DATA_HOME=/data
# The daemon's OWN `HOME`, pinned to the SAME directory the entrypoint creates and chowns to `0:1000`
# and the daemon hands its CLI children - `<app-data root>/home`. It is not cosmetic: the daemon resolves a
# CLI's login source through `homedir()` (Codex's `~/.codex/auth.json`, the Claude SDK's `~/.claude`),
# so a daemon left on /root seeds a run from an EMPTY home while the login wrote to the volume, and
# every contained run reports unauthenticated. Login-write path == daemon HOME == run-read path.
ENV HOME=/data/agentrunner/home
# The install root, for the (container-refused) updater's path resolution: the image IS the install.
ENV AGENTRUNNER_HOME=/opt/agentrunner
VOLUME /data

LABEL org.opencontainers.image.title="AgentRunner" \
      org.opencontainers.image.source="https://github.com/AlexChelan/AgentRunner"

# Unpaired-idle is HEALTHY: a container waiting for its enrollment must not present as broken.
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s CMD agentrunner status --json || exit 1

# The node base image ships `CMD ["node"]`; inheriting it would append `node` to the serve command.
CMD []
ENTRYPOINT ["tini", "--", "/entrypoint.sh"]
