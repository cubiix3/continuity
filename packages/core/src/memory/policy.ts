import { randomUUID } from 'node:crypto';
import { memoryCandidateSchema } from '../contracts.js';
import type { Memory, Project, Resource, StoragePort } from '../contracts.js';

/** Conservative extractive policy: unverified free-form claims never become active memory. */
export function proposeMemory(storage: StoragePort, project: Project, input: unknown, sources: Resource[]): Memory {
  const candidate = memoryCandidateSchema.parse(input);
  const previous = storage.memories(project.project_id);
  const duplicate = previous.find(m => m.status === 'persist' && m.key === candidate.key && m.text === candidate.text && m.source_path === candidate.source_path);
  const source = sources.find(r => r.path === candidate.source_path && r.state === 'fresh');
  if (duplicate && source?.hash === duplicate.provenance.source_version) return duplicate;
  let status: Memory['status'] = 'persist';
  let reason = 'Exact excerpt from a current project source; source remains authoritative.';
  if (/(tests? (passed|succeeded)|build (passed|succeeded)|i (modified|changed)|temporary debug)/i.test(candidate.text)) {
    status = 'reject'; reason = 'Routine execution output belongs in observations, not durable memory.';
  } else if (!candidate.source_path) {
    status = 'proposed'; reason = 'Free-form candidate requires explicit human review.';
  } else if (!source || !source.content.includes(candidate.text)) {
    status = 'needs_attention'; reason = 'Requires an exact excerpt from a current project source. Curate the source first.';
  } else if (previous.some(m => m.key === candidate.key && ['persist', 'accepted'].includes(m.status) && m.text !== candidate.text)) {
    status = 'needs_attention'; reason = 'Conflicting active key. Review and explicitly forget the old claim before proposing its replacement.';
  }
  const memory: Memory = {
    ...candidate, id: `mem_${randomUUID()}`, project_id: project.project_id, status, reason,
    provenance: { project_id: project.project_id, ...(source?.provenance.workspace_id ? { workspace_id: source.provenance.workspace_id } : {}), origin: candidate.source_path ?? 'agent:proposal', captured_at: new Date().toISOString(), source_version: source?.hash ?? 'unverified', trust: status === 'persist' ? 'derived' : 'untrusted' },
  };
  storage.saveMemory(memory);
  return memory;
}
