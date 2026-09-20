import { randomUUID } from 'node:crypto';
import { contextRequestSchema } from '../contracts.js';
import type { ContextBundle, ContextItem, ContextRequest, Project, Resource, StoragePort, TokenEstimator } from '../contracts.js';
import { NamespaceGuard } from '../security/namespace.js';

export function contextBroker(storage: StoragePort, project: Project, request: ContextRequest, sources: Resource[], estimator?: TokenEstimator): ContextBundle {
  const { task, role, budget, provider_model_hint } = contextRequestSchema.parse(request);
  const guard = new NamespaceGuard(project);
  const matches = storage.search(project.project_id, task, 100);
  const rules = sources.filter(r => r.kind === 'rule' && r.state === 'fresh').sort((a, b) => a.path.localeCompare(b.path));
  const candidates: ContextItem[] = [...rules, ...matches].map(r => {
    const truncated = Buffer.byteLength(r.content) > 1800;
    const terms = task.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
    const lines = r.content.split('\n');
    const matchLine = truncated ? lines.findIndex(line => terms.some(t => line.toLowerCase().includes(t))) : 0;
    const excerpt = lines.slice(Math.max(0, matchLine)).join('\n');
    return {
      id: r.id, kind: r.kind, content: truncated ? Array.from(excerpt).slice(0, 400).join('') : r.content, provenance: r.provenance,
      reasons: ['same project', 'authoritative project source', 'source hash checked during this request', r.kind === 'rule' ? 'project rule applies to every role' : 'FTS5 task match', ...(truncated ? ['bounded excerpt; consult original source for full content'] : [])],
    };
  });
  const terms = task.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  for (const m of storage.memories(project.project_id)) {
    if (!['persist', 'accepted'].includes(m.status) || !terms.some(t => m.text.toLowerCase().includes(t))) continue;
    if (m.source_path && !sources.some(r => r.state === 'fresh' && r.path === m.source_path && r.hash === m.provenance.source_version)) continue;
    candidates.push({ id: m.id, kind: m.kind, content: m.text, provenance: m.provenance, reasons: ['same project', m.status === 'accepted' ? 'human-reviewed claim; current sources take precedence' : 'source-backed memory; source version still current', 'task term match'] });
  }
  const bundle: ContextBundle = { schema_version: 1, context_id: `ctx_${randomUUID()}`, project_id: project.project_id, role, items: [], budget: { requested: budget, used: 0, unit: 'utf8_bytes' } };
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
  for (const item of candidates) {
    guard.assert(item.provenance.project_id);
    if (seen.has(item.content)) continue;
    seen.add(item.content);
    bundle.items.push(item);
    estimate();
    bundle.budget.used = budget; // Reserve maximum digit width while measuring.
    if (size() > budget) { bundle.items.pop(); estimate(); }
  }
  bundle.budget.used = budget;
  for (let n = 0; n < 4; n++) bundle.budget.used = size();
  if (size() > budget) throw new Error('Context metadata exceeds byte budget.');
  storage.saveContext(bundle);
  return bundle;
}
