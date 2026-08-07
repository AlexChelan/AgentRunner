# AgentRunner

**Docs:** full guides at [generatesaas.com/docs/agentrunner](https://generatesaas.com/docs/agentrunner) - install, pairing, confinement, audit, updates.

One open-source runner daemon that runs YOUR coding CLIs for any compatible SaaS backend.
Your machine, your CLIs, your rules. AgentRunner pairs with a backend you choose, then executes the
tasks that backend dispatches using the coding tools already installed and signed in on your
computer (Claude Code and Codex). The backend composes work; the daemon runs it locally, inside
limits you set and can see. A dispatched Codex run is REFUSED where its sandbox is not enforced by
the operating system, so an unconfined run is not something a backend can ask for.

AgentRunner is what lets a SaaS product act on your codebase without ever holding your keys, your
source, or a session on your machine. It uses your own AI subscriptions, confines every run to a
single work folder, and records what it did to a log only it can write.

## Why it is safe to run

- **Local audit before execution, fail-closed.** Every dispatched run is written to a local,
  append-only audit log BEFORE it executes. If the log cannot be written, the run does not run.
  See [docs/audit.md](docs/audit.md).
- **A dispatched run is floored structurally.** No files, no shell, no local MCP servers - whatever a
  backend asks for. You do not configure this and a backend cannot raise it. A run that asks for egress
  gets it, so the CLI keeps its own web tools; one that asks for nothing stays off the network.
- **You can refuse a whole class of work.** `agentrunner origin` decides whether this machine
  accepts scheduled or app-dispatched runs at all, per backend. See [docs/confinement.md](docs/confinement.md).
- **Work-folder confinement.** Each backend's runs are pinned to one `work/<product>/` folder.
  The rest of your machine, including AgentRunner's own data and secrets, is off-limits, and any
  MCP server a backend tries to push is dropped. Enforced by the daemon, not trusted to the backend.
- **Verifiable builds.** Releases are built in the open and published with checksums and provenance
  attestations you can verify before you install. See [docs/verify-provenance.md](docs/verify-provenance.md).

## Install

Docker - one container, one volume, no access to your host disk or credentials:

```sh
docker run -d --name agentrunner --restart unless-stopped \
  --cap-drop ALL --cap-add SETUID --cap-add SETGID --cap-add CHOWN \
  --security-opt no-new-privileges:true \
  -v agentrunner-data:/data \
  ghcr.io/alexchelan/agentrunner:latest \
  --url https://your-saas.example/api --enroll <one-time-code>
```

The one-time enrollment code comes from your app's "Add runner" dialog, so the container pairs itself on
first boot. [`docker-compose.yml`](docker-compose.yml) is the same container as a file to keep; upgrade
with `docker compose pull && docker compose up -d`. Everything the daemon stores - pairings, secrets,
managed CLIs, work folders - lives on the `/data` volume, so the container itself is disposable.

Binary - macOS and Linux:

```sh
curl -fsSL https://github.com/AlexChelan/AgentRunner/releases/latest/download/install.sh | sh -s -- --url https://your-saas.example/api
```

Binary - Windows (PowerShell):

```powershell
$env:AGENTRUNNER_BACKEND_URL='https://your-saas.example/api'; irm https://github.com/AlexChelan/AgentRunner/releases/latest/download/install.ps1 | iex
```

The installer downloads the daemon for your OS and architecture, verifies it against the release
`SHA256SUMS` (it refuses to install on a mismatch), links the `agentrunner` launcher onto your PATH,
and runs `agentrunner setup`. Prefer to build it yourself? See
[docs/build-from-source.md](docs/build-from-source.md).

The macOS release binaries are code-signed with a Developer ID certificate. The Windows build is
not code-signed yet, so SmartScreen may warn on first run until signing lands; the checksum and
[provenance](docs/verify-provenance.md) verification prove the download either way.

## Quickstart

`setup` does everything below in one step. The individual commands are there when you want them.

```sh
agentrunner setup --url https://your-saas.example/api   # pair + connect CLIs + install the service
agentrunner backends                                    # list paired backends and their state
agentrunner origin show                                 # does this machine accept scheduled / dispatched work
agentrunner origin set --url https://your-saas.example/api --schedule deny --dispatch deny
agentrunner status                                      # pairing + per-CLI connection state
```

- Pairing and multiple backends: [docs/pairing.md](docs/pairing.md)
- Confinement and what a backend can ask for: [docs/confinement.md](docs/confinement.md)
- The audit log: [docs/audit.md](docs/audit.md)
- Building a compatible backend for your own app: [docs/backend-integration.md](docs/backend-integration.md)

## Commands

| Command | What it does |
| --- | --- |
| `setup [--url <backend>]` | Pair, connect your CLIs, and install the always-on service in one step. |
| `pair [--url <backend>]` | Pair with a backend via device authorization. |
| `unpair [--url <backend>]` | Remove a pairing and its stored bearer. |
| `connect [claude-code\|codex]` | Detect, install, and log in the coding CLIs. |
| `disconnect <tool>` | Stop AgentRunner driving one CLI (it stays installed and signed in). |
| `status` | Print pairing and per-CLI connection state. |
| `backends` | List paired backends with device id, connected CLIs, and daemon state. |
| `log [--url <backend>] [-n <count>] [--json]` | Print this machine's local audit trail. |
| `origin [show] [--url <backend>]` | Show whether this machine accepts scheduled and app-dispatched work. |
| `origin set --url <backend> [--schedule <allow\|deny>] [--dispatch <allow\|deny>]` | Refuse a class of work here. |
| `serve [--url <backend>] [--if-paired]` | Run the daemon in the foreground. |
| `service <install\|uninstall\|status>` | Manage the always-on OS service. |
| `update [--check\|--rollback\|--auto <on\|off>]` | Update now, check, roll back, or toggle auto-updates. |
| `uninstall` | Remove the service, drop pairings, and delete all data. |

## Updates

AgentRunner updates itself by default. The always-on daemon stages each new release off the hot
path, verifies its `SHA256SUMS` checksum, and applies it only while the daemon is idle, so a run in
flight is never interrupted. Pin to the current version with `agentrunner update --auto off`. For
manual control, `agentrunner update` updates on demand and `agentrunner update --rollback`
reverses the last update.

## Requirements

- macOS, Linux, or Windows.
- A coding CLI you already use and pay for (Claude Code or Codex). AgentRunner drives your own
  installed tool with your own subscription; it never ships one or holds a key.

## Maintaining this repository

AgentRunner is released here under the MIT license. This repository is generated from an upstream
monorepo, so fixes and features are reviewed and applied upstream, then re-exported here. Issues and
pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md) for how changes flow back. Security
reports: [SECURITY.md](SECURITY.md).
