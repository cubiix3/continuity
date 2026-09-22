import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openContinuity } from '../packages/sdk/src/index.js';
import { SqliteStorage } from '../packages/storage-sqlite/src/index.js';
import type { Memory } from '../packages/core/src/contracts.js';
import { DatabaseSync } from 'node:sqlite';

let root: string, path: string, home: string, host: ReturnType<typeof openContinuity>;
const from = { agent: 'generic', session: 'fixture-session' };
const lesson = { key: 'reconnect-budget', text: 'Reconnect cancellation must release the repository retry budget before the next provider session.', kind: 'decision', from };
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'continuity-auto-memory-')); path = join(root, 'project'); home = join(root, 'home'); mkdirSync(path); host = openContinuity(home); host.init(path); });
afterEach(() => { host.close(); rmSync(root, { recursive: true, force: true }); });
const client = () => host.project(path);
const revisions = (id: string) => host.inspection.page(host.projects()[0]!.project_id, '', 'revisions', 50, 0, id).items;

test('durable agent lessons activate with bounded session provenance, dedupe across sessions and remain relevant', async () => {
  const m = client().propose(lesson); expect(m).toMatchObject({ status: 'persist', outcome: 'persisted', provenance: { trust: 'agent_observation', origin: 'agent:generic', source_version: from.session } });
  expect(m).not.toHaveProperty('review'); expect(m.from).toEqual(from);
  expect(client().propose({ ...lesson, from: { ...from, session: 'second' } })).toMatchObject({ id: m.id, outcome: 'duplicate' }); expect(revisions(m.id)).toHaveLength(1);
  expect((await client().context({ task: 'Reconnect cancellation' })).items.some(i => i.id === m.id)).toBe(true);
  expect((await client().context({ task: 'The CSS typography for the website' })).items.some(i => i.id === m.id)).toBe(false);
  expect(() => client().propose({ ...lesson, text: 'x'.repeat(2001) })).toThrow();
  expect(() => client().propose({ ...lesson, from: { agent: '', session: 's' } })).toThrow();
});

test('routine, temporary, generic and explicitly speculative candidates never activate', () => {
  for (const text of ['All tests passed today.', 'The build succeeded yesterday.', 'I changed file src/index.ts.', 'temporary debug: timer = 7', 'TODO: finish the task tomorrow', 'Always write clean code.', 'Maybe the reconnect handler leaks state.']) {
    expect(client().propose({ ...lesson, text })).toMatchObject({ status: 'reject', outcome: 'rejected' });
  }
});

test('agent relevance normalizes separators consistently for task, key and text, including Unicode', async () => {
  for (const [key, text, queries] of [
    ['retry_budget', 'Provider retry budget is persisted across reconnect.', ['retry_budget', 'retry budget', 'retry-budget']],
    ['render_state', 'The graphics lifecycle survives provider replacement.', ['render_state', 'render state', 'render-state']],
    ['speicher_größe', 'The registry preserves its bounded storage allocation.', ['speicher_größe', 'speicher größe', 'speicher-größe']],
    ['lease', 'Provider retry_budget is persisted across reconnect.', ['retry_budget', 'retry budget', 'retry-budget']],
  ] as const) {
    const memory = client().propose({ ...lesson, key, text });
    for (const task of queries) expect((await client().context({ task })).items.some(item => item.id === memory.id), task).toBe(true);
    expect((await client().context({ task: 'Typography website stylesheet' })).items.some(item => item.id === memory.id)).toBe(false);
  }
});

test('quarantined source duplicates keep rows and revisions stable but changed evidence is reevaluated', () => {
  const other = 'Reconnect cancellation retains its provider retry budget.';
  writeFileSync(join(path, 'a.md'), lesson.text); writeFileSync(join(path, 'b.md'), other);
  client().propose({ ...lesson, source_path: 'a.md' });
  const b = client().propose({ ...lesson, text: other, source_path: 'b.md' });
  expect(b.status).toBe('needs_attention');
  const before = client().memories().map(m => ({ id: m.id, revisions: revisions(m.id).length }));
  const duplicate = client().propose({ ...lesson, text: other, source_path: 'b.md' });
  expect(duplicate).toMatchObject({ id: b.id, status: 'needs_attention', outcome: 'duplicate' });
  expect(client().memories().map(m => ({ id: m.id, revisions: revisions(m.id).length }))).toEqual(before);
  // The same excerpt in a changed source is a new evidence version, not a duplicate.
  writeFileSync(join(path, 'b.md'), `${other}\nAdditional current context.`);
  const changed = client().propose({ ...lesson, text: other, source_path: 'b.md' });
  expect(changed.id).not.toBe(b.id); expect(changed.outcome).not.toBe('duplicate'); expect(changed.status).toBe('needs_attention');
  expect(changed.provenance.source_version).not.toBe(b.provenance.source_version);
  // Removing the contradictory source must still allow the unchanged surviving evidence to resolve.
  unlinkSync(join(path, 'a.md'));
  const resolved = client().propose({ ...lesson, text: other, source_path: 'b.md' });
  expect(resolved).toMatchObject({ id: changed.id, status: 'persist', outcome: 'superseded' });
  expect(client().memories().filter(m => m.status === 'persist')).toHaveLength(1);
});

