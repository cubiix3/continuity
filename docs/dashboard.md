# Continuity Dashboard

Build/install the CLI as described in the README, then:

```sh
continuity init
continuity sync
continuity dashboard
```

Open **http://127.0.0.1:4783**. Use `--port` for a different local port, or `--port 0`
for an available port. `--home` / `CONTINUITY_HOME` select the same state directory
as the CLI. An empty installation can launch the Dashboard before registration.
Stop with Ctrl+C. There is no automatic browser launch, login, telemetry or cloud request.

## Inspect and review

- **Overview:** actual indexed-source, project-memory, pending-review and workspace-handoff counts.
- **Projects / Workspaces:** registered identities and canonical roots. Memory is project-wide; sources, handoffs and context audit are workspace-scoped. Sync uses the existing source and optional semantic pipeline.
- **Handoffs:** newest-first structured state, agent/session, completed work, remaining work, decisions, risks and next action. No transcripts.
- **Memories:** bounded status-filtered pages, policy reason, provenance and revision history. Approve/reject requires an explicit reviewer name and confirmation. Conflicts remain blocked by the existing policy. Forget/rebind/prune stay in the CLI.
- **Sources:** last-indexed metadata; opening a preview revalidates current source through the existing scanner. Removed, excluded or inaccessible files are not served as current. Source content is text, never Dashboard instructions.
- **Context Audit:** historical full bundles and bounded selection audits. The current contract does not retain the original task, so the UI says so rather than inventing it. PR #7 compact delivery is not required.
- **Diagnostics:** the same storage, runtime and registration checks as `doctor`. Disabled semantic retrieval is a healthy FTS-only configuration.

Activity, Settings and interactive search are deferred; CLI/API search remains available.
No source editor or filesystem browser is provided.

## Browser boundary

The Dashboard is a trusted **human installation-wide** client. It can navigate registered
projects; this does not change the project-bound agent API. It serves its assets and
`/dashboard-api/*` from the same loopback process. `serve` remains a separate non-browser
API and continues to reject Origin headers.

Exact Host and Origin checks, rejected cross-site fetches, a per-process random capability
and custom headers protect browser data and writes. The capability remains in JavaScript
memory, not URLs or localStorage. Reload after a server restart. All writes are explicit
same-origin JSON POSTs. There is no CORS wildcard. CSP disallows remote scripts, framing,
inline scripts and eval. All dynamic source/memory/handoff values render as text nodes.

Trusted local processes and browser extensions are outside this browser-origin boundary.
The Dashboard does not read agent credentials or environment secrets; existing local
records may contain user-provided sensitive text. Source secret exclusion is heuristic,
as documented in the security model. Do not expose the server through a proxy or tunnel.

## Inspection API

This is a dedicated host/browser surface, not an MCP extension. Core's optional
`InspectionStoragePort` supplies bounded records from existing tables without changing
the agent `StoragePort` contract or database schema.

`GET /dashboard-api/session` requires `X-Continuity-Dashboard: 1`. Its capability is
required as `X-Continuity-Token` for data routes: `projects`, `workspaces`, `status`,
`stats`, `records`, `selection`, `diagnostics`, `retrieval`. Record lists accept a
registered project/workspace, a fixed collection kind, `limit` (1–50), and `after`
cursor. Memory status filtering happens before pagination. IDs are never authorization.
Only `/review` and `/sync` support POST; no GET mutates memory or initiates sync.
Source preview and retrieval-health checks refresh through existing freshness logic.

## Development and visual checks

The UI is TypeScript + local CSS, compiled with the existing build. No frontend
runtime, second bundler, CDN, fonts or template engine is required. System sans and
monospace fonts, muted green, thin borders and compact tables form the design system.
Light/dark follows the OS. Desktop and tablet widths are exercised in Chromium.

Run `pnpm check`, `pnpm test:ui`, and `pnpm test:pack` after building. Browser tests
use separate temporary projects and real host APIs. The README screenshot is produced
by the browser test with `CONTINUITY_SCREENSHOT=1`; its project is explicitly a demo.
The browser setup follows the [Playwright CI documentation](https://playwright.dev/docs/ci).
