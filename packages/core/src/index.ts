import { randomUUID } from 'node:crypto';
import type { ContextRequest, Handoff, Project, SourcePort, StoragePort, TokenEstimator, SemanticRetrievalPort, SemanticScope, SemanticHealth, RetrievalMode, SemanticCandidate, Workspace } from './contracts.js';
import { handoffInputSchema, contextRequestSchema, memoryCandidateSchema, observationSchema } from './contracts.js';
import { contextBroker } from './context/broker.js';
import { proposeMemory } from './memory/policy.js';
import { NamespaceGuard } from './security/namespace.js';
import { passages, PassageLimitError } from './context/passages.js';
import { rankPassages } from './context/ranking.js';
import { buildBootstrap } from './context/bootstrap.js';

export * from './contracts.js';
export * from './projects/resolver.js';
export * from './security/namespace.js';
export { BOOTSTRAP_BUDGET, renderBootstrap, relativeAge } from './context/bootstrap.js';
export type { BootstrapBundle, BootstrapMemory, BootstrapHandoff } from './context/bootstrap.js';

/** A host-created, project-bound capability. Adapters receive this, never storage. */
export class ProjectClient {
  private readonly guard: NamespaceGuard;
  constructor(private readonly storage: StoragePort, private readonly source: SourcePort, private readonly project: Project, private readonly estimator?: TokenEstimator, private readonly semantic?: SemanticRetrievalPort, private readonly defaultMode: RetrievalMode = semantic ? 'hybrid' : 'lexical', private readonly workspace?: Workspace) {
    this.guard = new NamespaceGuard(project);
  }
  private assertBinding() {
    if (!this.storage.projects().some(p => p.project_id === this.project.project_id && p.root === this.project.root)) throw new Error('Project binding changed. Reconnect the adapter.');
    if (this.workspace && !this.storage.workspaces(this.project.project_id).some(w => w.workspace_id === this.workspace!.workspace_id && w.root === this.workspace!.root)) throw new Error('Workspace binding changed. Reconnect the adapter.');
  }
  status() { this.assertBinding(); return { ...this.project, ...(this.workspace ? { workspace: this.workspace } : {}), sync: this.storage.syncState(this.project.project_id) }; }
  private refresh() {
    this.assertBinding();
    const resources = this.source.scan(this.workspace ? { ...this.project, root: this.workspace.root } : this.project);
    if (this.workspace) for (const resource of resources) resource.provenance.workspace_id = this.workspace.workspace_id;
    for (const resource of resources) this.guard.assert(resource.project_id);
    const state = { at: new Date().toISOString(), files: resources.length, bytes: resources.reduce((sum, r) => sum + Buffer.byteLength(r.content), 0) };
    this.storage.replaceResources(this.project.project_id, resources, state);
    return state;
  }
  private scopedResources() {
    const resources = this.storage.resources(this.project.project_id);
    for (const r of resources) { this.guard.assert(r.project_id); this.guard.assert(r.provenance.project_id); }
    if (resources.some(r => r.provenance.workspace_id !== this.workspace?.workspace_id)) throw new Error('Workspace boundary denied.');
    return resources;
  }
  private scope(resources = this.scopedResources(), structuralBoundaries = true): SemanticScope {
    return { project_id: this.project.project_id, passages: passages(resources, structuralBoundaries) };
  }
  private failure(error: unknown): SemanticHealth {
    const reason = error instanceof Error && error.name !== 'ZodError' ? error.message.slice(0, 180) : 'Malformed semantic backend response';
    return { status: 'unavailable', reason };
  }
  async sync() {
    const state = this.refresh();
    if (!this.semantic) return state;
    let semantic: SemanticHealth;
    try { semantic = await this.semantic.index(this.scope(), AbortSignal.timeout(30000)); }
    catch (error) { semantic = this.failure(error); }
    this.assertBinding();
    return { ...state, semantic };
  }
  async retrievalHealth(): Promise<SemanticHealth> {
    this.refresh();
    if (!this.semantic) return { status: 'disabled', reason: 'FTS5 active' };
    try { return await this.semantic.health(this.scope(), AbortSignal.timeout(3000)); }
    catch (error) { return this.failure(error); }
  }
  private async retrieve(task: string, mode = this.defaultMode, includeRules = true) {
    this.refresh();
    // Storage and namespace failures are not optional semantic failures.
    const resources = mode !== 'lexical' && this.semantic ? this.scopedResources() : [];
    let scope: SemanticScope = { project_id: this.project.project_id, passages: [] };
    let semantic: readonly SemanticCandidate[] = []; let effective = mode; let status = 'FTS5 active';
    if (mode !== 'lexical') {
      if (!this.semantic) { effective = 'lexical'; status = 'Semantic disabled; FTS5 active'; }
      else {
        try {
          scope = this.scope(resources);
          semantic = await this.semantic.search(scope, task, AbortSignal.timeout(3000));
          const allowed = new Set(scope.passages.map(p => p.id));
          if (semantic.length > 100 || semantic.some(c => !allowed.has(c.passage_id) || !Number.isFinite(c.similarity) || c.similarity < -1 || c.similarity > 1.000001)) throw new Error('Invalid semantic candidates');
          status = 'Semantic ready';
        } catch (error) {
          effective = 'lexical'; semantic = []; status = `${this.failure(error).reason}; FTS5 active`;
        }
        // The network wait is outside SQLite transactions. Revalidate all sources and binding.
        this.refresh();
      }
    }
    const sources = this.scopedResources();
    let lexical = effective === 'semantic' ? [] : this.storage.search(this.project.project_id, task, 100);
    const lexicalResources = () => {
      const ids = new Set(lexical.map(r => r.id));
      return sources.filter(r => ids.has(r.id) || (includeRules && r.kind === 'rule') || task.toLowerCase().includes(r.path.toLowerCase()));
    };
    let current: SemanticScope;
    try { current = this.scope(effective === 'lexical' ? lexicalResources() : sources); }
    catch (error) {
      if (!(error instanceof PassageLimitError)) throw error;
      if (effective !== 'lexical') {
        effective = 'lexical'; semantic = [];
        lexical = this.storage.search(this.project.project_id, task, 100);
        status = `${error.message}; FTS5 active`;
      }
      // Keep all candidate content; only pathological structural fragmentation is coalesced.
      current = this.scope(lexicalResources(), false);
      status += '; lexical passage limit: adjacent sections coalesced into bounded passages';
    }
    const authorized = new Map(current.passages.map(p => [p.id, p]));
    const previous = new Map(scope.passages.map(p => [p.id, p]));
    semantic = semantic.filter(c => authorized.get(c.passage_id)?.source_hash === previous.get(c.passage_id)?.source_hash);
    return { sources, items: rankPassages(sources, current.passages, lexical, semantic, task, effective, includeRules), retrieval: { requested: mode, effective, status } };
  }
  async search(query: string, mode?: RetrievalMode) {
    if (!query.trim() || query.length > 2000) throw new Error('Search requires 1–2000 characters.');
    if (mode && !['lexical', 'semantic', 'hybrid'].includes(mode)) throw new Error('Unknown retrieval mode');
    const ranked = await this.retrieve(query, mode, false);
    const originals = new Map(ranked.sources.filter(r => r.state === 'fresh').map(r => [`${r.path}\0${r.hash}`, r]));
    const results = [];
    for (const resource of ranked.items.slice(0, 10)) {
      const original = originals.get(`${resource.passage!.path}\0${resource.provenance.source_version}`);
      if (!original) throw new Error('Selected source version is unavailable');
      const excerpt = { ...original, ...resource, id: original.id, passage_id: resource.id, content: Array.from(resource.content).slice(0, 300).join(''), truncated: Array.from(resource.content).length > 300, retrieval: ranked.retrieval };
      if (Buffer.byteLength(JSON.stringify([...results, excerpt])) > 16000) break;
      results.push(excerpt);
    }
    return results;
  }
  async context(request: ContextRequest) {
    const parsed = contextRequestSchema.parse(request);
    const ranked = await this.retrieve(parsed.task, parsed.mode);
    return contextBroker(this.storage, this.project, request, ranked.sources, this.estimator, ranked, this.workspace?.workspace_id);
  }
  inspect(id: string) {
    this.assertBinding();
    const bundle = this.storage.context(this.project.project_id, id);
    if (!bundle) throw new Error('Context not found in this project.');
    if (bundle.workspace_id !== this.workspace?.workspace_id) throw new Error('Context not found in this workspace.');
    return bundle;
  }
  explain(id: string, verbose = false) {
    const bundle = this.inspect(id);
    return { context_id: id, historical: true, retrieval: bundle.retrieval, items: bundle.items.map(i => ({ id: i.id, source: i.provenance.origin, reasons: i.reasons })), ...(verbose ? { selection: this.storage.selection(this.project.project_id, id) } : {}) };
  }
  propose(input: unknown) {
    memoryCandidateSchema.parse(input);
    this.refresh();
    return this.storage.atomic(() => proposeMemory(this.storage, this.project, input, this.storage.resources(this.project.project_id), this.workspace?.workspace_id));
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
      provenance: { project_id: this.project.project_id, ...(this.workspace ? { workspace_id: this.workspace.workspace_id } : {}), origin: `agent:${parsed.from.agent}`, captured_at: new Date().toISOString(), source_version: parsed.from.session, trust: 'agent_observation' } };
    this.storage.saveHandoff(handoff);
    return handoff;
  }
  observe(input: unknown) {
    this.assertBinding();
    const parsed = observationSchema.parse(input);
    const observation = { ...parsed, id: `obs_${randomUUID()}`, project_id: this.project.project_id,
      provenance: { project_id: this.project.project_id, ...(this.workspace ? { workspace_id: this.workspace.workspace_id } : {}), origin: `agent:${parsed.agent}`, captured_at: new Date().toISOString(), source_version: parsed.session, trust: 'agent_observation' as const } };
    this.storage.saveObservation(observation);
    return observation;
  }
  /** Read-only startup index from persisted state. No sync, no semantic backend, no writes. */
  bootstrap(options: { budget?: number; now?: Date } = {}) {
    this.assertBinding();
    const sync = this.storage.syncState(this.project.project_id);
    return buildBootstrap({ project: this.project, ...(this.workspace ? { workspace: this.workspace } : {}), memories: this.storage.memories(this.project.project_id), handoffs: this.storage.handoffs(this.project.project_id), sources: this.scopedResources(), ...(sync ? { sync } : {}), ...options });
  }
  latestHandoff() { this.assertBinding(); return this.storage.handoffs(this.project.project_id).find(h => h.provenance.workspace_id === this.workspace?.workspace_id) ?? null; }
  handoff(id: string) {
    this.assertBinding();
    const handoff = this.storage.handoffs(this.project.project_id).find(h => h.id === id);
    if (!handoff) throw new Error('Handoff not found in this project.');
    return handoff;
  }
  doctor() { return this.storage.diagnose(); }
}
