# Architecture

Optional semantic adapters now feed the same broker through authorized passage
snapshots. See [ADR 005](adr/005-hybrid-retrieval.md) for fusion, model revision keys,
incremental cache writes, and post-await freshness checks. SDK `sync`, `search`, and
`context` calls are asynchronous; callers must await them. Byte budgets still cover
the complete compact JSON context bundle. Selection audit records remain local.

Continuity's unit of access is a `ProjectClient`, created by a trusted host from a
canonical directory registration. It exposes operations, not a namespace selector.
Agent adapters receive a narrower `AgentAdapter` contract with seven operations.

| Module | Responsibility |
| --- | --- |
| `core` | Contracts, project resolver, namespace guard, context broker, memory policy, handoff service |
| `storage-sqlite` | Versioned schema, atomic persistence, revisions, FTS5 candidate search |
| `source-files` | Bounded filesystem scan, gitignore, exclusions, hashes |
| `sdk` | Trusted composition of Core and storage/source adapters |
| `cli` | Local user commands and service startup |
| `adapter-generic` | Small programmatic agent contract |
| `adapter-mcp` | Seven stdio MCP tools |
| `adapter-claude` | Claude Code SessionStart hook output and explicit settings install/remove |
| `server` | Local HTTP v1 transport |

These are private pnpm workspace modules compiled together by one TypeScript
configuration. They are not independently published packages. Relative module
imports keep the initial distribution straightforward; there is one build and one
set of contracts. The Core never imports SQLite or provider SDKs.

## Identity and namespaces

`projects` stores a UUID, display name, identity version, and canonical root in the
private local database. The repository contains no identity file. `init` is
idempotent for a canonical path; parent resolution chooses the nearest registered
root. Clones and worktrees at different paths have separate identities. Relocation
is not automatically inferred from remote URLs or directory names.

Only `project:<id>` namespaces are enabled. Sessions and handoffs carry the owning
project ID; they do not grant an additional cross-project read capability. Global
and shared namespaces are deliberately absent. The local CLI can list registered
projects; the agent-facing HTTP endpoint lists only its bound project.

## Sync and retrieval

The source adapter scans allowed text/code files under hard limits: 64 KiB per
file, 2,000 indexed files, 8 MiB content, and 20,000 visited directory entries.
Large files are skipped; exceeding aggregate limits aborts sync without replacing
the last index. Nested `.gitignore` files apply conservatively. Parent exclusions
cannot be undone by a child ignore file.

Sync scans first, then updates resources and FTS5 atomically. An unchanged hash
keeps the resource ID and provenance. Changed versions become `superseded`, absent
or excluded versions become `missing`; old indexed content is cleared. `stale` is
reserved in the data model for an observed mismatch awaiting refresh. Current
synchronous refresh replaces it directly, so no stale candidate is returned.

Every search, context request, and memory proposal refreshes the project first.
This trades throughput for freshness in the first release; there is no watcher or
performance claim. File SHA-256 is the version reference, including uncommitted
changes. Git remains responsible for durable source history.

The broker ranks project rules before FTS5 matches, then relevant source-backed
memories. Ties use path and ID. Deduplication is by exact selected text. After the
rules, memories whose text matches at least half of the meaningful task terms may
use up to 25% of the budget before lower-ranked passages, in trust order; see the
[memory model](memory-model.md#context-and-trust). Large
sources contribute a bounded excerpt around the first matching line; explanations
mark the excerpt. Roles are validated and recorded; v0.1 has no role-specific
ranking rules and does not pretend otherwise.

Budgets measure compact JSON in UTF-8 bytes, including provenance and metadata.
Items are admitted whole or skipped; requested budgets range from 512 to 32,000.
Search separately returns at most ten excerpts and at most 16,000 serialized
bytes. MCP adds transport framing outside the Core's bundle budget.

## Persistence

SQLite uses WAL, foreign keys, a busy timeout, and transactional numbered
migrations via `user_version`. Future schema versions are refused. Tables cover
projects, namespaces, resources, memories, memory revisions, handoffs, sessions,
observations, sync state, provenance, and historical context bundles. The
observation ingestion is available through the generic adapter and MCP, without
automatic memory promotion. Schema v2 adds audited rebindings and timestamps for
context/session retention previews; v1 data migrates transactionally.

Memory policy decisions run inside a write transaction so concurrent local
processes cannot bypass conflict checks. Handoffs and their session/provenance
records are written atomically. The default database is
`~/.continuity/continuity.db`; `CONTINUITY_HOME` and `--home` support isolated stores.

`SemanticRetrievalPort` reserves optional ranking over already scoped candidates.
No vector storage, network service, embeddings, or OpenViking dependency exists.

An optional host-supplied `TokenEstimator` reports estimated tokens for the selected
items, with an optional `provider_model_hint`. There is no tokenizer dependency.
Estimates are advisory; their metadata is counted inside the unchanged hard byte
budget. Invalid estimates fail the request rather than weaken the byte limit.
See [operations](operations.md) for trusted review/rebind capabilities, which are
not passed to agents, and [the measured retrieval baseline](retrieval-baseline.md).
