# Retrieval

Continuity works offline with SQLite FTS5 by default. Optional local services can
improve natural-language matching. Project isolation, provenance, memory policy,
and byte budgets remain in Continuity.

## Enable Ollama explicitly

Use an existing Ollama installation and explicitly obtain your chosen embedding
model using Ollama's own tooling. Continuity never installs services or downloads
models. The tested setup is Ollama 0.34.2, `nomic-embed-text:latest`, 768 dimensions.

Create `retrieval.json` in the same private state directory that `--home` selects
(default `~/.continuity`):

```json
{
  "mode": "hybrid",
  "semantic": {
    "enabled": true,
    "provider": "ollama",
    "endpoint": "http://127.0.0.1:11434",
    "model": "nomic-embed-text"
  }
}
```

Run `continuity sync`, then `continuity doctor`. For large projects, a sync may
reach its 30-second deadline; completed batches survive. Run sync explicitly again
to complete the index. Context/search never launch a full embedding job. An
incomplete index, absent model, invalid response, unavailable service or query
timeout falls back to current lexical retrieval.

```sh
continuity search "restore dropped transport" --mode lexical
continuity search "restore dropped transport" --mode semantic
continuity search "restore dropped transport" --mode hybrid
continuity context "recoverConnection" --mode hybrid
continuity explain <context-id>
continuity explain <context-id> --verbose
```

With no semantic configuration, the default is lexical. An enabled adapter defaults
to hybrid, with failure status recorded in the bundle. Returned search entries also
carry retrieval status. No matching entries means an empty search result; use
doctor for backend status. `--mode lexical` never contacts a semantic service.
Both backends use a 0.5 similarity cutoff; score calibration differs by backend.
Verbose explanations show up to 500 ranked candidate decisions, including duplicates
and items excluded by the byte budget. This local audit is stored separately from
the budgeted bundle. It does not explain documents that never became candidates.

Nomic documents and queries use its documented `search_document:` and
`search_query:` prefixes. Other models default to empty prefixes; optional
`document_prefix` and `query_prefix` fields support their documented requirements.
Changing the model digest or prefixes requires reindexing; incompatible vectors
are never mixed. No provider SDK or tokenizer is a Core dependency.

## OpenViking

The adapter is tested against an already-running local OpenViking **0.4.20** dev
server. Other versions and authenticated deployment modes are not verified. It
does not launch or configure that server. Example private configuration:

```json
{
  "semantic": {
    "enabled": true,
    "provider": "openviking",
    "endpoint": "http://127.0.0.1:1933",
    "revision": "my-embedding-index-v1"
  }
}
```

Use a new revision when changing the server's embedding model or index settings.
OpenViking health does not provide a model fingerprint; Continuity cannot detect an
operator changing that model under the same revision. The adapter rejects untested
server versions. Writes use `vectors_only`: no VLM summaries or session-based query
rewriting. Search uses `find`, never unconstrained `search` or global default scope.

Only currently authorized leaf URIs are sent as search targets. Removed or newly
excluded sources cannot be retrieved through Continuity. OpenViking retains older
remote resource versions; its storage must be maintained separately. Local
manifest health does not prove every remote vector is still present. These are
explicit limitations, not parity claims with the SQLite embedding cache.

Ensure the existing server's embedding configuration also stays local. A loopback
HTTP address alone does not prove what a separately managed service does internally.
Continuity sends no telemetry and supports no remote endpoint in this release.

## Evidence and limitations

The original [eight-case baseline](retrieval-baseline.md) is retained unchanged.
The [comparative evaluation](retrieval-evaluation.md) reports all 25 fixed cases,
including contradictory documents and false positives. Reproduce using:

```sh
pnpm build
node scripts/retrieval-evaluation.mjs --backend=none
node scripts/retrieval-evaluation.mjs --backend=ollama --write
node scripts/retrieval-evaluation.mjs --backend=openviking --write
node scripts/retrieval-performance.mjs --backend=ollama --write
```

Live backends are opt-in; CI uses bounded local HTTP fixtures and tests packaging
without them. Fixtures do not constitute a representative benchmark of all code
bases. No semantic contradiction detector or LLM reranker is used.

## API references

- [Ollama embedding HTTP API](https://docs.ollama.com/api/embed)
- [Nomic model instruction prefixes](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5)
- [OpenViking 0.4.20 content API source](https://github.com/volcengine/OpenViking/blob/v0.4.20/openviking/server/routers/content.py)
- [OpenViking retrieval scope before vector search](https://github.com/volcengine/OpenViking/blob/v0.4.20/openviking/storage/viking_vector_index_backend.py)
