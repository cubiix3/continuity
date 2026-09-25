# Changelog

## Unreleased (main)

- Automatic-first durable memory: source-backed facts and attributed agent lessons activate automatically with provenance and trust; conflicts are quarantined; human review is optional.
- Local per-project source scope (`continuity sources`) to narrow the source index of large projects without changing project identity.
- Refreshed Dashboard: visual system and information hierarchy, then a denser desktop shell, project-first Overview, automatic-memory filters, handoff-first detail views and a read-only source view.
- New Continuity mark, favicon and brand assets.
- Optional background runtime: Windows current-user sign-in startup, loopback Dashboard and bounded automatic sync that follows the local source scope.
- Agent auto-bootstrap: read-only startup index (`continuity bootstrap`, `continuity_bootstrap` MCP tool) and explicit Claude Code and Codex `SessionStart` hook integrations.
- Provider-aware session autosave: after a turn that edited files, a gated `Stop` hook asks the same model once for 0–3 durable lessons and an optional unfinished-work handoff, applied through the existing memory policy. No transcripts are read. On by default only in attended interactive Claude Code sessions; `CONTINUITY_AUTOSAVE=1|0` overrides it, and `--no-autosave` keeps startup context only.
- Handoff closure: `continuity handoff close` and autosave record that a handoff's work is finished without rewriting it; session start shows the latest open handoff.
- Dashboard Overview no longer runs the full doctor (#16): it uses a cheap project health check that reads Git link files instead of running Git. The full doctor runs Git asynchronously, four workspaces at a time, so the Dashboard stays responsive during Diagnostics. `continuity doctor` output is unchanged. `host.health(projectId)` is new and display-only.
- Host API v2: `host.doctor()` is asynchronous and must be awaited. Doctor findings and output semantics are unchanged. v0.1.0 remains Host API 1.

## 0.1.0 — 2026-09-22

- Local project identity and isolated Git workspaces.
- Structured agent handoffs, durable memory proposals, explicit human review and conflict handling.
- Source provenance, freshness checks and historical context audit.
- Local Dashboard for projects, workspaces, handoffs, memory review, sources and diagnostics.
- CLI, trusted host API, project-bound MCP and non-browser HTTP interfaces.
- Offline SQLite FTS retrieval; optional local semantic backends.
- Claude Code and Codex structured cross-agent flows verified in the documented Windows environments. RIVET remains experimental Draft/Shadow; Grok structured results remain unverified.

No cloud dependency, agent orchestration, telemetry, automatic model download or RIVET cutover. Publication requires a separate release review.
