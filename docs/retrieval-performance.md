# Indexing and query scale

Wall-clock measurements on the same Windows machine and Node 24.13.0. Small and
medium projects contain 100 and 1,000 resources respectively. The larger fixture
contains 1,000 resources with ten Markdown sections each: 10,000 passages. Content
is generated identically in every mode. Model/service startup is not included;
services were already running and retain earlier synthetic fixtures.

Each row measures first sync, unchanged sync, one changed file, ten changed files,
five context queries, and SQLite size after close. Values are milliseconds unless
marked otherwise. Query ranges show all five samples, not chosen best cases.
The runner permits at most four explicit 30-second sync calls. Scan and health
checks add overhead, so total time can exceed 120 seconds. Incomplete indexes use
lexical fallback; their unperformed incremental measurements are null.

| Backend | Passages | First sync | Unchanged | One file | Ten files | Query range | Local DB bytes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| FTS5 | 100 | 57.57 | 43.00 | 46.41 | 56.55 | 43.91–51.77 | 372,736 |
| FTS5 | 1,000 | 538.49 | 491.25 | 454.10 | 406.35 | 391.37–464.43 | 1,896,448 |
| FTS5 | 10,000 | 775.78 | 426.66 | 406.38 | 405.50 | 438.08–551.25 | 7,372,800 |
| Ollama | 100 | 772.59 | 74.04 | 103.32 | 164.02 | 128.44–176.22 | 974,848 |
| Ollama | 1,000 | 7,047.23 | 664.15 | 604.93 | 672.37 | 975.59–1,174.26 | 6,385,664 |
| Ollama | 10,000 | 66,823.72 | 1,623.83 | 1,723.79 | 1,713.06 | 2,385.72–2,604.04 | 50,712,576 |
| OpenViking | 100 | 21,504.99 | 101.43 | 288.37 | 2,155.56 | 163.84–208.40 | 622,592* |
| OpenViking | 1,000 | incomplete: 566 indexed / 125,309.03 ms | — | — | — | 1,021.66–1,121.73† | 2,277,376* |
| OpenViking | 10,000 | incomplete: 566 indexed / 128,594.88 ms | — | — | — | 1,258.09–1,375.72† | 7,708,672* |

\* OpenViking numbers include only Continuity's local source index and URI manifest.
The independently managed service's disk usage is not measured; these storage
numbers are **not comparable** to SQLite-resident Ollama vectors.
† These queries used lexical fallback, not a completed OpenViking semantic index.

Raw data: [FTS5](performance-fts-after.json), [Ollama](performance-ollama.json),
[OpenViking](performance-openviking.json). The raw Ollama sync reasons show only one
new embedding after the single-file edit, ten after the incremental edit, and zero
after unchanged sync. The 10,000-passage first sync resumed after 4,896 and 9,888
completed embeddings rather than restarting.

## Comparison with main

The same script ran against detached `main` commit `18ad6ae` before semantic work.
That implementation indexed the same resources but did not create passages.
[Its complete results](performance-fts-before.json) remain committed.

At 10,000 generated sections, unchanged FTS sync changed from 656.59 to 426.66 ms;
queries from 614.20–748.36 to 438.08–551.25 ms. First sync, however, increased from
561.22 to 775.78 ms. At 1,000 resources, first sync also increased from 486.51 to
538.49 ms. These individual runs do not establish statistical significance or a
universal speedup. Incremental FTS updates avoid rewriting unchanged rows, and
lexical requests split only candidate resources into passages.

## Limits found

Linear local vector scoring works at 10,000 passages, but total hybrid query time
is already about 2.4–2.6 seconds here. The request still scans source hashes and
loads/validates vectors; this is not an isolated cosine microbenchmark. There is
no evidence yet that an approximate vector database would solve the dominant cost.

The OpenViking service returned 504s and reached request deadlines in larger runs.
Continuity reports degradation and preserves completed writes. It does not restart
or reconfigure the service. Completion, incremental timings and semantic latency
at 1,000/10,000 OpenViking passages remain unverified under this bounded run.

An earlier [OpenViking profile](performance-openviking-before-cache.json) exposed
unnecessary manifest rewrites, including a 6,545 ms unchanged 100-passage sync.
Those writes were removed; the repeat measured 101 ms. Server timing also varied,
so this is a useful diagnostic comparison rather than a controlled backend speedup
claim. The earlier timeout/504 results are retained, not discarded.

```sh
pnpm build
node scripts/retrieval-performance.mjs --backend=none --label=fts-after --write
node scripts/retrieval-performance.mjs --backend=ollama --write
node scripts/retrieval-performance.mjs --backend=openviking --write
```

No services are installed. The tests leave synthetic remote resources on the
explicitly selected OpenViking service; local temporary projects are removed.
