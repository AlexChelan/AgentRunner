# Verify a release

Every AgentRunner release publishes, alongside the per-platform `agentrunner-<os>-<arch>.tar.gz`
artifacts, a `SHA256SUMS` file and a build provenance attestation. Verifying both proves the
artifact you downloaded is the exact, unmodified output of this repository's public build, not
something swapped in transit or on the release page.

The installer already verifies the checksum for you and refuses to install on a mismatch. Do the
steps below when you download an artifact by hand, or when you want to confirm provenance yourself.

For everyday use, see the [README](../README.md) and the guides alongside this one.

## Verify the checksum

Download the artifact and `SHA256SUMS` from the release, then check the artifact against its line:

```sh
# macOS
shasum -a 256 -c SHA256SUMS --ignore-missing

# Linux
sha256sum -c SHA256SUMS --ignore-missing
```

A line ending in `OK` means the artifact matches the published checksum. Anything else means the
file is not what was released; do not use it.

## Verify build provenance

The release artifacts are published with a signed provenance attestation that ties them to the
GitHub Actions workflow and commit that built them. Verify it with the GitHub CLI:

```sh
gh attestation verify agentrunner-<os>-<arch>.tar.gz --repo AlexChelan/AgentRunner
```

A successful check confirms the artifact was built by this repository's release workflow from a
specific commit, so a tarball that was tampered with or built elsewhere fails verification even if
someone recomputed its checksum.

## Inspect or build the source

The checksum and the provenance attestation are the verification path: together they prove the
artifact is the unmodified output of this repository's public release build, so you do not need to
rebuild it to trust it.

If you want to read or audit what runs on your machine, the full source is in this repository and
you can build the daemon yourself; see [build-from-source.md](build-from-source.md). A local build
is not yet bit-for-bit identical to the release (the artifact embeds the Node runtime it was built
with), so its checksum will differ unless you match the exact release toolchain. Bit-for-bit
reproducible builds are a roadmap goal; until then, verify a download with the provenance and
checksum steps above rather than by comparing it to a local build.
