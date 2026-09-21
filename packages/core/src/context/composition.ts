import type { ContextItem } from '../contracts.js';

export type CompositionPolicy = 'flat' | 'source-diversity';
export interface CompositionEntry { item: ContextItem; lane: 'control' | 'evidence'; pass: 'primary' | 'additional' }

/** Host-selected composition only. Candidate retrieval and rank are unchanged. */
export function compositionOrder(items: readonly ContextItem[], policy: CompositionPolicy): CompositionEntry[] {
  // A reviewed memory classified as a rule is still a claim, not an authoritative source rule.
  const entries = items.map(item => ({ item, lane: item.kind === 'rule' && item.passage ? 'control' as const : 'evidence' as const, pass: 'primary' as const }));
  if (policy === 'flat') return entries;
  const control = entries.filter(entry => entry.lane === 'control');
  const requested = entries.filter(entry => entry.lane === 'evidence' && entry.item.reasons.includes('explicit source path requested'));
  const first: CompositionEntry[] = [], additional: CompositionEntry[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.lane === 'control' || entry.item.reasons.includes('explicit source path requested')) continue;
    // Only source passages compete for source diversity; memory/handoff identity is independent.
    const key = entry.item.passage ? entry.item.provenance.origin : entry.item.id;
    if (seen.has(key)) additional.push({ ...entry, pass: 'additional' });
    else { seen.add(key); first.push(entry); }
  }
  return [...control, ...requested, ...first, ...additional];
}
