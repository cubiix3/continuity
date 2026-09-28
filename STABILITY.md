# Stability boundaries

This describes current `main`, which is not a v0.2 release. The latest published package is v0.1.0. Passing CI describes the tested code; it is not a compatibility or support promise for a future release.

## Current contracts

- Git and current project files remain the source of truth. The trusted host binds a request to one registered project and, where applicable, one registered worktree. Continuity does not search other projects on an agent's request.
- Core policy governs memory, handoffs, retrieval and context selection for the CLI, host API, MCP, HTTP and Dashboard. File-source selection and indexing apply canonical paths, symlink and secret exclusions. Source retrieval preserves provenance and freshness.
- SQLite migrations move forward transactionally. Continuity does not automatically reset a failed or corrupt database, repair an inaccessible workspace, or reverse a migration. Back up the complete home before upgrading; see [UPGRADING.md](UPGRADING.md).
- Lexical FTS works without a semantic service. Semantic retrieval is optional and must fall back to lexical operation when its backend fails.
- The background runtime is optional. The CLI works without it. Its Dashboard and control endpoints stay local; it is not a process supervisor.

## Tested platforms and setup limits

CI runs the build, types, tests, lint, UI and installed-package smoke tests on Windows and Linux. That does not establish behavior on other platforms or every provider version. Node.js 24.13 or newer on the Node 24 line is required.

Windows workspace verification uses a registered Git for Windows installation. A Git executable found only through `PATH` is insufficient. Windows sign-in startup requires build 17763 or newer, runs in the current user's session without elevation, and needs a stable Node and CLI installation path. Automated task tests are not a real sign-out/sign-in acceptance test; that acceptance was waived for current `main`.

Claude Code and Codex integrations install generated hooks with absolute Node, CLI and home paths. `integrate ... status` reports stale or partial installs; current `main` does not repair them automatically after a package or Node move. `integrate ... install` repairs the named integration. Windows startup likewise needs `startup install` after those paths change.

The package and its interfaces are still pre-1.0. This document records present behavior, not a commitment to keep every CLI flag, JSON shape, hook format or internal TypeScript API unchanged. [ADR 019](docs/adr/019-v02-non-goals.md) records the scope we are keeping out of v0.2.