test('two agent claims quarantine both, preserve revisions and never use latest-wins', async () => {
  const first = client().propose(lesson);
  const other = client().propose({ ...lesson, text: 'Reconnect cancellation must retain the retry budget across every provider session.' });
  expect(other).toMatchObject({ status: 'needs_attention', outcome: 'quarantined' }); expect(client().memory(first.id).status).toBe('needs_attention');
  expect(revisions(first.id)).toHaveLength(2);
  expect(client().propose(lesson)).toMatchObject({ id: first.id, status: 'needs_attention', outcome: 'duplicate' });
  expect((await client().context({ task: 'Reconnect cancellation' })).items).toEqual([]);
  const third = client().propose({ ...lesson, text: 'Reconnect cancellation instead resets every stored provider retry budget.' }); expect(third.status).toBe('needs_attention');
});

test('current exact source resolves quarantined agent claims and supersedes them atomically', async () => {
  const first = client().propose(lesson); const second = client().propose({ ...lesson, text: 'Reconnect cancellation retains its provider retry budget.' });
  writeFileSync(join(path, 'README.md'), lesson.text);
  const m = client().propose({ ...lesson, source_path: 'README.md' });
  expect(m).toMatchObject({ status: 'persist', outcome: 'superseded', provenance: { trust: 'derived', origin: 'README.md' } });
  expect(m.superseded_ids?.sort()).toEqual([first.id, second.id].sort());
  for (const old of [first, second]) expect(client().memory(old.id)).toMatchObject({ status: 'superseded', superseded_by: m.id });
  expect(revisions(first.id)).toHaveLength(3); expect(revisions(m.id)).toHaveLength(1);
  expect(host.doctor().integrity).toBe('ok');
});

test('a lower-trust observation cannot replace current source or human reviewed data', () => {
  writeFileSync(join(path, 'README.md'), lesson.text); const original = client().propose({ ...lesson, source_path: 'README.md' });
  const conflict = client().propose({ ...lesson, text: 'Reconnect should retain provider state forever.' }); expect(conflict.status).toBe('needs_attention'); expect(client().memory(original.id).status).toBe('persist');
  expect(client().propose({ ...lesson, source_path: 'README.md' })).toMatchObject({ id: original.id, outcome: 'superseded' }); expect(client().memory(conflict.id).status).toBe('superseded');
  const human = client().propose({ key: 'manual', kind: 'decision', text: 'Human-authored repository convention remains stable.' }); host.review(path, human.id, 'accepted', 'Maintainer');
  expect(client().propose({ ...lesson, key: 'manual' }).status).toBe('needs_attention'); expect(client().memory(human.id).status).toBe('accepted');
});

test('source changes replace stale claims, but two current contradictory excerpts remain quarantined', async () => {
  writeFileSync(join(path, 'README.md'), lesson.text); const first = client().propose({ ...lesson, source_path: 'README.md' });
  const next = 'Reconnect cancellation now releases all provider handles before retrying.'; writeFileSync(join(path, 'README.md'), next);
  expect((await client().context({ task: 'Reconnect' })).items.some(i => i.id === first.id)).toBe(false);
  const second = client().propose({ ...lesson, text: next, source_path: 'README.md' }); expect(second.outcome).toBe('superseded');
  writeFileSync(join(path, 'other.md'), lesson.text); const disputed = client().propose({ ...lesson, source_path: 'other.md' }); expect(disputed.status).toBe('needs_attention'); expect(client().memory(second.id).status).toBe('needs_attention');
  unlinkSync(join(path, 'other.md')); expect((await client().context({ task: 'Reconnect' })).items.some(i => i.id === disputed.id)).toBe(false);
});

test('current rules and source outrank observations even when the agent labels a lesson as rule', async () => {
  writeFileSync(join(path, 'AGENTS.md'), 'Reconnect changes must preserve the existing project boundary.');
  writeFileSync(join(path, 'README.md'), 'Reconnect transport uses the current provider registry.');
  const m = client().propose({ ...lesson, kind: 'rule' });
  const items = (await client().context({ task: 'Reconnect', budget: 6000 })).items;
  expect(items.findIndex(i => i.id === m.id)).toBeGreaterThan(items.findIndex(i => i.provenance.origin === 'README.md'));
  expect(items[0]?.provenance.origin).toBe('AGENTS.md'); expect(items.at(-1)?.provenance.trust).toBe('agent_observation');
});

