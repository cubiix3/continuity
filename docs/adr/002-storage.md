# 002 — SQLite, FTS5, and bounded sources

Status: accepted.

Use SQLite through Node's built-in `node:sqlite`, isolated behind a StoragePort.
This avoids a native addon install or external service. The Node API is still
pre-stable (experimental in the minimum tested runtime); the adapter contains
that dependency. See [official Node documentation](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html).

FTS5 provides deterministic offline lexical retrieval without embeddings, API
keys, or a model download. A semantic ranking port is reserved over already scoped
candidate IDs; no vector infrastructure is needed to validate the product flow.

Small allowed text files are stored as bounded index content, alongside paths and
hashes. There is a hard aggregate cap rather than an unbounded repository mirror.
Old resource content is cleared on replacement; historical context snapshots are
separate, explicitly retained local artifacts.

Budget units are UTF-8 bytes for a provider-independent, measurable contract.
Token budgets require a tokenizer-specific layer and are not approximated here.
