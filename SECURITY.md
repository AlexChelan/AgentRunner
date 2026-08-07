# Security policy

AgentRunner runs coding tools on your machine on behalf of a backend, so its security properties are
the whole point. We take reports seriously and want to hear about anything that weakens them.

## Reporting a vulnerability

Please report suspected vulnerabilities privately, not in a public issue. Use GitHub's private
vulnerability reporting on this repository ("Security" tab -> "Report a vulnerability"), which opens a
private advisory with the maintainers.

Include the version or commit, your platform, and enough detail to reproduce. We aim to acknowledge
a report within a few business days and will keep you updated as we investigate and fix.

Please give us a reasonable window to release a fix before disclosing publicly. We are happy to
credit you in the release notes.

## What is in scope

The properties AgentRunner is meant to guarantee, and where a break is most impactful:

- **Confinement.** A run escaping its `work/<product>/` folder, or reaching AgentRunner's own state or
  secrets.
- **Structural flooring.** A dispatched run gaining files, shell, or a backend-pushed MCP server -
  capabilities it is never given, whatever a backend asks for.
- **Fail-closed auditing.** A dispatched run that executes without a durable audit entry, or a way
  for a backend to write, alter, or hide audit entries.
- **Pairing and credentials.** Extraction of the stored session bearer, or pairing with a backend
  the user did not approve.
- **Supply chain.** A path to ship or install an artifact that does not match its published
  checksum and provenance.

## Verifying what you install

Every release ships checksums and a provenance attestation. See
[docs/verify-provenance.md](docs/verify-provenance.md) to confirm an artifact before you trust it,
or [docs/build-from-source.md](docs/build-from-source.md) to build it yourself.
