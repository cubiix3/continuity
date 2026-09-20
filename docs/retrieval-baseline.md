# Lexical retrieval baseline

Run `pnpm build && pnpm baseline`. To refresh the checked-in measurements:
`node scripts/retrieval-baseline.mjs --write`.

Eight small synthetic fixtures use the actual SQLite FTS5/BM25 and ContextBroker,
with a 3,000-byte budget per request. No embedding model or ranking change is
introduced. The raw [measurements](retrieval-baseline.json) include each query,
whether the expected source was included, unwanted sources, serialized budget
cost, and selection reasons.

| Scenario | Relevant included | Unwanted included | Bytes |
| --- | --- | --- | --- |
| Exact symbol | Yes | None | 731 |
| Architecture decision | Yes | Generic manager document | 1187 |
| Wording variation | No | None | 226 |
| Outdated source | Yes, current version | No old version | 709 |
| Conflicting source | Yes | Contradictory document | 1183 |
| Common generic terms | Yes | Navigation state document | 1169 |
| Similarly named files | Yes | None | 692 |
| Irrelevant large document | Yes | None | 692 |

Seven of eight expected sources were included. Three scenarios also admitted an
unwanted source. The synonym-only query missed its target completely. Generic
terms can rank an irrelevant source first, and lexical matching cannot adjudicate
contradictions between current files. File names alone are not a ranking signal.

These are diagnostic cases, not population-level precision/recall or a performance
benchmark. Source invalidation and byte budgets held. This baseline justifies
investigating lexical query construction and source curation before evaluating an
optional semantic ranker; it does not justify adding a vector dependency now.
