import type { DatabaseSync } from 'node:sqlite';

const migrations = [String.raw`
CREATE TABLE projects (project_id TEXT PRIMARY KEY, root TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
CREATE TABLE namespaces (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(project_id));
CREATE TABLE resources (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(project_id),
  path TEXT NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL
);
CREATE INDEX resources_project ON resources(project_id, state);
CREATE VIRTUAL TABLE resource_fts USING fts5(id UNINDEXED, project_id UNINDEXED, content, tokenize='unicode61');
CREATE TABLE memories (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(project_id), data TEXT NOT NULL);
CREATE TABLE memory_revisions (revision INTEGER PRIMARY KEY, memory_id TEXT NOT NULL REFERENCES memories(id), project_id TEXT NOT NULL REFERENCES projects(project_id), data TEXT NOT NULL);
CREATE TABLE sessions (id TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES projects(project_id), agent TEXT NOT NULL, PRIMARY KEY(project_id, id));
CREATE TABLE handoffs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(project_id), captured_at TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE observations (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(project_id), data TEXT NOT NULL);
CREATE TABLE sync_state (project_id TEXT PRIMARY KEY REFERENCES projects(project_id), data TEXT NOT NULL);
CREATE TABLE provenance (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(project_id), data TEXT NOT NULL);
CREATE TABLE contexts (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(project_id), data TEXT NOT NULL);
`, String.raw`
CREATE TABLE project_rebindings (sequence INTEGER PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(project_id), old_root TEXT NOT NULL, new_root TEXT NOT NULL, captured_at TEXT NOT NULL);
ALTER TABLE contexts ADD COLUMN created_at TEXT;
UPDATE contexts SET created_at = CURRENT_TIMESTAMP;
ALTER TABLE sessions ADD COLUMN created_at TEXT;
UPDATE sessions SET created_at = CURRENT_TIMESTAMP;
`, String.raw`
CREATE TABLE embeddings (
  project_id TEXT NOT NULL REFERENCES projects(project_id), model TEXT NOT NULL,
  passage_id TEXT NOT NULL, resource_id TEXT NOT NULL REFERENCES resources(id),
  source_hash TEXT NOT NULL, passage_hash TEXT NOT NULL, dimensions INTEGER NOT NULL,
  vector BLOB NOT NULL, PRIMARY KEY(project_id, model, passage_id)
);
CREATE TABLE semantic_resources (
  project_id TEXT NOT NULL REFERENCES projects(project_id), backend TEXT NOT NULL,
  passage_id TEXT NOT NULL, resource_id TEXT NOT NULL REFERENCES resources(id),
  source_hash TEXT NOT NULL, uri TEXT NOT NULL, PRIMARY KEY(project_id, backend, passage_id)
);
CREATE TABLE context_selection (id TEXT PRIMARY KEY REFERENCES contexts(id), project_id TEXT NOT NULL REFERENCES projects(project_id), data TEXT NOT NULL);
`];

export function migrate(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
    if (version > migrations.length) throw new Error('Database schema is newer than this Continuity version. Upgrade Continuity.');
    for (let i = version; i < migrations.length; i++) {
      db.exec(migrations[i]!);
      db.exec(`PRAGMA user_version = ${i + 1}`);
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
