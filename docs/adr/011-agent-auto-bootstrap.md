# 011: Agent auto-bootstrap

New agent sessions should start with project continuity without being asked,
while staying inside the existing trust, freshness and isolation rules.

## Decision

`ProjectClient.bootstrap()` is a provider-neutral, read-only Core primitive. It
builds a `BootstrapBundle` from persisted state only: memories, handoffs, the
workspace's indexed resources and its sync state. It does not sync, run Doctor,
start Git, call a semantic backend or write. The CLI (`continuity bootstrap`),
the MCP tool (`continuity_bootstrap`) and provider hooks all call this one
primitive; the text form is rendered by one Core function.

The output is an index, not a dump. There is no task at session start, so
selection is deterministic and explainable (`selection_reason`) rather than a
search. Byte budgets use serialized UTF-8 JSON, as context bundles do. Memory
activation, trust precedence and conflict quarantine are unchanged. The
source-backed freshness predicate was extracted from the context broker and is
shared, so there is one freshness rule. Content matching the existing secret
heuristics, which moved from the source adapter to `core/security`, is withheld.

The trusted host resolves a directory to the nearest registered project or
workspace root without registering anything. Providers supply only their
working directory. Provider adapters (`adapter-hooks`) shape hook input and
output and edit a provider's user hook file only on an explicit
`continuity integrate <provider> install|remove`: additive, atomic, backed up and
idempotent, identified by a fixed argument marker.

A read-only MCP tool is added for clients without a startup hook. No memory-by-ID
tool is added: `continuity_context` returns full memories for their key or text,
and `continuity_handoff_latest` returns the full handoff.

## Alternatives

- Reuse `continuity_context` at startup: it refreshes sources and needs a task.
- Inject full records or a semantic search: unbounded, slower, and opaque.
- Generate `CLAUDE.md`/`AGENTS.md` files: writes repositories and goes stale.
- Per-project hook configuration: fragile; one global hook resolves the directory.

## Session end (follow-up)

Claude Code `Stop` hooks can ask the model to continue, which could let an agent
decide on 0–N memory proposals and an optional handoff before finishing.
`SessionEnd` cannot involve the model. Transcript mining is rejected: it would
bypass the conservative memory policy. A model-aware save step is a separate
decision; it is not part of this change.
