import { randomUUID } from 'node:crypto';
import { contextRequestSchema } from '../contracts.js';
import type { ContextBundle, ContextItem, ContextRequest, Project, Resource, StoragePort, TokenEstimator, SelectionAudit } from '../contracts.js';
import { passages } from './passages.js';
import { rankPassages } from './ranking.js';
import { NamespaceGuard } from '../security/namespace.js';

export function contextBroker(storage: StoragePort, project: Project, request: ContextRequest, sources: Resource[], estimator?: TokenEstimator, ranked?: { items: ContextItem[]; retrieval: NonNullable<ContextBundle['retrieval']> }): ContextBundle {
  const { task, role, budget, provider_model_hint } = contextRequestSchema.parse(request);
  const guard = new NamespaceGuard(project);
  const candidates: ContextItem[] = ranked?.items ?? rankPassages(sources, passages(sources), storage.search(project.project_id, task, 100), [], task, 'lexical');
  const terms = task.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  for (const m of storage.memories(project.project_id)) {
    if (!['persist', 'accepted'].includes(m.status) || !terms.some(t => m.text.toLowerCase().includes(t))) continue;
    if (m.source_path && !sources.some(r => r.state === 'fresh' && r.path === m.source_path && r.hash === m.provenance.source_version)) continue;
    candidates.push({ id: m.id, kind: m.kind, content: m.text, provenance: m.provenance, reasons: ['same project', m.status === 'accepted' ? 'human-reviewed claim; current sources take precedence' : 'source-backed memory; source version still current', 'task term match'] });
  }
  const handoff = storage.handoffs(project.project_id)[0];
  if (handoff && terms.some(t => [handoff.task.goal, ...handoff.remaining, ...handoff.decisions, handoff.recommended_next_action].join(' ').toLowerCase().includes(t))) {
    candidates.push({ id: handoff.id, kind: 'handoff', content: JSON.stringify({ task: handoff.task, remaining: handoff.remaining, decisions: handoff.decisions, recommended_next_action: handoff.recommended_next_action }), provenance: handoff.provenance, reasons: ['same project', 'latest structured handoff', 'task term match; agent report, not project policy'] });
  }
  const bundle: ContextBundle = { schema_version: 1, context_id: `ctx_${randomUUID()}`, project_id: project.project_id, role, items: [], budget: { requested: budget, used: 0, unit: 'utf8_bytes' } };
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
  const seen = new Set<string>();
  const selection: SelectionAudit = { candidates: candidates.length, entries: [] };
  const record = (item: ContextItem, outcome: SelectionAudit['entries'][number]['outcome']) => {
    if (selection.entries.length < 500) selection.entries.push({ id: item.id, source: item.provenance.origin, outcome, reasons: item.reasons });
  };
  for (const item of candidates) {
    guard.assert(item.provenance.project_id);
    if (seen.has(item.content)) { record(item, 'duplicate'); continue; }
    seen.add(item.content);
    bundle.items.push(item);
    estimate();
    bundle.budget.used = budget; // Reserve maximum digit width while measuring.
    if (size() > budget) { bundle.items.pop(); estimate(); record(item, 'budget'); }
    else record(item, 'included');
  }
  bundle.budget.used = budget;
  for (let n = 0; n < 4; n++) bundle.budget.used = size();
  if (size() > budget) throw new Error('Context metadata exceeds byte budget.');
  storage.saveContext(bundle, selection);
  return bundle;
}
