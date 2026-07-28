# Build from source

You do not need the prebuilt release to run OpenCompanion. This repository is the full source; you can
build and run the self-contained daemon yourself, and read exactly what it does before you do.

For everyday use, see the [README](../README.md) and the guides alongside this one.

## Toolchain

Pin these tools for a clean build:

- Node.js `>=22` (the build vendors your current Node into the artifact).
- pnpm, managed by Corepack from the `packageManager` field: `pnpm@11.1.2`.

```sh
corepack enable
corepack prepare pnpm@11.1.2 --activate
node --version   # confirm it satisfies >=22
```

## Build the daemon

```sh
git clone https://github.com/AlexChelan/OpenCompanion.git
cd opencompanion
pnpm install
pnpm --filter opencompanion standalone
```

The `standalone` step produces the same self-contained payload the release ships, under:

```
daemon/dist-standalone/opencompanion-<os>-<arch>/
  node[.exe]        the vendored Node runtime
  daemon/           the bundled daemon (an esbuild bundle + the Claude Agent SDK JS only)
  opencompanion[.cmd]    the launcher
```

Run it straight from there:

```sh
daemon/dist-standalone/opencompanion-<os>-<arch>/opencompanion setup --url https://your-saas.example/api
```

The build inlines all third-party JavaScript except the agentic SDKs, and it drives the coding CLI
you already have installed rather than shipping one, so nothing else is downloaded at run time.

## Type-check and test

```sh
pnpm check-types
pnpm test
```

## Cross-build for another platform

By default the build vendors the current machine's Node and names the artifact for this OS and
architecture. To build for a different target, point it at an official Node binary you downloaded
for that target and name the target explicitly:

```sh
OPENCOMPANION_VENDOR_NODE=/path/to/target/node \
OPENCOMPANION_TARGET_OS=linux \
OPENCOMPANION_TARGET_ARCH=arm64 \
pnpm --filter opencompanion standalone
```

## Reproducibility

A local build is not yet bit-for-bit identical to the published release. The standalone artifact
embeds the Node runtime it was built with, so its checksum will differ from the release unless you
build with the exact same Node build and toolchain. Bit-for-bit reproducible builds are a roadmap
goal.

Until then, to confirm a downloaded release is authentic, verify its checksum and build provenance
rather than comparing it to a local build; see [verify-provenance.md](verify-provenance.md).
Building from source is the way to read and audit what runs on your machine.
