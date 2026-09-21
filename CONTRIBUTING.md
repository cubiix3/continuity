# Contributing

Start with the README and architecture notes. Open an issue for significant public
API or security-boundary changes; focused fixes can go directly to a pull request.

Use Node 24 LTS and pnpm 10.30.1. Run `pnpm install --frozen-lockfile`, then
`pnpm check`. The build precedes tests because integration tests execute the actual
compiled CLI. Test fixtures create isolated temporary directories and databases.

For the Dashboard, run `pnpm build`, `pnpm exec playwright install chromium`, and
`pnpm test:ui`. `pnpm continuity dashboard` serves the built UI; no dev server is
required. Run `pnpm test:pack` to verify a standalone tarball installation.

Keep PRs focused. Explain the behavior before and after, the relevant test evidence,
and any migration implications. New storage versions require a numbered migration;
never edit an already-released migration. Security changes need negative tests.

Use two-space indentation, LF, explicit types at boundaries, and the current lint
configuration. There is no mandatory formatter. Avoid abstractions with no current
consumer and do not add provider assumptions to the Core.

Never include real project contents, tokens, absolute personal paths, database
files, generated binaries, or sensitive logs in tests or issue reports.

Contributions are accepted under Apache-2.0. Participation is covered by the
[Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities privately using
[SECURITY.md](SECURITY.md).
