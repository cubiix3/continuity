# Retrieval evaluation

This extends the unchanged [eight-case baseline](retrieval-baseline.md) to 25 fixed
synthetic cases: 22 positive queries and three expected-empty queries. The corpus
includes exact symbols/paths, rules, paraphrases, contradictions, stale/deleted
sources, code, reviewed memory, handoffs, large noise and a cross-project canary.
Each case has its own project plus six fixed background documents about logging,
testing, caching, scheduling, releases and formatting. Project B remains indexed
in the same backing store. The background documents compete for the same budget.
All modes receive the same 3,000-byte budget and explicit relevance labels.

Recorded on Windows, Node 24.13.0, warm already-installed local services. Each
query is measured once per mode/case; timings are illustrative, not stable latency
percentiles. Setup/indexing is excluded from query latency. Sources and judgments
are in `tests/fixtures/retrieval.mjs`; raw results include selected items, reasons,
budget cost, effective mode, and actual lexical/semantic use.

| Backend / mode | Relevant hit | Top 3 | Wrong items | Clean negatives | Mean query ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| FTS5 (Ollama run) | 18/22 | 18/22 | 17 | 3/3 | 11.94 |
| Ollama semantic | 21/22 | 21/22 | 39 | 2/3 | 51.92 |
| Ollama hybrid | 21/22 | 21/22 | 39 | 2/3 | 50.79 |
| FTS5 (OpenViking run) | 18/22 | 18/22 | 17 | 3/3 | 12.33 |
| OpenViking semantic | 21/22 | 21/22 | 23 | 3/3 | 55.54 |
| OpenViking hybrid | 21/22 | 21/22 | 25 | 3/3 | 57.33 |

Raw runs: [no backend](retrieval-none.json), [Ollama](retrieval-ollama.json),
[OpenViking](retrieval-openviking.json). With no backend, all three requested modes
effectively use FTS5 and produce the same labels. Each run also invokes the real
compiled CLI for every search mode, context, verbose explain and doctor.

A later repeat on 2026-09-20 found both local service endpoints unavailable.
The successful timestamped runs above are retained; they do not imply that the
services remained healthy. A separate [real CLI outage check](semantic-service-outage.json)
verified lexical fallback, returned source content, byte limits and unavailable
doctor diagnostics for both providers. No service was restarted or reconfigured.

## What improved, and what did not

Ollama adds four missed natural-language cases without losing exact matches, but
loses the handoff case: weakly related current sources fill the budget before the
lower-trust handoff. Hybrid does **not** beat semantic-only recall here. Wrong
items increase from 17 to 39, and one negative query retrieves irrelevant current
logging documentation. This is a false positive, not a returned deleted source.
Use the dedicated handoff tool when switching agents; a context bundle alone is
not a guarantee that the latest handoff fits.

The initial reciprocal-rank fusion also let weak OR keyword matches outvote good
paraphrases. A general minimum term-coverage gate removed those extra votes. The
same fixtures and cutoff were retained. The [Ollama before-gate report](retrieval-ollama-before-fusion.json)
records 19/22 hybrid hits and 41 wrong items; the [OpenViking before-gate report](retrieval-openviking-before-fusion.json)
records 21/22 and 25. No per-query or per-file ranking exceptions were added.

OpenViking misses `restore dropped transport` at the same 0.5 cosine cutoff. Its
observed score was about 0.474, versus about 0.501 through the direct Ollama adapter.
Both services expose `nomic-embed-text`, but preprocessing and backend scoring are
not identical; OpenViking's internal model digest is not exposed by its health API.
The cutoff was kept fixed for comparison, not lowered to make this case pass.

An authoritative rule wins ranking over an agent claim, but two contradictory
ordinary source files can both enter context. Generic words still admit irrelevant
documents. Exact-symbol and exact-path checks remain useful signals. Neither this
fusion nor embeddings decide which ordinary prose assertion is true.

Rules, reviewed/source-backed memories and the latest relevant handoff are shared
Core policy in all three modes. Semantic-only means no FTS candidates; it does not
disable these policy inputs. A correct handoff hit is therefore not counted as
evidence that embeddings understand handoffs. The raw `semantic_used` flag makes
this distinction visible.

All cross-project and deleted-source canaries remained absent. These are boundary
assertions, not averages: any leak aborts the evaluation.

## Reproduce

```sh
pnpm build
node scripts/retrieval-evaluation.mjs --backend=none --write
node scripts/retrieval-evaluation.mjs --backend=ollama --write
node scripts/retrieval-evaluation.mjs --backend=openviking --write
```

The last two commands require already-configured local services; they perform no
installation or model download. OpenViking retains the fixture's remote resource
versions. See [setup, API references and limitations](retrieval.md).
