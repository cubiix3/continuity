# Retrieval evaluation

This extends the unchanged [eight-case baseline](retrieval-baseline.md) to 25 fixed
synthetic cases: 22 positive queries and three expected-empty queries. The corpus
includes exact symbols/paths, rules, paraphrases, contradictions, stale/deleted
sources, code, reviewed memory, handoffs, large noise and a cross-project canary.
Each case has its own project; project B remains indexed in the same backing store.
All modes receive the same 3,000-byte budget and explicit relevance labels.

Recorded on Windows, Node 24.13.0, warm already-installed local services. Each
query is measured once per mode/case; timings are illustrative, not stable latency
percentiles. Setup/indexing is excluded from query latency. Sources and judgments
are in `tests/fixtures/retrieval.mjs`; raw results include selected items, reasons,
budget cost, effective mode, and actual lexical/semantic use.

| Backend / mode | Relevant hit | Top 3 | Wrong items | Clean negatives | Mean query ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| FTS5 (Ollama run) | 18/22 | 18/22 | 9 | 3/3 | 9.79 |
| Ollama semantic | 22/22 | 22/22 | 13 | 3/3 | 46.97 |
| Ollama hybrid | 22/22 | 22/22 | 13 | 3/3 | 45.29 |
| FTS5 (OpenViking run) | 18/22 | 18/22 | 9 | 3/3 | 9.58 |
| OpenViking semantic | 21/22 | 21/22 | 12 | 3/3 | 54.91 |
| OpenViking hybrid | 21/22 | 21/22 | 12 | 3/3 | 52.44 |

Raw runs: [no backend](retrieval-none.json), [Ollama](retrieval-ollama.json),
[OpenViking](retrieval-openviking.json). With no backend, all three requested modes
effectively use FTS5 and produce the same labels. Each run also invokes the real
compiled CLI for every search mode, context, verbose explain and doctor.

## What improved, and what did not

Ollama adds the four missed natural-language cases without losing exact matches in
this fixture. Hybrid does **not** beat semantic-only recall here. Both add four
wrong items compared with lexical retrieval. The small 3,000-byte budget makes the
packing cost visible; this is not evidence of universally better precision.

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
