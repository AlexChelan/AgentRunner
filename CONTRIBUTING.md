# Contributing

Thanks for your interest in OpenCompanion. Issues and pull requests are welcome.

## How this repository is maintained

OpenCompanion is developed inside an upstream monorepo and exported here. This repository is the
canonical open-source source you build and run, but changes are integrated upstream and re-exported,
rather than committed here in isolation. In practice:

- **Issues** are triaged here. A clear bug report or feature request is the most useful thing you
  can file.
- **Pull requests** are reviewed here. When a change is accepted, it is applied to the upstream
  monorepo and flows back into this repository on the next export, with your authorship preserved.

So a PR may be merged by way of upstream rather than by a direct merge button; the outcome is the
same and the discussion stays on your PR.

## Local development

See [docs/build-from-source.md](docs/build-from-source.md) for the pinned toolchain and build steps.
The short version:

```sh
pnpm install
pnpm --filter opencompanion standalone   # build the self-contained daemon
pnpm check-types
pnpm test
```

## Guidelines

- Keep changes small and reversible, and match the style of the surrounding code.
- TypeScript is strict; avoid `any` and unsafe casts.
- Add or update tests for any behavior you change, and make sure `pnpm test` and `pnpm check-types`
  pass before you open a PR.
- Do not use em dashes or en dashes in code or prose; use a spaced hyphen or restructure the
  sentence.

## Security

Do not open a public issue for a vulnerability. Follow [SECURITY.md](SECURITY.md) to report it
privately.
