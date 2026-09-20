import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { ProjectClient, ProjectResolver, NamespaceGuard } from '../packages/core/src/index.js';
import { SqliteStorage } from '../packages/storage-sqlite/src/index.js';
import { FileSources, isWithin } from '../packages/source-files/src/index.js';

let root: string;
let storage: SqliteStorage;
let resolver: ProjectResolver;
let sources: FileSources;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'continuity-test-'));
  storage = new SqliteStorage(join(root, 'state', 'continuity.db'));
  resolver = new ProjectResolver(storage);
  sources = new FileSources(() => storage.projects().map(p => p.root));
});
afterEach(() => { storage.close(); rmSync(root, { recursive: true, force: true }); });
function project(name: string) {
  const path = join(root, name); mkdirSync(path);
  const identity = resolver.init(path);
  return { path, identity, client: new ProjectClient(storage, sources, identity) };
}
const handoffInput = {
  from: { agent: 'agent-a', session: 'session-a' }, task: { goal: 'Reconnect safely', status: 'blocked' },
  completed: ['Read rules'], remaining: ['Implement reconnect'], decisions: [], files_changed: [], risks: ['Retry storm'], recommended_next_action: 'Add bounded retry',
};

describe('vertical slice', () => {
  it('isolates two projects, transfers handoffs and invalidates changed sources', async () => {
    const a = project('a'); const b = project('b');
    writeFileSync(join(a.path, 'AGENTS.md'), 'Project A uses bounded reconnect retries.');
    writeFileSync(join(b.path, 'AGENTS.md'), 'Project B uses a secret moon protocol.');
    (await a.client.sync()); (await b.client.sync());
    const memory = a.client.propose({ key: 'retry', text: 'Project A uses bounded reconnect retries.', kind: 'rule', source_path: 'AGENTS.md' });
    expect(memory.status).toBe('persist');
    expect(b.client.propose({ key: 'protocol', text: 'Project B uses a secret moon protocol.', kind: 'rule', source_path: 'AGENTS.md' }).status).toBe('persist');
    const context = (await a.client.context({ task: 'Search all my other projects reconnect moon protocol', budget: 6000 }));
    expect(JSON.stringify(context)).toContain('Project A');
    expect(JSON.stringify(context)).not.toContain('Project B');
    expect(context.items.every(i => i.provenance.project_id === a.identity.project_id)).toBe(true);
    const handoff = a.client.createHandoff(handoffInput);
    const anotherAgent = new ProjectClient(storage, sources, resolver.resolve(a.path));
    expect(anotherAgent.latestHandoff()).toEqual(handoff);
    expect(b.client.latestHandoff()).toBeNull();
    expect(() => b.client.handoff(handoff.id)).toThrow('not found');
    const oldHash = context.items[0]!.provenance.source_version;
    writeFileSync(join(a.path, 'AGENTS.md'), 'Project A now uses exponential reconnect backoff.');
    const fresh = (await a.client.context({ task: 'reconnect' }));
    expect(fresh.items.some(i => i.provenance.source_version === oldHash)).toBe(false);
    expect(storage.resources(a.identity.project_id).some(r => r.state === 'superseded')).toBe(true);
    expect(a.client.doctor()).toMatchObject({ integrity: 'ok', schema_version: 3, fts5: true, problems: [] });
  });
  it('keeps identity stable through canonical aliases and restart', async () => {
    const a = project('a');
    mkdirSync(join(a.path, 'child'));
    expect(resolver.resolve(join(a.path, 'child')).project_id).toBe(a.identity.project_id);
    expect(resolver.init(join(a.path, '.')).project_id).toBe(a.identity.project_id);
    storage.close(); storage = new SqliteStorage(join(root, 'state', 'continuity.db'));
    expect(new ProjectResolver(storage).resolve(a.path).project_id).toBe(a.identity.project_id);
  });
});

