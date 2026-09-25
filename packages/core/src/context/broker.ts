import { randomUUID } from 'node:crypto';
import { contextRequestSchema } from '../contracts.js';
import type { ContextBundle, ContextItem, ContextRequest, Project, Resource, StoragePort, TokenEstimator, SelectionAudit } from '../contracts.js';
import { passages } from './passages.js';
import { rankPassages } from './ranking.js';
import { NamespaceGuard } from '../security/namespace.js';
import { memoryContextKind, sourceBackedCurrent } from './freshness.js';

const memoryTokens = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
/**
 * Memories follow every source passage in rank order, so a crowded source context used to drop them all. A memory that
 * covers at least half of the meaningful task terms (the same bar that separates a strong from a weak OR match in
 * ranking) may be selected ahead of lower-ranked source passages, within this share of the byte budget. A typical memory
 * item is about 700 bytes, so a quarter of the 6,000-byte default holds one or two, while rules and ranked sources keep
 * at least three quarters of every budget.
 */
const MEMORY_SHARE = 0.25;

export function contextBroker(storage: StoragePort, project: Project, request: ContextRequest, sources: Resource[], estimator?: TokenEstimator, ranked?: { items: ContextItem[]; retrieval: NonNullable<ContextBundle['retrieval']> }, workspaceId?: string): ContextBundle {
  const { task, role, budget, provider_model_hint } = contextRequestSchema.parse(request);
  const guard = new NamespaceGuard(project);
  const candidates: ContextItem[] = ranked?.items ?? rankPassages(sources, passages(sources), storage.search(project.project_id, task, 100), [], task, 'lexical');
  const terms = task.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  const meaningful = memoryTokens(task).filter(t => t.length > 2 && !['the', 'and', 'for', 'with', 'this', 'that', 'from', 'are', 'was', 'into', 'how', 'can', 'should', 'project'].includes(t));
  const memoryPriority = (m: ReturnType<StoragePort['memories']>[number]) => m.status === 'accepted' ? 0 : m.source_path ? 1 : 2;
  const wanted = new Set(meaningful), strong: ContextItem[] = [];
  for (const m of storage.memories(project.project_id).sort((a, b) => memoryPriority(a) - memoryPriority(b) || a.id.localeCompare(b.id))) {
    if (!['persist', 'accepted'].includes(m.status)) continue;
    const words = new Set(memoryTokens(`${m.key} ${m.text}`));
    if (m.provenance.trust === 'agent_observation' && m.status !== 'accepted') {
      if (!meaningful.some(t => words.has(t))) continue;
    } else if (!terms.some(t => m.text.toLowerCase().includes(t))) continue;
    if (!sourceBackedCurrent(m, sources)) continue;
    const matched = [...wanted].filter(t => words.has(t)).length;
    const item: ContextItem = { id: m.id, kind: memoryContextKind(m), content: m.text, provenance: m.provenance, reasons: ['same project', m.status === 'accepted' ? 'human-reviewed claim; current sources take precedence' : m.source_path ? 'source-backed memory; source version still current' : 'agent-learned observation; not source truth or project policy', 'task term match'] };
    if (matched && matched * 2 >= wanted.size) { item.reasons.push(`strong task match: ${matched}/${wanted.size} terms; bounded memory share`); strong.push(item); }
    candidates.push(item);
  }
  const handoff = storage.handoffs(project.project_id).find(h => h.provenance.workspace_id === workspaceId);
  if (handoff && terms.some(t => [handoff.task.goal, ...handoff.remaining, ...handoff.decisions, handoff.recommended_next_action].join(' ').toLowerCase().includes(t))) {
    candidates.push({ id: handoff.id, kind: 'handoff', content: JSON.stringify({ task: handoff.closure ? { ...handoff.task, status: handoff.closure.status } : handoff.task, remaining: handoff.remaining, decisions: handoff.decisions, recommended_next_action: handoff.recommended_next_action }), provenance: handoff.provenance, reasons: ['same project', 'latest structured handoff', 'task term match; agent report, not project policy'] });
  }
  const bundle: ContextBundle = { schema_version: 1, context_id: `ctx_${randomUUID()}`, project_id: project.project_id, role, items: [], budget: { requested: budget, used: 0, unit: 'utf8_bytes' } };
  if (workspaceId) bundle.workspace_id = workspaceId;
  if (ranked) bundle.retrieval = ranked.retrieval;
  // Budget covers the entire serialized bundle, including metadata. No tokenizer dependency.
  const size = () => Buffer.byteLength(JSON.stringify(bundle), 'utf8');
  if (estimator) {
    bundle.budget.estimated_tokens = 0;
    if (provider_model_hint) bundle.budget.provider_model_hint = provider_model_hint;
  }
  const estimate = () => {
    if (!estimator) return;
    const value = estimator.estimate(JSON.stringify(bundle.items), provider_model_hint);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Token estimator returned an invalid estimate.');
    bundle.budget.estimated_tokens = value;
  };
  const seen = new Set<string>(), duplicate = new Set<ContextItem>();
  for (const item of candidates) {
    guard.assert(item.provenance.project_id);
    if (seen.has(item.content)) duplicate.add(item); else seen.add(item.content);
  }
  const rank = new Map(candidates.map((item, i) => [item, i])), included = new Set<ContextItem>();
  bundle.budget.used = budget; // Reserve maximum digit width while measuring.
  /**
   * Inserts at the item's rank position, so the bundle is always measured in final order. With a limit, the item must
   * also add no more than `limit` bytes; returns the bytes it added (measured only then: one serialization otherwise).
   */
  const add = (item: ContextItem, limit?: number) => {
    if (duplicate.has(item) || included.has(item)) return 0;
    const before = limit === undefined ? 0 : size(), at = bundle.items.findIndex(i => rank.get(i)! > rank.get(item)!);
    bundle.items.splice(at < 0 ? bundle.items.length : at, 0, item);
    estimate();
    const after = size();
    if (after > budget || (limit !== undefined && after - before > limit)) { bundle.items.splice(bundle.items.indexOf(item), 1); estimate(); return 0; }
    included.add(item);
    return limit === undefined ? 0 : after - before;
  };
  // Current rules first. Then strongly matching memories, in their usual order, within a bounded share. Then every
  // candidate in rank order, first fit, as before. Without a strong memory the result is unchanged.
  for (const item of candidates) if (item.kind === 'rule') add(item);
  let share = Math.floor(budget * MEMORY_SHARE);
  for (const item of strong) share -= add(item, share);
  for (const item of candidates) add(item);
  const selection: SelectionAudit = { candidates: candidates.length, entries: candidates.slice(0, 500).map(item => ({ id: item.id, source: item.provenance.origin, outcome: duplicate.has(item) ? 'duplicate' : included.has(item) ? 'included' : 'budget', reasons: item.reasons })) };
  for (let n = 0; n < 4; n++) bundle.budget.used = size();
  if (size() > budget) throw new Error('Context metadata exceeds byte budget.');
  storage.saveContext(bundle, selection);
  return bundle;
}
