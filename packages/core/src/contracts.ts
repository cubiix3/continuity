import { z } from 'zod';

export const projectSchema = z.object({
  project_id: z.string(), name: z.string(), identity_version: z.literal(1), root: z.string(),
});
export type Project = z.infer<typeof projectSchema>;
export type ContextKind = 'source' | 'rule' | 'decision' | 'memory' | 'experience' | 'working_context' | 'handoff' | 'observation';
export type Trust = 'authoritative' | 'verified' | 'derived' | 'agent_observation' | 'untrusted';
export interface Provenance {
  project_id: string;
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
}).strict();
export type MemoryCandidate = z.infer<typeof memoryCandidateSchema>;
export interface Memory extends MemoryCandidate {
  id: string;
  project_id: string;
  status: 'persist' | 'reject' | 'needs_attention' | 'forgotten' | 'proposed' | 'accepted' | 'rejected' | 'superseded';
  reason: string;
  provenance: Provenance;
  review?: { by: string; at: string; decision: 'accepted' | 'rejected' };
}
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
}).strict();
export type ContextRequest = z.input<typeof contextRequestSchema>;
export interface ContextItem {
  id: string;
  kind: ContextKind;
  content: string;
  provenance: Provenance;
  reasons: string[];
}
export interface ContextBundle {
  schema_version: 1;
  context_id: string;
  project_id: string;
  role: string;
  items: ContextItem[];
  budget: { requested: number; used: number; unit: 'utf8_bytes'; estimated_tokens?: number; provider_model_hint?: string };
}
export interface SyncState { at: string; files: number; bytes: number }
export interface TokenEstimator { estimate(text: string, modelHint?: string): number }
export interface Diagnostics { integrity: string; schema_version: number; fts5: boolean; problems: string[] }
export interface RetentionClass { name: string; records: number; eligible: number; policy: string }

/** Trusted host port; never exposed to an agent adapter. Every operation is scoped. */
export interface StoragePort {
  atomic<T>(action: () => T): T;
  projects(): Project[];
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
  saveContext(bundle: ContextBundle): void;
  context(projectId: string, id: string): ContextBundle | undefined;
  syncState(projectId: string): SyncState | undefined;
  diagnose(): Diagnostics;
  retention(projectId: string, now: string): RetentionClass[];
  close(): void;
}

export interface SourcePort { scan(project: Project): Resource[] }
/** Optional future ranking input. It never selects or expands the project scope. */
export interface SemanticRetrievalPort {
  rank(projectId: string, task: string, candidateIds: readonly string[]): Promise<readonly string[]>;
}
