# OpenCompanion

**Docs:** full guides at [generatesaas.com/docs/opencompanion](https://generatesaas.com/docs/opencompanion) - install, pairing, policy, audit, updates.

One open-source companion daemon that runs YOUR coding CLIs for any compatible SaaS backend.
Your machine, your CLIs, your rules. OpenCompanion pairs with a backend you choose, then executes the
tasks that backend dispatches using the coding tools already installed and signed in on your
computer (Claude Code, Codex, OpenCode, Hermes). The backend composes work; the daemon runs it
locally, inside limits you set and can see.

OpenCompanion is what lets a SaaS product act on your codebase without ever holding your keys, your
source, or a session on your machine. It uses your own AI subscriptions, confines every run to a
single work folder, and records what it did to a log only it can write.

## Why it is safe to run

- **Local audit before execution, fail-closed.** Every dispatched run is written to a local,
  append-only audit log BEFORE it executes. If the log cannot be written, the run does not run.
  See [docs/audit.md](docs/audit.md).
- **Clamp-only ceilings.** You set a per-backend capability ceiling (permission mode and network).
  A backend can only ever run at or below it, never raise it. See [docs/policy.md](docs/policy.md).
- **Work-folder confinement.** Each backend's runs are pinned to one `work/<product>/` folder.
  The rest of your machine, including OpenCompanion's own data and secrets, is off-limits, and any
  MCP server a backend tries to push is dropped. Enforced by the daemon, not trusted to the backend.
- **Verifiable builds.** Releases are built in the open and published with checksums and provenance
  attestations you can verify before you install. See [docs/verify-provenance.md](docs/verify-provenance.md).

## Install

macOS and Linux:

```sh
curl -fsSL https://github.com/AlexChelan/OpenCompanion/releases/latest/download/install.sh | sh -s -- --url https://your-saas.example/api
```

Windows (PowerShell):

```powershell
$env:OPENCOMPANION_BACKEND_URL='https://your-saas.example/api'; irm https://github.com/AlexChelan/OpenCompanion/releases/latest/download/install.ps1 | iex
```

The installer downloads the daemon for your OS and architecture, verifies it against the release
`SHA256SUMS` (it refuses to install on a mismatch), links the `opencompanion` launcher onto your PATH,
and runs `opencompanion setup`. Prefer to build it yourself? See
[docs/build-from-source.md](docs/build-from-source.md).

The macOS release binaries are code-signed with a Developer ID certificate. The Windows build is
not code-signed yet, so SmartScreen may warn on first run until signing lands; the checksum and
[provenance](docs/verify-provenance.md) verification prove the download either way.

## Quickstart

`setup` does everything below in one step. The individual commands are there when you want them.

```sh
opencompanion setup --url https://your-saas.example/api   # pair + connect CLIs + install the service
opencompanion backends                                    # list paired backends and their ceilings
opencompanion policy show                                 # per-backend ceiling, network, work folder
opencompanion policy set --url https://your-saas.example/api --permission-mode read-only --network off
opencompanion status                                      # pairing + per-CLI connection state
```

- Pairing and multiple backends: [docs/pairing.md](docs/pairing.md)
- Ceilings and confinement: [docs/policy.md](docs/policy.md)
- The audit log: [docs/audit.md](docs/audit.md)
- Building a compatible backend for your own app: [docs/backend-integration.md](docs/backend-integration.md)

## Commands

| Command | What it does |
| --- | --- |
| `setup [--url <backend>]` | Pair, connect your CLIs, and install the always-on service in one step. |
| `pair [--url <backend>]` | Pair with a backend via device authorization. |
| `unpair [--url <backend>]` | Remove a pairing and its stored bearer. |
| `connect [claude-code\|codex\|opencode\|hermes]` | Detect, install, and log in the coding CLIs. |
| `disconnect <tool>` | Stop OpenCompanion driving one CLI (it stays installed and signed in). |
| `status` | Print pairing and per-CLI connection state. |
| `backends` | List paired backends with device id, connected CLIs, ceiling, and daemon state. |
| `log [--url <backend>] [-n <count>] [--json]` | Print this machine's local audit trail. |
| `policy show [--url <backend>]` | Show each backend's ceiling, network, and confined work folder. |
| `policy set --url <backend> [--permission-mode <mode>] [--network <on\|off>]` | Clamp a backend's ceiling. |
| `serve [--url <backend>] [--if-paired]` | Run the daemon in the foreground. |
| `service <install\|uninstall\|status>` | Manage the always-on OS service. |
| `update [--check\|--rollback\|--auto <on\|off>]` | Update now, check, roll back, or toggle auto-updates. |
| `uninstall` | Remove the service, drop pairings, and delete all data. |

## Updates

OpenCompanion updates itself by default. The always-on daemon stages each new release off the hot
path, verifies its `SHA256SUMS` checksum, and applies it only while the daemon is idle, so a run in
flight is never interrupted. Pin to the current version with `opencompanion update --auto off`. For
manual control, `opencompanion update` updates on demand and `opencompanion update --rollback`
reverses the last update.

## Requirements

- macOS, Linux, or Windows.
- A coding CLI you already use and pay for (Claude Code, Codex, OpenCode, or Hermes). OpenCompanion
  drives your own installed tool with your own subscription; it never ships one or holds a key.

## Maintaining this repository

OpenCompanion is released here under the MIT license. This repository is generated from an upstream
monorepo, so fixes and features are reviewed and applied upstream, then re-exported here. Issues and
pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md) for how changes flow back. Security
reports: [SECURITY.md](SECURITY.md).
