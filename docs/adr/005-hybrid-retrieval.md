# 005: Optional retrieval over authorized passage snapshots

Accepted for the experimental v0.1 API.

FTS5 remains available without a service, network call, tokenizer, or model. Optional
semantic candidates enter the existing broker; they never establish scope, trust,
memory approval, or source authority. The host binds a project before scanning.
Only its allowed, current passages cross the backend port. Returned IDs must
belong to that snapshot. Source hashes and the live project binding are checked
again after network waits. This is a revalidated snapshot, not a filesystem lock.

Markdown headings and top-level declarations provide passage boundaries. Long
units split at lines, with a 2,400-byte UTF-8 cap for pathological lines. IDs hash
project, path, content, and duplicate occurrence, so edits elsewhere do not force
new embeddings. Paths and line ranges remain in context provenance.

Ollama vectors use normalized cosine similarity and SQLite float32 blobs. Cache
keys include endpoint, model name, model digest, adapter version, and instruction
prefixes. Resource/hash references prevent stale vectors being treated as current.
Completed batches commit independently; interrupted indexing resumes on the next
explicit sync. Search requires a complete current snapshot or falls back to FTS5.
No external vector database is required. Linear scoring is measured before adding
an approximate index.

Hybrid ranking uses reciprocal ranks (constant 60) from FTS5 and semantic search.
An FTS OR hit covering fewer than half the distinct meaningful query terms gets no
lexical fusion vote; a small English function-word list is ignored for this gate.
This prevents weak generic overlaps receiving two votes over a good paraphrase.
Lexical-only ranking is unchanged by that gate, and exact matches remain protected.
Current project rules sort first, then exact symbols/paths, then fused ranks.
Passage term coverage and path/line order break ties. Source-backed and reviewed
memories and the relevant latest handoff follow sources. Similarity is not trust.
The full compact JSON byte budget remains the hard limit; token estimates remain
advisory. Explanations expose observed signals, not a confidence percentage.

The OpenViking adapter uses verified 0.4.20 APIs: vectors-only content writes and
`find` with exact authorized leaf URIs. That implementation passes URI scope
predicates into vector retrieval. Backend text and trust are never imported into
bundles; local passages remain authoritative. An operator-managed index revision
is mandatory because the public health API does not expose a model digest.

`ProjectClient.context`, `search`, and `sync` now return promises. This is a
necessary pre-stable SDK change for asynchronous optional services. CLI, HTTP and
MCP callers await the same Core implementation. No parallel synchronous broker is
maintained. Memory proposals/review and handoff operations remain synchronous.

Configuration is a small, strict `retrieval.json` in the private Continuity home,
never automatically loaded from a repository. Only literal loopback HTTP origins
are supported. Redirects are rejected, responses bounded, query calls time out
after three seconds and sync after thirty. No retries, downloads or installations
occur in normal commands. Explicit performance tests may resume bounded syncs.
