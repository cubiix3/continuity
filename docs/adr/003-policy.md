# 003 — Source-backed proposals and adapter separation

Status: accepted.

Agents propose; the Core decides. The first write policy accepts only exact
excerpts from current project sources. Unsupported claims need attention, routine
output is rejected, and conflicts on stable keys never overwrite existing claims.
This is intentionally narrower than automatic semantic memory extraction.

Revision history records state changes. Source hashes are rechecked at retrieval;
changed evidence suppresses derived memory. Explicit source text ranks first.

Adapters receive scoped Core operations. They do not import SQLite, change trust,
or implement independent retrieval. CLI/SDK composition roots can initialize and
list local identities; model-facing MCP and HTTP cannot change the selected project.

Consequence: initial memory is curated through project files; a future human
approval workflow must add an explicit authority mechanism rather than a model-
controlled boolean. Arbitrary OS execution remains outside the capability boundary.
