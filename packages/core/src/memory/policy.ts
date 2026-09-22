import { randomUUID } from 'node:crypto';
import { memoryCandidateSchema } from '../contracts.js';
import type { Memory, MemoryProposal, Project, Resource, StoragePort } from '../contracts.js';

const active = (m: Memory) => ['persist', 'accepted'].includes(m.status);
const learned = (m: Memory) => m.provenance.trust === 'agent_observation' && !m.source_path && m.status !== 'accepted';
const routine = /(tests? (passed|succeeded)|build (passed|succeeded)|i (modified|changed)|temporary debug|^(?:todo|next task)\s*:|\b(?:i guess|i speculate|probably|might be|maybe)\b|^(?:always write clean code|use meaningful variable names|follow best practices)\b)/i;

/** Automatic activation is not source authority. Evidence and conflicts are checked in the caller's transaction. */
export function proposeMemory(storage: StoragePort, project: Project, input: unknown, sources: Resource[]): MemoryProposal {
  const candidate = memoryCandidateSchema.parse(input);
  const previous = storage.memories(project.project_id);
  const current = (m: Memory) => sources.some(r => r.project_id === project.project_id && r.provenance.project_id === project.project_id && r.state === 'fresh' && r.path === m.source_path && r.hash === m.provenance.source_version && r.content.includes(m.text));
  const source = sources.find(r => r.project_id === project.project_id && r.provenance.project_id === project.project_id && r.path === candidate.source_path && r.state === 'fresh');
  const backed = !!source && source.content.includes(candidate.text);
  const matches = previous.filter(m => m.key === candidate.key && (active(m) || m.status === 'needs_attention'));
  const conflicts = matches.filter(m => m.text !== candidate.text);
  const replaceable = (m: Memory) => learned(m) || (m.status !== 'accepted' && !!m.source_path && !current(m));
  const duplicate = matches.find(m => m.text === candidate.text && m.kind === candidate.kind && m.source_path === candidate.source_path && (candidate.source_path ? current(m) : learned(m) || m.status === 'accepted'));
  const resolvesDuplicate = backed && duplicate?.status === 'persist' && conflicts.length > 0 && conflicts.every(replaceable);
  if (duplicate && (active(duplicate) || !backed) && !resolvesDuplicate) return { ...duplicate, outcome: 'duplicate' };

  let status: Memory['status'] = 'persist', reason = 'Automatically retained agent observation; current sources and human-reviewed knowledge take precedence.';
  let outcome: MemoryProposal['outcome'] = 'persisted';
  if (routine.test(candidate.text)) {
    status = 'reject'; outcome = 'rejected'; reason = 'Routine output, temporary work, generic advice or explicit speculation is not durable project knowledge.';
  } else if (candidate.source_path && !backed) {
    status = 'needs_attention'; outcome = 'quarantined'; reason = 'Supplied source does not prove this exact claim in the current authorized snapshot.';
  } else if (!candidate.source_path && !candidate.from) {
    status = 'proposed'; outcome = 'pending'; reason = 'Agent/session provenance is missing. Legacy candidates remain inactive; provide provenance or use optional human review.';
  } else if (backed) reason = 'Exact excerpt from a current project source; source remains authoritative.';

  const id = resolvesDuplicate ? duplicate!.id : `mem_${randomUUID()}`;
  const replaced: string[] = [];
  if (status === 'persist' && (conflicts.length || (backed && matches.some(replaceable)))) {
    if (backed && conflicts.every(replaceable)) {
      for (const old of matches.filter(replaceable)) {
        storage.saveMemory({ ...old, status: 'superseded', superseded_by: id, reason: 'Replaced by a claim proven in the current source snapshot.' }); replaced.push(old.id);
      }
      outcome = 'superseded';
    } else {
      status = 'needs_attention'; outcome = 'quarantined'; reason = 'Conflicting key. No latest-wins decision; inspect current source or use an explicit human override.';
      // Stronger source/human claims remain active against a lower-trust observation.
      for (const old of conflicts.filter(m => active(m) && (learned(m) || (backed && m.status !== 'accepted')))) {
        storage.saveMemory({ ...old, status: 'needs_attention', reason: 'Conflicting same-key claims quarantined; current source or explicit correction is required.' });
      }
    }
  }
  const memory: Memory = {
    ...candidate, id, project_id: project.project_id, status, reason,
    provenance: { project_id: project.project_id, ...(source?.provenance.workspace_id ? { workspace_id: source.provenance.workspace_id } : {}), origin: candidate.source_path ?? (candidate.from ? `agent:${candidate.from.agent}` : 'agent:proposal'), captured_at: new Date().toISOString(), source_version: source?.hash ?? candidate.from?.session ?? 'unverified', trust: backed ? 'derived' : candidate.from && !candidate.source_path ? 'agent_observation' : 'untrusted' },
  };
  storage.saveMemory(memory);
  return { ...memory, outcome, ...(replaced.length ? { superseded_ids: replaced } : {}) };
}
