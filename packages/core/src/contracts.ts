import { z } from 'zod';

export const projectSchema = z.object({
  project_id: z.string(), name: z.string(), identity_version: z.literal(1), root: z.string(),
});
export type Project = z.infer<typeof projectSchema>;
export interface Workspace { workspace_id: string; project_id: string; root: string }
export type ContextKind = 'source' | 'rule' | 'decision' | 'memory' | 'experience' | 'working_context' | 'handoff' | 'observation';
export type Trust = 'authoritative' | 'verified' | 'derived' | 'agent_observation' | 'untrusted';
export interface Provenance {
  project_id: string;
  workspace_id?: string;
  origin: string;
  captured_at: string;
  source_version: string;
  trust: Trust;
}
export interface Resource {
  id: string;
  project_id: string;
  path: string;
  hash: string;
  content: string;
  kind: 'source' | 'rule';
  state: 'fresh' | 'stale' | 'missing' | 'superseded';
  provenance: Provenance;
}
export const memoryCandidateSchema = z.object({
  key: z.string().trim().min(1).max(120),
  text: z.string().trim().min(10).max(2000),
  kind: z.enum(['rule', 'decision', 'memory', 'experience']),
  source_path: z.string().min(1).max(500).optional(),
  from: z.object({ agent: z.string().trim().min(1).max(100), session: z.string().trim().min(1).max(100) }).strict().optional(),
}).strict();
export type MemoryCandidate = z.infer<typeof memoryCandidateSchema>;
export interface Memory extends MemoryCandidate {
  id: string;
  project_id: string;
  status: 'persist' | 'reject' | 'needs_attention' | 'forgotten' | 'proposed' | 'accepted' | 'rejected' | 'superseded';
  reason: string;
  provenance: Provenance;
  review?: { by: string; at: string; decision: 'accepted' | 'rejected' };
  superseded_by?: string;
}
export type MemoryProposal = Memory & { outcome: 'persisted' | 'rejected' | 'quarantined' | 'duplicate' | 'superseded' | 'pending'; superseded_ids?: string[] };
export const observationSchema = z.object({ text: z.string().min(1).max(4000), agent: z.string().min(1).max(100), session: z.string().min(1).max(100) }).strict();
export interface Observation extends z.infer<typeof observationSchema> { id: string; project_id: string; provenance: Provenance }
const shortText = z.string().max(2000);
const textList = z.array(shortText).max(50);
export const handoffInputSchema = z.object({
  from: z.object({ agent: z.string().min(1).max(100), session: z.string().min(1).max(100) }).strict(),
  task: z.object({ goal: z.string().min(1).max(2000), status: z.enum(['in_progress', 'blocked', 'done']) }).strict(),
  completed: textList,
  remaining: textList,
  decisions: textList,
  files_changed: textList,
  risks: textList,
  recommended_next_action: shortText,
}).strict().refine(value => Buffer.byteLength(JSON.stringify(value)) <= 60000, 'Handoff exceeds 60,000 UTF-8 bytes.');
export type HandoffInput = z.infer<typeof handoffInputSchema>;
export interface Handoff extends HandoffInput {
  schema_version: 1;
  id: string;
  project_id: string;
  provenance: Provenance;
}
export const contextRequestSchema = z.object({
  task: z.string().trim().min(1).max(2000),
  role: z.enum(['implementation', 'reviewer', 'planning']).default('implementation'),
  budget: z.number().int().min(512).max(32000).default(6000),
  provider_model_hint: z.string().max(100).optional(),
  mode: z.enum(['lexical', 'semantic', 'hybrid']).optional(),
}).strict();
export type ContextRequest = z.input<typeof contextRequestSchema>;
export interface ContextItem {
  id: string;
  kind: ContextKind;
  content: string;
  provenance: Provenance;
  reasons: string[];
  passage?: { path: string; start_line: number; end_line: number };
}
export interface ContextBundle {
  schema_version: 1;
  context_id: string;
  project_id: string;
  workspace_id?: string;
  role: string;
  retrieval?: { requested: RetrievalMode; effective: RetrievalMode; status: string };
  items: ContextItem[];
  budget: { requested: number; used: number; unit: 'utf8_bytes'; estimated_tokens?: number; provider_model_hint?: string };
}
export interface SyncState { at: string; files: number; bytes: number }
export interface TokenEstimator { estimate(text: string, modelHint?: string): number }
export interface Diagnostics { integrity: string; schema_version: number; fts5: boolean; problems: string[] }
export interface RetentionClass { name: string; records: number; eligible: number; policy: string }
export interface SelectionAudit {
  candidates: number;
  entries: { id: string; source: string; outcome: 'included' | 'duplicate' | 'budget'; reasons: string[] }[];
}