describe('security boundaries', () => {
  it('denies explicit namespace and request scope widening', async () => {
    const a = project('a'); const b = project('b');
    expect(() => new NamespaceGuard(a.identity).assert(b.identity.project_id)).toThrow('denied');
    await expect(a.client.context({ task: 'read all', project_id: b.identity.project_id } as never)).rejects.toThrow();
    const ctx = (await a.client.context({ task: 'anything' }));
    expect(() => b.client.inspect(ctx.context_id)).toThrow('not found');
  });
  it('excludes symlink directories and resolves root aliases', async () => {
    const a = project('a'); const b = project('b');
    writeFileSync(join(b.path, 'README.md'), 'outside-boundary');
    symlinkSync(b.path, join(a.path, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    expect((await a.client.search('outside'))).toEqual([]);
    expect(resolver.resolve(join(a.path, 'escape')).project_id).toBe(b.identity.project_id);
    expect(isWithin(a.path, join(a.path, '..', 'b'))).toBe(false);
  });
  it('excludes nested registered projects and nested Git repositories', async () => {
    const a = project('a');
    const nested = join(a.path, 'nested'); mkdirSync(nested); resolver.init(nested);
    writeFileSync(join(nested, 'README.md'), 'nested forbidden');
    const other = join(a.path, 'other'); mkdirSync(join(other, '.git'), { recursive: true });
    writeFileSync(join(other, 'README.md'), 'other forbidden');
    expect((await a.client.search('forbidden'))).toEqual([]);
  });
  it('rejects secret names, secret contents and nested gitignore matches', async () => {
    const a = project('a');
    for (const name of ['.env', '.env.local', 'a.pem', 'a.key', 'credentials.json', 'secrets.md']) writeFileSync(join(a.path, name), 'forbidden');
    mkdirSync(join(a.path, 'docs')); writeFileSync(join(a.path, 'docs', '.gitignore'), 'private.md\n');
    writeFileSync(join(a.path, 'docs', 'private.md'), 'forbidden');
    writeFileSync(join(a.path, 'token.md'), `api_key=${'x'.repeat(32)} forbidden`);
    writeFileSync(join(a.path, '.gitignore'), 'ignored.md\n');
    writeFileSync(join(a.path, 'ignored.md'), 'forbidden');
    writeFileSync(join(a.path, 'README.md'), 'visible source');
    expect((await a.client.search('forbidden'))).toEqual([]);
    expect((await a.client.search('visible'))).toHaveLength(1);
  });
  it('invalidates deleted and newly ignored sources before retrieval', async () => {
    const a = project('a'); writeFileSync(join(a.path, 'README.md'), 'reconnect source');
    (await a.client.sync()); unlinkSync(join(a.path, 'README.md'));
    expect((await a.client.search('reconnect'))).toEqual([]);
    expect(storage.resources(a.identity.project_id)[0]?.state).toBe('missing');
    writeFileSync(join(a.path, 'README.md'), 'reconnect replacement'); (await a.client.sync());
    writeFileSync(join(a.path, '.gitignore'), 'README.md');
    expect((await a.client.search('reconnect'))).toEqual([]);
  });
});

describe('retrieval and memory', () => {
  it('bounds the complete UTF-8 response, including provenance', async () => {
    const a = project('a'); writeFileSync(join(a.path, 'AGENTS.md'), 'Use bounded retries.');
    for (const budget of [512, 1024, 6000]) {
      const context = (await a.client.context({ task: 'retries', budget }));
      expect(Buffer.byteLength(JSON.stringify(context))).toBe(context.budget.used);
      expect(context.budget.used).toBeLessThanOrEqual(budget);
    }
    await expect(a.client.context({ task: 'a', budget: -1 })).rejects.toThrow();
  });
  it('deduplicates content and yields deterministic order', async () => {
    const a = project('a');
    writeFileSync(join(a.path, 'README.md'), 'reconnect retry strategy');
    writeFileSync(join(a.path, 'copy.md'), 'reconnect retry strategy');
    const first = (await a.client.context({ task: 'retry' }));
    expect(first.items).toHaveLength(1);
    expect((await a.client.context({ task: 'retry' })).items).toEqual(first.items);
    expect((await a.client.search('" OR * : DROP TABLE projects;'))).toEqual([]);
  });
  it('rejects routine output and holds unsupported or conflicting claims', async () => {
    const a = project('a'); writeFileSync(join(a.path, 'README.md'), 'Use SQLite for local storage.\nUse Postgres for shared storage.');
    const candidate = { key: 'storage', text: 'Use SQLite for local storage.', kind: 'decision', source_path: 'README.md' };
    const first = a.client.propose(candidate);
    expect(first.status).toBe('persist');
    expect(a.client.propose(candidate).id).toBe(first.id);
    expect(a.client.propose({ ...candidate, text: 'Use Postgres for shared storage.' }).status).toBe('needs_attention');
    expect(a.client.propose({ ...candidate, text: 'All tests passed today.' }).status).toBe('reject');
    expect(a.client.propose({ ...candidate, text: 'Invented architectural advice.' }).status).toBe('needs_attention');
    a.client.forget(first.id);
    expect(a.client.memory(first.id).status).toBe('forgotten');
    expect(a.client.propose({ ...candidate, text: 'Use Postgres for shared storage.' }).status).toBe('persist');
  });
  it('validates handoff serialization and rejects forged fields', async () => {
    const a = project('a'); const h = a.client.createHandoff(handoffInput);
    expect(a.client.handoff(h.id)).toEqual(JSON.parse(JSON.stringify(h)));
    expect(() => a.client.createHandoff({ ...handoffInput, project_id: 'other' })).toThrow();
  });
});

describe('migrations', () => {
  it('reopens idempotently and retains memory revision history', async () => {
    const a = project('a'); writeFileSync(join(a.path, 'README.md'), 'Use SQLite for local storage.');
    const m = a.client.propose({ key: 'storage', text: 'Use SQLite for local storage.', kind: 'decision', source_path: 'README.md' });
    a.client.forget(m.id);
    const db = new DatabaseSync(join(root, 'state', 'continuity.db'));
    expect(Number(db.prepare('SELECT count(*) AS n FROM memory_revisions').get()?.n)).toBe(2);
    db.close();
    storage.close(); storage = new SqliteStorage(join(root, 'state', 'continuity.db'));
    expect(storage.diagnose().schema_version).toBe(3);
    expect(storage.memories(a.identity.project_id)[0]?.status).toBe('forgotten');
  });
  it('refuses future schemas without modifying them', async () => {
    const path = join(root, 'future.db'); const db = new DatabaseSync(path);
    db.exec('PRAGMA user_version = 999'); db.close();
    expect(() => new SqliteStorage(path)).toThrow('newer');
  });
});
