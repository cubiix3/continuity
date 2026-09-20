import { randomUUID } from 'node:crypto';
import type { ContextRequest, Handoff, Project, SourcePort, StoragePort, TokenEstimator } from './contracts.js';
import { handoffInputSchema, contextRequestSchema, memoryCandidateSchema, observationSchema } from './contracts.js';
import { contextBroker } from './context/broker.js';
import { proposeMemory } from './memory/policy.js';
import { NamespaceGuard } from './security/namespace.js';

export * from './contracts.js';
export * from './projects/resolver.js';
export * from './security/namespace.js';

/** A host-created, project-bound capability. Adapters receive this, never storage. */
export class ProjectClient {
  private readonly guard: NamespaceGuard;
  constructor(private readonly storage: StoragePort, private readonly source: SourcePort, private readonly project: Project, private readonly estimator?: TokenEstimator) {
    this.guard = new NamespaceGuard(project);
  }
  private assertBinding() {
    if (!this.storage.projects().some(p => p.project_id === this.project.project_id && p.root === this.project.root)) throw new Error('Project binding changed. Reconnect the adapter.');
  }
  status() { this.assertBinding(); return { ...this.project, sync: this.storage.syncState(this.project.project_id) }; }
  sync() {
    this.assertBinding();
    const resources = this.source.scan(this.project);
    for (const resource of resources) this.guard.assert(resource.project_id);
    const state = { at: new Date().toISOString(), files: resources.length, bytes: resources.reduce((sum, r) => sum + Buffer.byteLength(r.content), 0) };
    this.storage.replaceResources(this.project.project_id, resources, state);
    return state;
  }
  search(query: string) {
    if (!query.trim() || query.length > 2000) throw new Error('Search requires 1–2000 characters.');
    this.sync();
    const results = [];
    for (const resource of this.storage.search(this.project.project_id, query, 10)) {
      const excerpt = { ...resource, content: Array.from(resource.content).slice(0, 300).join(''), truncated: Array.from(resource.content).length > 300 };
      if (Buffer.byteLength(JSON.stringify([...results, excerpt])) > 16000) break;
      results.push(excerpt);
    }
    return results;
  }
  context(request: ContextRequest) {
    contextRequestSchema.parse(request);
    this.sync();
    return contextBroker(this.storage, this.project, request, this.storage.resources(this.project.project_id), this.estimator);
  }
  inspect(id: string) {
    this.assertBinding();
    const bundle = this.storage.context(this.project.project_id, id);
    if (!bundle) throw new Error('Context not found in this project.');
    return bundle;
  }
  propose(input: unknown) {
    memoryCandidateSchema.parse(input);
    this.sync();
    return this.storage.atomic(() => proposeMemory(this.storage, this.project, input, this.storage.resources(this.project.project_id)));
  }
  memories() { this.assertBinding(); return this.storage.memories(this.project.project_id); }
  memory(id: string) {
    const memory = this.memories().find(m => m.id === id);
    if (!memory) throw new Error('Memory not found in this project.');
    return memory;
  }
  forget(id: string) {
    const memory = this.memory(id);
    const forgotten = { ...memory, status: 'forgotten' as const, reason: 'Explicitly forgotten; retained in local revision history.' };
    this.storage.saveMemory(forgotten);
    return forgotten;
  }
  createHandoff(input: unknown): Handoff {
    this.assertBinding();
    const parsed = handoffInputSchema.parse(input);
    const handoff: Handoff = { ...parsed, schema_version: 1, id: `handoff_${randomUUID()}`, project_id: this.project.project_id,
      provenance: { project_id: this.project.project_id, origin: `agent:${parsed.from.agent}`, captured_at: new Date().toISOString(), source_version: parsed.from.session, trust: 'agent_observation' } };
    this.storage.saveHandoff(handoff);
    return handoff;
  }
  observe(input: unknown) {
    this.assertBinding();
    const parsed = observationSchema.parse(input);
    const observation = { ...parsed, id: `obs_${randomUUID()}`, project_id: this.project.project_id,
      provenance: { project_id: this.project.project_id, origin: `agent:${parsed.agent}`, captured_at: new Date().toISOString(), source_version: parsed.session, trust: 'agent_observation' as const } };
    this.storage.saveObservation(observation);
    return observation;
  }
  latestHandoff() { this.assertBinding(); return this.storage.handoffs(this.project.project_id)[0] ?? null; }
  handoff(id: string) {
    this.assertBinding();
    const handoff = this.storage.handoffs(this.project.project_id).find(h => h.id === id);
    if (!handoff) throw new Error('Handoff not found in this project.');
    return handoff;
  }
  doctor() { return this.storage.diagnose(); }
}
