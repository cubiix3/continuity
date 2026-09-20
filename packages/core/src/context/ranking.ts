import type { ContextItem, Passage, Resource, RetrievalMode, SemanticCandidate } from '../contracts.js';

export function rankPassages(sources: Resource[], chunks: readonly Passage[], matches: Resource[], semantic: readonly SemanticCandidate[], task: string, mode: RetrievalMode, includeRules = true): ContextItem[] {
  const resources = new Map(sources.filter(r => r.state === 'fresh').map(r => [r.id, r]));
  const lexicalRanks = new Map(matches.map((r, i) => [r.id, i + 1]));
  const semanticRanks = new Map(semantic.map((c, i) => [c.passage_id, { rank: i + 1, similarity: c.similarity }]));
  const terms = task.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  const symbols = task.match(/\b(?:[a-z]+[A-Z][\w]*|[A-Z][a-z]+[A-Z][\w]*|[A-Z][A-Z_0-9]{2,}|\w+_\w+)\b/g) ?? [];
  const scored = chunks.flatMap(p => {
    const r = resources.get(p.resource_id);
    if (!r || r.hash !== p.source_hash) return [];
    const lexical = mode !== 'semantic' ? lexicalRanks.get(r.id) : undefined;
    const sem = mode !== 'lexical' ? semanticRanks.get(p.id) : undefined;
    const words = new Set(p.text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []);
    const coverage = terms.filter(t => words.has(t)).length;
    const pathMatch = task.toLowerCase().includes(p.path.toLowerCase());
    const exact = pathMatch || symbols.some(s => words.has(s.toLowerCase()));
    if (!(includeRules && r.kind === 'rule') && !sem && !(lexical && coverage) && !(mode !== 'semantic' && pathMatch)) return [];
    const score = (lexical ? 1 / (60 + lexical) : 0) + (sem ? 1 / (60 + sem.rank) : 0);
    const item: ContextItem = { id: p.id, kind: r.kind, content: p.text, provenance: r.provenance, passage: { path: p.path, start_line: p.start_line, end_line: p.end_line }, reasons: ['same project', 'authoritative current source', 'source hash checked during this request', ...(r.kind === 'rule' ? ['project rule applies to every role'] : []), ...(exact ? ['exact symbol or path match'] : []), ...(lexical ? [`lexical rank #${lexical}`] : []), ...(sem ? [`semantic similarity ${sem.similarity.toFixed(3)}; rank #${sem.rank}`] : [])] };
    return [{ item, rule: r.kind === 'rule', exact: mode !== 'semantic' && exact, score, coverage, path: p.path, line: p.start_line }];
  });
  scored.sort((a, b) => Number(b.rule) - Number(a.rule) || Number(b.exact) - Number(a.exact) || b.score - a.score || b.coverage - a.coverage || a.path.localeCompare(b.path) || a.line - b.line);
  return scored.map((s, i) => ({ ...s.item, reasons: [...s.item.reasons, `final rank #${i + 1}`] }));
}