/** Trusted host port; never exposed to an agent adapter. Every operation is scoped. */
export interface StoragePort {
  atomic<T>(action: () => T): T;
  projects(): Project[];
  workspaces(projectId: string): Workspace[];
  registerWorkspace(workspace: Workspace): Workspace;
  register(project: Project): Project;
  rebind(projectId: string, oldRoot: string, newRoot: string): Project;
  resources(projectId: string): Resource[];
  replaceResources(projectId: string, resources: Resource[], state: SyncState): void;
  search(projectId: string, query: string, limit: number): Resource[];
  memories(projectId: string): Memory[];
  saveMemory(memory: Memory): void;
  handoffs(projectId: string): Handoff[];
  saveHandoff(handoff: Handoff): void;
  saveObservation(observation: Observation): void;
  saveContext(bundle: ContextBundle, selection?: SelectionAudit): void;
  selection(projectId: string, id: string): SelectionAudit | undefined;
  context(projectId: string, id: string): ContextBundle | undefined;
  syncState(projectId: string): SyncState | undefined;
  diagnose(): Diagnostics;
  retention(projectId: string, now: string): RetentionClass[];
  close(): void;
}

export type InspectionKind = 'handoffs' | 'memories' | 'contexts' | 'sources' | 'revisions';
export type InspectionRecord = Handoff | Memory | ContextBundle | Resource;
export interface InspectionPage { items: { record: InspectionRecord; cursor: number; created_at?: string }[]; next: number | null }
/** Optional host inspection port; existing StoragePort implementers remain compatible. */
export interface InspectionStoragePort extends Pick<StoragePort, 'projects' | 'workspaces' | 'selection'> {
  browse(projectId: string, workspaceId: string, kind: InspectionKind, limit: number, after: number, id?: string, status?: string, sourceFilter?: string): InspectionPage;
  /** `workspaces` is the project total: the primary checkout plus registered workspaces. */
  inspectionStats(projectId: string, workspaceId: string): { sources: number; memories: number; pending: number; active: number; conflicts: number; handoffs: number; contexts: number; workspaces: number };
}

export interface SourcePort { scan(project: Project): Resource[] }
export type RetrievalMode = 'lexical' | 'semantic' | 'hybrid';
export interface Passage {
  id: string; project_id: string; resource_id: string; source_hash: string;
  hash: string; path: string; text: string; start_line: number; end_line: number;
}
export interface SemanticScope { project_id: string; passages: readonly Passage[] }
export interface SemanticCandidate { passage_id: string; similarity: number }
export interface SemanticHealth { status: 'ready' | 'disabled' | 'unavailable' | 'incomplete'; reason: string; model?: string; dimensions?: number; indexed?: number; total?: number }
/** Receives only the host-authorized snapshot. Candidates cannot grant authority. */
export interface SemanticRetrievalPort {
  index(scope: SemanticScope, signal: AbortSignal): Promise<SemanticHealth>;
  search(scope: SemanticScope, task: string, signal: AbortSignal): Promise<readonly SemanticCandidate[]>;
  health(scope: SemanticScope, signal: AbortSignal): Promise<SemanticHealth>;
}
export interface Embedding { passage_id: string; source_hash: string; resource_id: string; hash: string; vector: number[] }
/** A host-bound cache capability, not an agent API. Model keys include revisions. */
export interface EmbeddingCache {
  read(model: string): Embedding[];
  replace(model: string, entries: readonly Embedding[], complete?: boolean): void;
}
export interface RemoteResource { passage_id: string; resource_id: string; source_hash: string; uri: string }
export interface RemoteResourceCache {
  read(backend: string): RemoteResource[];
  replace(backend: string, entries: readonly RemoteResource[], complete?: boolean): void;
}
