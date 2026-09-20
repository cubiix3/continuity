import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { projectSchema } from '../../core/src/contracts.js';
import type { ContextBundle, EmbeddingCache, RemoteResourceCache, Handoff, Memory, Observation, Project, Provenance, Resource, StoragePort, SyncState, SelectionAudit, Workspace } from '../../core/src/contracts.js';
import { migrate } from './migrations.js';

function decode<T>(row: Record<string, unknown>): T { return JSON.parse(String(row.data)) as T; }
function scoped<T>(row: Record<string, unknown>, projectId: string): T {
  const value = decode<T & { project_id: string; provenance?: Provenance }>(row);
  if (value.project_id !== projectId || (value.provenance && value.provenance.project_id !== projectId)) throw new Error('Corrupted record scope. Run continuity doctor.');
  return value;
}

export class SqliteStorage implements StoragePort {
  private readonly db: DatabaseSync;
  private closed = false;
  constructor(path: string, private readonly workspaceId = '') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path, { timeout: 5000, enableForeignKeyConstraints: true });
    if (path !== ':memory:') chmodSync(path, 0o600);
    try { this.db.exec('PRAGMA journal_mode = WAL'); migrate(this.db); } catch (error) { this.db.close(); throw error; }
  }
  private transaction<T>(action: () => T): T {
    if (this.db.isTransaction) return action();
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  atomic<T>(action: () => T): T { return this.transaction(action); }
  workspaces(projectId: string): Workspace[] {
    return this.db.prepare('SELECT * FROM workspaces WHERE project_id = ? ORDER BY root').all(projectId).map(r => ({ workspace_id: String(r.workspace_id), project_id: String(r.project_id), root: String(r.root) }));
  }
  registerWorkspace(workspace: Workspace): Workspace {
    return this.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM projects WHERE root = ?').get(workspace.root)) throw new Error('Workspace root is already registered as a project.');
      this.db.prepare('INSERT OR IGNORE INTO workspaces VALUES (?, ?, ?)').run(workspace.workspace_id, workspace.project_id, workspace.root);
      const result = this.workspaces(workspace.project_id).find(w => w.root === workspace.root);
      if (!result) throw new Error('Workspace is already bound to another project.');
      return result;
    });
  }
  remoteResourceCache(projectId: string): RemoteResourceCache {
    return {
      read: backend => this.db.prepare('SELECT e.* FROM semantic_resources e JOIN resources r ON r.id = e.resource_id WHERE e.project_id = ? AND e.backend = ? AND r.workspace_id = ?').all(projectId, backend, this.workspaceId).map(r => ({ passage_id: String(r.passage_id), resource_id: String(r.resource_id), source_hash: String(r.source_hash), uri: String(r.uri) })),
      replace: (backend, entries, complete = true) => this.transaction(() => {
        for (const e of entries) this.assertCurrentResource(projectId, e.resource_id, e.source_hash);
        if (complete) {
          const ids = new Set(entries.map(e => e.passage_id));
          for (const row of this.db.prepare('SELECT e.passage_id FROM semantic_resources e JOIN resources r ON r.id = e.resource_id WHERE e.project_id = ? AND e.backend = ? AND r.workspace_id = ?').all(projectId, backend, this.workspaceId)) {
            if (!ids.has(String(row.passage_id))) this.db.prepare('DELETE FROM semantic_resources WHERE project_id = ? AND backend = ? AND passage_id = ?').run(projectId, backend, String(row.passage_id));
          }
        }
        for (const e of entries) this.db.prepare(`INSERT INTO semantic_resources VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(project_id, backend, passage_id) DO UPDATE SET resource_id=excluded.resource_id, source_hash=excluded.source_hash, uri=excluded.uri
          WHERE semantic_resources.resource_id != excluded.resource_id OR semantic_resources.source_hash != excluded.source_hash OR semantic_resources.uri != excluded.uri`).run(projectId, backend, e.passage_id, e.resource_id, e.source_hash, e.uri);
      }),
    };
  }
  embeddingCache(projectId: string): EmbeddingCache {
    return {
      read: model => this.db.prepare('SELECT e.* FROM embeddings e JOIN resources r ON r.id = e.resource_id WHERE e.project_id = ? AND e.model = ? AND r.workspace_id = ? ORDER BY e.passage_id').all(projectId, model, this.workspaceId).map(row => {
        const bytes = Buffer.from(row.vector as Uint8Array); const dimensions = Number(row.dimensions);
        if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 8192 || bytes.length !== dimensions * 4) throw new Error('Corrupted embedding dimensions');
        return { passage_id: String(row.passage_id), resource_id: String(row.resource_id), source_hash: String(row.source_hash), hash: String(row.passage_hash), vector: Array.from({ length: dimensions }, (_, i) => bytes.readFloatLE(i * 4)) };
      }),
      replace: (model, entries, complete = true) => this.transaction(() => {
        for (const e of entries) this.assertCurrentResource(projectId, e.resource_id, e.source_hash);
        const ids = new Set(entries.map(e => e.passage_id));
        for (const row of complete ? this.db.prepare('SELECT e.passage_id FROM embeddings e JOIN resources r ON r.id = e.resource_id WHERE e.project_id = ? AND r.workspace_id = ?').all(projectId, this.workspaceId) : []) {
          if (!ids.has(String(row.passage_id))) this.db.prepare('DELETE FROM embeddings WHERE project_id = ? AND passage_id = ?').run(projectId, String(row.passage_id));
        }
        for (const e of entries) {
          if (!e.vector.length || e.vector.length > 8192 || e.vector.some(n => !Number.isFinite(n))) throw new Error('Invalid embedding vector');
          const bytes = Buffer.alloc(e.vector.length * 4); e.vector.forEach((n, i) => bytes.writeFloatLE(n, i * 4));
          this.db.prepare(`INSERT INTO embeddings VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(project_id, model, passage_id) DO UPDATE SET resource_id=excluded.resource_id, source_hash=excluded.source_hash, passage_hash=excluded.passage_hash, dimensions=excluded.dimensions, vector=excluded.vector
            WHERE embeddings.source_hash != excluded.source_hash OR embeddings.passage_hash != excluded.passage_hash OR embeddings.dimensions != excluded.dimensions`).run(projectId, model, e.passage_id, e.resource_id, e.source_hash, e.hash, e.vector.length, bytes);
        }
      }),
    };
  }
  private assertCurrentResource(projectId: string, id: string, hash: string) {
    const row = this.db.prepare("SELECT data FROM resources WHERE project_id = ? AND id = ? AND state = 'fresh' AND workspace_id = ?").get(projectId, id, this.workspaceId);
    if (!row || scoped<Resource>(row, projectId).hash !== hash) throw new Error('Sources changed during semantic indexing; run sync again.');
  }
  private provenance(id: string, provenance: Provenance) {
    this.db.prepare('INSERT OR REPLACE INTO provenance VALUES (?, ?, ?)').run(id, provenance.project_id, JSON.stringify(provenance));
  }
  projects(): Project[] { return this.db.prepare('SELECT * FROM projects ORDER BY root').all().map(row => {
    const project = projectSchema.parse(decode<Project>(row));
    if (project.project_id !== row.project_id || project.root !== row.root) throw new Error('Corrupted project identity. Run continuity doctor.');
    return project;
  }); }
  rebind(projectId: string, oldRoot: string, newRoot: string): Project {
    return this.transaction(() => {
      const project = this.projects().find(p => p.project_id === projectId && p.root === oldRoot);
      if (!project) throw new Error('Identity and previous canonical root do not match.');
      if (this.projects().some(p => p.root === newRoot) || this.db.prepare('SELECT 1 FROM workspaces WHERE root = ?').get(newRoot)) throw new Error('Destination is already registered.');
      const updated = { ...project, root: newRoot };
      this.db.prepare('UPDATE projects SET root = ?, data = ? WHERE project_id = ?').run(newRoot, JSON.stringify(updated), projectId);
      this.db.prepare('INSERT INTO project_rebindings(project_id, old_root, new_root, captured_at) VALUES (?, ?, ?, ?)').run(projectId, oldRoot, newRoot, new Date().toISOString());
      return updated;
    });
  }
  register(project: Project): Project {
    return this.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM workspaces WHERE root = ?').get(project.root)) throw new Error('Root is already registered as a workspace.');
      this.db.prepare('INSERT OR IGNORE INTO projects VALUES (?, ?, ?)').run(project.project_id, project.root, JSON.stringify(project));
      const stored = decode<Project>(this.db.prepare('SELECT data FROM projects WHERE root = ?').get(project.root)!);
      this.db.prepare('INSERT OR IGNORE INTO namespaces VALUES (?, ?)').run(`project:${stored.project_id}`, stored.project_id);
      return stored;
    });
  }
  resources(projectId: string): Resource[] {
    return this.db.prepare('SELECT data FROM resources WHERE project_id = ? AND workspace_id = ? ORDER BY path, id').all(projectId, this.workspaceId).map(r => {
      const resource = scoped<Resource>(r, projectId);
      if ((resource.provenance.workspace_id ?? '') !== this.workspaceId) throw new Error('Corrupted resource workspace.');
      return resource;
    });
  }
  replaceResources(projectId: string, incoming: Resource[], state: SyncState): void {
    if (incoming.some(r => r.project_id !== projectId || r.provenance.project_id !== projectId || (r.provenance.workspace_id ?? '') !== this.workspaceId)) throw new Error('Resource scope mismatch.');
    this.transaction(() => {
      const current = this.resources(projectId);
      const freshByPath = new Map(current.filter(r => r.state === 'fresh').map(r => [r.path, r]));
      const byPath = new Map(incoming.map(r => [r.path, r]));
      for (const old of current.filter(r => r.state === 'fresh')) {
        const next = byPath.get(old.path);
        if (next?.hash === old.hash) continue;
        const updated = { ...old, state: next ? 'superseded' : 'missing', content: '' };
        this.db.prepare('UPDATE resources SET state = ?, data = ? WHERE project_id = ? AND id = ?').run(updated.state, JSON.stringify(updated), projectId, old.id);
        this.db.prepare('DELETE FROM resource_fts WHERE project_id = ? AND id = ?').run(projectId, old.id);
        if (!next) this.db.prepare('DELETE FROM embeddings WHERE project_id = ? AND resource_id = ?').run(projectId, old.id);
      }
      for (const next of incoming) {
        const old = freshByPath.get(next.path);
        if (old?.hash === next.hash) continue;
        const resource = next;
        this.db.prepare('INSERT OR REPLACE INTO resources VALUES (?, ?, ?, ?, ?, ?)').run(resource.id, projectId, resource.path, resource.state, JSON.stringify(resource), this.workspaceId);
        this.db.prepare('INSERT INTO resource_fts VALUES (?, ?, ?)').run(resource.id, projectId, resource.content);
        this.provenance(resource.id, resource.provenance);
      }
      this.db.prepare('INSERT OR REPLACE INTO sync_state VALUES (?, ?, ?)').run(projectId, this.workspaceId, JSON.stringify(state));
    });
  }
  search(projectId: string, query: string, limit: number): Resource[] {
    const tokens = query.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 40) ?? [];
    if (!tokens.length) return [];
    const match = tokens.map(t => `"${t}"`).join(' OR ');
    return this.db.prepare(`SELECT r.data FROM resource_fts f JOIN resources r ON r.id = f.id
      WHERE resource_fts MATCH ? AND f.project_id = ? AND r.project_id = ? AND r.state = 'fresh' AND r.workspace_id = ?
      ORDER BY bm25(resource_fts), r.path, r.id LIMIT ?`).all(match, projectId, projectId, this.workspaceId, Math.max(1, Math.min(limit, 100))).map(r => scoped<Resource>(r, projectId));
  }
  memories(projectId: string): Memory[] { return this.db.prepare('SELECT data FROM memories WHERE project_id = ? ORDER BY id').all(projectId).map(r => scoped<Memory>(r, projectId)); }
  saveMemory(memory: Memory): void {
    this.transaction(() => {
      const owner = this.db.prepare('SELECT project_id FROM memories WHERE id = ?').get(memory.id);
      if (owner && owner.project_id !== memory.project_id) throw new Error('Memory scope mismatch.');
      this.db.prepare('INSERT OR REPLACE INTO memories VALUES (?, ?, ?)').run(memory.id, memory.project_id, JSON.stringify(memory));
      this.db.prepare('INSERT INTO memory_revisions(memory_id, project_id, data) VALUES (?, ?, ?)').run(memory.id, memory.project_id, JSON.stringify(memory));
      this.provenance(memory.id, memory.provenance);
    });
  }
  handoffs(projectId: string): Handoff[] { return this.db.prepare('SELECT data FROM handoffs WHERE project_id = ? ORDER BY captured_at DESC, rowid DESC').all(projectId).map(r => scoped<Handoff>(r, projectId)); }
  saveHandoff(handoff: Handoff): void {
    this.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO sessions VALUES (?, ?, ?, ?)').run(handoff.from.session, handoff.project_id, handoff.from.agent, handoff.provenance.captured_at);
      this.db.prepare('INSERT INTO handoffs VALUES (?, ?, ?, ?)').run(handoff.id, handoff.project_id, handoff.provenance.captured_at, JSON.stringify(handoff));
      this.provenance(handoff.id, handoff.provenance);
    });
  }
  saveContext(bundle: ContextBundle, selection?: SelectionAudit): void {
    this.transaction(() => {
      this.db.prepare('INSERT INTO contexts VALUES (?, ?, ?, ?)').run(bundle.context_id, bundle.project_id, JSON.stringify(bundle), new Date().toISOString());
      if (selection) this.db.prepare('INSERT INTO context_selection VALUES (?, ?, ?)').run(bundle.context_id, bundle.project_id, JSON.stringify({ project_id: bundle.project_id, ...selection }));
    });
  }
  selection(projectId: string, id: string): SelectionAudit | undefined {
    const row = this.db.prepare('SELECT data FROM context_selection WHERE project_id = ? AND id = ?').get(projectId, id);
    return row ? scoped<SelectionAudit>(row, projectId) : undefined;
  }
  saveObservation(observation: Observation): void {
    this.transaction(() => {
      this.db.prepare('INSERT INTO observations VALUES (?, ?, ?)').run(observation.id, observation.project_id, JSON.stringify(observation));
      this.db.prepare('INSERT OR IGNORE INTO sessions VALUES (?, ?, ?, ?)').run(observation.session, observation.project_id, observation.agent, observation.provenance.captured_at);
      this.provenance(observation.id, observation.provenance);
    });
  }
  context(projectId: string, id: string): ContextBundle | undefined {
    const row = this.db.prepare('SELECT data FROM contexts WHERE project_id = ? AND id = ?').get(projectId, id);
    return row ? scoped<ContextBundle>(row, projectId) : undefined;
  }
  syncState(projectId: string): SyncState | undefined {
    const row = this.db.prepare('SELECT data FROM sync_state WHERE project_id = ? AND workspace_id = ?').get(projectId, this.workspaceId);
    return row ? decode<SyncState>(row) : undefined;
  }
  diagnose() {
    const problems: string[] = [];
    if (this.db.prepare('PRAGMA foreign_key_check').all().length) problems.push('orphaned foreign-key records');
    if (Number(this.db.prepare('SELECT count(*) AS n FROM provenance WHERE id NOT IN (SELECT id FROM resources UNION SELECT id FROM memories UNION SELECT id FROM handoffs UNION SELECT id FROM observations)').get()?.n)) problems.push('orphaned provenance records');
    if (Number(this.db.prepare('SELECT count(*) AS n FROM embeddings e LEFT JOIN resources r ON r.id = e.resource_id AND r.project_id = e.project_id WHERE r.id IS NULL OR e.dimensions < 1 OR e.dimensions > 8192 OR length(e.vector) != e.dimensions * 4').get()?.n)) problems.push('corrupted embedding reference or dimensions');
    if (Number(this.db.prepare('SELECT count(*) AS n FROM semantic_resources e LEFT JOIN resources r ON r.id = e.resource_id AND r.project_id = e.project_id WHERE r.id IS NULL').get()?.n)) problems.push('corrupted remote resource reference');
    for (const table of ['projects', 'resources', 'memories', 'memory_revisions', 'handoffs', 'observations', 'provenance', 'contexts', 'context_selection']) {
      for (const row of this.db.prepare(`SELECT project_id, data FROM ${table}`).all()) {
        try {
          const value = scoped<Record<string, unknown>>(row, String(row.project_id));
          if (table === 'resources' && value.state === 'fresh') {
            if (typeof value.content !== 'string' || createHash('sha256').update(value.content).digest('hex') !== value.hash || typeof value.path !== 'string' || /(^|[\\/])\.\.([\\/]|$)|^[\\/]|:/.test(value.path)) problems.push('corrupted source reference');
          }
        } catch { problems.push(`corrupted ${table} record`); }
      }
    }
    try { this.projects(); } catch { problems.push('corrupted project identity'); }
    let fts5 = false;
    try {
      this.db.prepare('SELECT count(*) FROM resource_fts').get(); fts5 = true;
      if (Number(this.db.prepare("SELECT count(*) AS n FROM resource_fts f LEFT JOIN resources r ON r.id = f.id AND r.project_id = f.project_id WHERE r.id IS NULL OR r.state != 'fresh'").get()?.n)) problems.push('orphaned FTS references');
    } catch { problems.push('FTS5 unavailable'); }
    return { integrity: String(this.db.prepare('PRAGMA quick_check').get()?.quick_check), schema_version: Number(this.db.prepare('PRAGMA user_version').get()?.user_version), fts5, problems: [...new Set(problems)] };
  }
  retention(projectId: string, now: string) {
    const definitions = [
      { name: 'sources', table: 'resources', condition: "state != 'fresh' AND julianday(json_extract(data, '$.provenance.captured_at')) < julianday(?) - 30", policy: 'Inactive source versions: 30 days; current sources retained.' },
      { name: 'context history', table: 'contexts', condition: 'julianday(created_at) < julianday(?) - 30', policy: 'Context history: 30 days.' },
      { name: 'observations', table: 'observations', condition: "julianday(json_extract(data, '$.provenance.captured_at')) < julianday(?) - 14", policy: 'Observations: 14 days.' },
      { name: 'handoffs', table: 'handoffs', condition: "julianday(captured_at) < julianday(?) - 90 AND id != (SELECT id FROM handoffs WHERE project_id = ? ORDER BY captured_at DESC, rowid DESC LIMIT 1)", policy: 'Handoffs: 90 days; latest always retained.' },
      { name: 'memory revisions', table: 'memory_revisions', condition: '', policy: 'Explicit review required; never automatically eligible.' },
      { name: 'sessions', table: 'sessions', condition: 'julianday(created_at) < julianday(?) - 90 AND id NOT IN (SELECT json_extract(data, \'$.from.session\') FROM handoffs WHERE project_id = sessions.project_id UNION SELECT json_extract(data, \'$.session\') FROM observations WHERE project_id = sessions.project_id)', policy: 'Sessions without handoff/observation references: 90 days.' },
    ];
    return definitions.map(d => ({ name: d.name, policy: d.policy,
      records: Number(this.db.prepare(`SELECT count(*) AS n FROM ${d.table} WHERE project_id = ?`).get(projectId)?.n),
      eligible: d.condition ? Number(this.db.prepare(`SELECT count(*) AS n FROM ${d.table} WHERE project_id = ? AND ${d.condition}`).get(...(d.name === 'handoffs' ? [projectId, now, projectId] : [projectId, now]))?.n) : 0,
    }));
  }
  close() { if (!this.closed) { this.db.close(); this.closed = true; } }
}
