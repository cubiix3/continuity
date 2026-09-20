import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ContextBundle, Handoff, Memory, Project, Provenance, Resource, StoragePort, SyncState } from '../../core/src/contracts.js';
import { migrate } from './migrations.js';

function decode<T>(row: Record<string, unknown>): T { return JSON.parse(String(row.data)) as T; }

export class SqliteStorage implements StoragePort {
  private readonly db: DatabaseSync;
  private closed = false;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path, { timeout: 5000, enableForeignKeyConstraints: true });
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec('PRAGMA journal_mode = WAL');
    try { migrate(this.db); } catch (error) { this.db.close(); throw error; }
  }
  private transaction<T>(action: () => T): T {
    if (this.db.isTransaction) return action();
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  atomic<T>(action: () => T): T { return this.transaction(action); }
  private provenance(id: string, provenance: Provenance) {
    this.db.prepare('INSERT OR REPLACE INTO provenance VALUES (?, ?, ?)').run(id, provenance.project_id, JSON.stringify(provenance));
  }
  projects(): Project[] { return this.db.prepare('SELECT data FROM projects ORDER BY root').all().map(row => decode<Project>(row)); }
  register(project: Project): Project {
    return this.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO projects VALUES (?, ?, ?)').run(project.project_id, project.root, JSON.stringify(project));
      const stored = decode<Project>(this.db.prepare('SELECT data FROM projects WHERE root = ?').get(project.root)!);
      this.db.prepare('INSERT OR IGNORE INTO namespaces VALUES (?, ?)').run(`project:${stored.project_id}`, stored.project_id);
      return stored;
    });
  }
  resources(projectId: string): Resource[] {
    return this.db.prepare('SELECT data FROM resources WHERE project_id = ? ORDER BY path, id').all(projectId).map(r => decode<Resource>(r));
  }
  replaceResources(projectId: string, incoming: Resource[], state: SyncState): void {
    if (incoming.some(r => r.project_id !== projectId || r.provenance.project_id !== projectId)) throw new Error('Resource scope mismatch.');
    this.transaction(() => {
      const current = this.resources(projectId);
      const byPath = new Map(incoming.map(r => [r.path, r]));
      this.db.prepare('DELETE FROM resource_fts WHERE project_id = ?').run(projectId);
      for (const old of current.filter(r => r.state === 'fresh')) {
        const next = byPath.get(old.path);
        if (next?.hash === old.hash) continue;
        const updated = { ...old, state: next ? 'superseded' : 'missing', content: '' };
        this.db.prepare('UPDATE resources SET state = ?, data = ? WHERE project_id = ? AND id = ?').run(updated.state, JSON.stringify(updated), projectId, old.id);
      }
      for (const next of incoming) {
        const old = current.find(r => r.path === next.path && r.hash === next.hash && r.state === 'fresh');
        const resource = old ?? next;
        this.db.prepare('INSERT OR REPLACE INTO resources VALUES (?, ?, ?, ?, ?)').run(resource.id, projectId, resource.path, resource.state, JSON.stringify(resource));
        this.db.prepare('INSERT INTO resource_fts VALUES (?, ?, ?)').run(resource.id, projectId, resource.content);
        this.provenance(resource.id, resource.provenance);
      }
      this.db.prepare('INSERT OR REPLACE INTO sync_state VALUES (?, ?)').run(projectId, JSON.stringify(state));
    });
  }
  search(projectId: string, query: string, limit: number): Resource[] {
    const tokens = query.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 40) ?? [];
    if (!tokens.length) return [];
    const match = tokens.map(t => `"${t}"`).join(' OR ');
    return this.db.prepare(`SELECT r.data FROM resource_fts f JOIN resources r ON r.id = f.id
      WHERE resource_fts MATCH ? AND f.project_id = ? AND r.project_id = ? AND r.state = 'fresh'
      ORDER BY bm25(resource_fts), r.path, r.id LIMIT ?`).all(match, projectId, projectId, Math.max(1, Math.min(limit, 100))).map(r => decode<Resource>(r));
  }
  memories(projectId: string): Memory[] { return this.db.prepare('SELECT data FROM memories WHERE project_id = ? ORDER BY id').all(projectId).map(r => decode<Memory>(r)); }
  saveMemory(memory: Memory): void {
    this.transaction(() => {
      const owner = this.db.prepare('SELECT project_id FROM memories WHERE id = ?').get(memory.id);
      if (owner && owner.project_id !== memory.project_id) throw new Error('Memory scope mismatch.');
      this.db.prepare('INSERT OR REPLACE INTO memories VALUES (?, ?, ?)').run(memory.id, memory.project_id, JSON.stringify(memory));
      this.db.prepare('INSERT INTO memory_revisions(memory_id, project_id, data) VALUES (?, ?, ?)').run(memory.id, memory.project_id, JSON.stringify(memory));
      this.provenance(memory.id, memory.provenance);
    });
  }
  handoffs(projectId: string): Handoff[] { return this.db.prepare('SELECT data FROM handoffs WHERE project_id = ? ORDER BY captured_at DESC, rowid DESC').all(projectId).map(r => decode<Handoff>(r)); }
  saveHandoff(handoff: Handoff): void {
    this.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO sessions VALUES (?, ?, ?)').run(handoff.from.session, handoff.project_id, handoff.from.agent);
      this.db.prepare('INSERT INTO handoffs VALUES (?, ?, ?, ?)').run(handoff.id, handoff.project_id, handoff.provenance.captured_at, JSON.stringify(handoff));
      this.provenance(handoff.id, handoff.provenance);
    });
  }
  saveContext(bundle: ContextBundle): void { this.db.prepare('INSERT INTO contexts VALUES (?, ?, ?)').run(bundle.context_id, bundle.project_id, JSON.stringify(bundle)); }
  context(projectId: string, id: string): ContextBundle | undefined {
    const row = this.db.prepare('SELECT data FROM contexts WHERE project_id = ? AND id = ?').get(projectId, id);
    return row ? decode<ContextBundle>(row) : undefined;
  }
  syncState(projectId: string): SyncState | undefined {
    const row = this.db.prepare('SELECT data FROM sync_state WHERE project_id = ?').get(projectId);
    return row ? decode<SyncState>(row) : undefined;
  }
  diagnose() {
    return { integrity: String(this.db.prepare('PRAGMA quick_check').get()?.quick_check), schema_version: Number(this.db.prepare('PRAGMA user_version').get()?.user_version), fts5: Number(this.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'resource_fts'").get()?.n) === 1 };
  }
  close() { if (!this.closed) { this.db.close(); this.closed = true; } }
}