test('agents cannot forge authority, source proof, project scope or human review', () => {
  for (const extra of [{ trust: 'verified' }, { project_id: 'foreign' }, { status: 'accepted' }, { review: { by: 'human' } }, { provenance: { trust: 'authoritative' } }]) expect(() => client().propose({ ...lesson, ...extra })).toThrow();
  const fake = client().propose({ ...lesson, source_path: '../foreign/README.md' }); expect(fake).toMatchObject({ status: 'needs_attention', provenance: { trust: 'untrusted' } });
  expect(client().propose({ ...lesson, key: 'label-is-not-authority', from: { agent: 'human-reviewed', session: 'verified' } }).provenance.trust).toBe('agent_observation');
  const other = join(root, 'other'); mkdirSync(other); host.init(other); const foreign = host.project(other).propose(lesson); expect(() => client().forget(foreign.id)).toThrow('not found');
});

test('existing accepted and persisted records survive; old proposed rows never bulk activate', async () => {
  const id = host.projects()[0]!.project_id;
  const store = new SqliteStorage(join(home, 'continuity.db'));
  try { for (const status of ['accepted', 'persist', 'proposed', 'rejected', 'needs_attention'] as const) store.saveMemory({ id: `mem_old-${status}`, project_id: id, key: `legacy-${status}`, kind: 'memory', text: `Reconnect legacy ${status} record is retained.`, status, reason: 'Legacy fixture', provenance: { project_id: id, origin: 'legacy', captured_at: '2025-01-01T00:00:00Z', source_version: 'unverified', trust: 'untrusted' } }); } finally { store.close(); }
  host.close(); host = openContinuity(home);
  const ids = (await client().context({ task: 'Reconnect' })).items.map(i => i.id);
  expect(ids).toContain('mem_old-accepted'); expect(ids).toContain('mem_old-persist'); expect(ids).not.toContain('mem_old-proposed'); expect(client().memory('mem_old-proposed').status).toBe('proposed');
  client().propose(lesson); expect(client().memory('mem_old-proposed').status).toBe('proposed'); expect(host.doctor().schema_version).toBe(4);
});

test('inspection counts and origin filters distinguish active, quarantined and legacy records', () => {
  const id = host.projects()[0]!.project_id; client().propose(lesson); client().propose({ ...lesson, key: 'legacy', from: undefined });
  writeFileSync(join(path, 'README.md'), 'The repository uses bounded storage transactions.'); client().propose({ key: 'storage', kind: 'decision', text: 'The repository uses bounded storage transactions.', source_path: 'README.md' });
  expect(host.inspection.stats(id, '')).toMatchObject({ memories: 3, active: 2, pending: 1, conflicts: 0 });
  const list = (status: string) => host.inspection.page(id, '', 'memories', 20, 0, undefined, status).items.map(i => i.record as Memory);
  expect(list('agent_learned')).toHaveLength(1); expect(list('source_backed')).toHaveLength(1); expect(list('proposed')).toHaveLength(1);
  const unproven = client().propose({ ...lesson, key: 'unproven', source_path: 'missing.md' }); host.review(path, unproven.id, 'accepted', 'Fixture reviewer');
  expect(list('source_backed')).toHaveLength(1); // Human approval does not invent a source proof.
  client().propose({ ...lesson, text: 'Reconnect cancellation retains state until the next process.' }); expect(host.inspection.stats(id, '')).toMatchObject({ active: 2, conflicts: 2 });
  expect(list('conflicts')).toHaveLength(2); expect(list('active')).toHaveLength(2);
});

test('replacement failure rolls back prior claim changes and their revisions', () => {
  const first = client().propose(lesson);
  const next = 'Reconnect cancellation releases all registry handles before replacement.'; writeFileSync(join(path, 'README.md'), next);
  const db = new DatabaseSync(join(home, 'continuity.db'));
  try {
    db.exec("CREATE TRIGGER fail_memory_fixture BEFORE INSERT ON memories WHEN json_extract(NEW.data, '$.source_path') = 'README.md' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
    expect(() => client().propose({ ...lesson, text: next, source_path: 'README.md' })).toThrow('fixture failure');
    expect(client().memory(first.id).status).toBe('persist'); expect(revisions(first.id)).toHaveLength(1);
  } finally { db.exec('DROP TRIGGER fail_memory_fixture'); db.close(); }
});
