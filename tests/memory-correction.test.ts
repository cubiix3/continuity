import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { openContinuity } from '../packages/sdk/src/index.js';
import { createLocalServer } from '../packages/server/src/index.js';
import { MAX_CORRECTIONS, renderBootstrap } from '../packages/core/src/index.js';
import type { Memory } from '../packages/core/src/index.js';

// Real CLI hook processes and several proposals per test; Windows CI runners need more than vitest's 5 s default.
vi.setConfig({ testTimeout: 60_000 });
const cli = resolve('dist/packages/cli/src/index.js');
let root: string, a: string, b: string, feature: string, home: string, host: ReturnType<typeof openContinuity>;
const git = (path: string, ...args: string[]) => execFileSync('git', ['-C', path, ...args], { stdio: 'pipe' });
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'continuity correction ü ')); a = join(root, 'alpha'); b = join(root, 'beta'); feature = join(root, 'alpha-feature'); home = join(root, 'home');
  mkdirSync(a); mkdirSync(b);
  writeFileSync(join(a, 'README.md'), '# Alpha\nThe locale loader rejects blank lines in locale files.\n'); writeFileSync(join(b, 'README.md'), '# Beta\n');
  git(a, 'init'); git(a, 'config', 'user.name', 'Fixture'); git(a, 'config', 'user.email', 'fixture@example.invalid'); git(a, 'add', '.'); git(a, 'commit', '-m', 'Initial');
  host = openContinuity(home); host.init(a, 'Alpha'); host.init(b, 'Beta'); await host.project(a).sync(); await host.project(b).sync();
});
afterEach(() => { host.close(); rmSync(root, { recursive: true, force: true }); });

const agent = (session: string) => ({ agent: 'Claude Code', session });
const stale = { key: 'service.token-location', kind: 'experience' as const, text: 'The service token is read from config/token.json at startup.' };
const fixed = 'The service token is read from the SERVICE_TOKEN environment variable since the config refactor.';
const shown = (...ids: string[]) => ({ visible: new Set(ids) });
const byId = (id: string, path = a) => host.project(path).memories().find(m => m.id === id)!;
const revisions = (id: string) => host.inspection.page(host.project(a).status().project_id, '', 'revisions', 50, 0, id).items.sort((x, y) => x.cursor - y.cursor).map(i => i.record as Memory);

test('an explicit correction of a shown agent observation supersedes it and keeps the full history', () => {
  const client = host.project(a);
  const old = client.propose({ ...stale, from: agent('s1') });
  const correction = client.propose({ ...stale, text: fixed, from: agent('s2') }, shown(old.id));
  expect(correction).toMatchObject({ outcome: 'superseded', status: 'persist', superseded_ids: [old.id], provenance: { trust: 'agent_observation' } });
  const replaced = byId(old.id);
  expect(replaced).toMatchObject({ status: 'superseded', superseded_by: correction.id, text: stale.text, from: agent('s1') });
  expect(Date.parse(replaced.superseded_at!)).toBeGreaterThan(0);
  expect(replaced.reason).toContain('Claude Code'); expect(replaced.reason).toContain('s2');
  // History keeps both versions of the old record: old and new id, text, trust, agent/session, reason and time.
  expect(revisions(old.id).map(r => r.status)).toEqual(['persist', 'superseded']);
  expect(revisions(correction.id)).toEqual([expect.objectContaining({ id: correction.id, text: fixed, from: agent('s2'), status: 'persist' })]);
  // The next start shows the correction, and no conflict.
  const start = host.bootstrap(a)!;
  expect(start.attention).toMatchObject({ conflicts: 0, held: 0 });
  expect(start.memories.find(m => m.key === stale.key)).toMatchObject({ id: correction.id });
  expect(renderBootstrap(start)).not.toContain('conflict');
});

test('a correction replaces nothing unless every condition holds', async () => {
  const client = host.project(a);
  const unchanged = (id: string, status: Memory['status']) => expect(byId(id).status).toBe(status);
  const cases: [string, () => { old: string; status: Memory['status']; proposal: ReturnType<typeof client.propose> }][] = [
    ['not shown to the session', () => {
      const old = client.propose({ ...stale, key: 'case.unseen', from: agent('s1') }).id;
      return { old, status: 'needs_attention', proposal: client.propose({ ...stale, key: 'case.unseen', text: fixed, from: agent('s2') }, shown('mem_00000000-0000-0000-0000-000000000000')) };
    }],
    ['no correction requested', () => {
      const old = client.propose({ ...stale, key: 'case.plain', from: agent('s1') }).id;
      return { old, status: 'needs_attention', proposal: client.propose({ ...stale, key: 'case.plain', text: fixed, from: agent('s2') }) };
    }],
    ['human-reviewed', () => {
      const old = client.propose({ ...stale, key: 'case.human' }).id;
      host.review(a, old, 'accepted', 'Maintainer');
      return { old, status: 'accepted', proposal: client.propose({ ...stale, key: 'case.human', text: fixed, from: agent('s2') }, shown(old)) };
    }],
    ['source-backed', () => {
      const old = client.propose({ key: 'case.source', kind: 'decision', text: 'The locale loader rejects blank lines in locale files.', source_path: 'README.md' }).id;
      return { old, status: 'persist', proposal: client.propose({ key: 'case.source', kind: 'decision', text: 'The locale loader accepts blank lines in locale files.', from: agent('s2') }, shown(old)) };
    }],
    ['more than one claim with the key', () => {
      const first = client.propose({ ...stale, key: 'case.many', from: agent('s1') }).id;
      client.propose({ ...stale, key: 'case.many', text: 'The service token is read from a vault at startup, never from disk.', from: agent('s3') });
      return { old: first, status: 'needs_attention', proposal: client.propose({ ...stale, key: 'case.many', text: fixed, from: agent('s2') }, shown(first)) };
    }],
    ['an active claim beside a held one', () => {
      const old = client.propose({ ...stale, key: 'case.beside', from: agent('s1') }).id;
      expect(client.propose({ ...stale, key: 'case.beside', text: 'The README says the token is read from disk.', source_path: 'README.md', from: agent('s3') }).outcome).toBe('quarantined');
      expect(byId(old).status).toBe('persist');
      return { old, status: 'needs_attention', proposal: client.propose({ ...stale, key: 'case.beside', text: fixed, from: agent('s2') }, shown(old)) };
    }],
    ['a source path the source does not prove', () => {
      const old = client.propose({ ...stale, key: 'case.unproven', from: agent('s1') }).id;
      return { old, status: 'persist', proposal: client.propose({ ...stale, key: 'case.unproven', text: fixed, source_path: 'README.md', from: agent('s2') }, shown(old)) };
    }],
    ['routine output', () => {
      const old = client.propose({ ...stale, key: 'case.routine', from: agent('s1') }).id;
      return { old, status: 'persist', proposal: client.propose({ ...stale, key: 'case.routine', text: 'Tests passed after the token change was made.', from: agent('s2') }, shown(old)) };
    }],
    ['no attribution', () => {
      const old = client.propose({ ...stale, key: 'case.anonymous', from: agent('s1') }).id;
      return { old, status: 'persist', proposal: client.propose({ ...stale, key: 'case.anonymous', text: fixed }, shown(old)) };
    }],
  ];
  for (const [name, setup] of cases) {
    const { old, status, proposal } = setup();
    expect(proposal.outcome, name).not.toBe('superseded'); expect(proposal.superseded_ids, name).toBeUndefined();
    unchanged(old, status);
  }
  // Another workspace's observation, even when shown.
  git(a, 'worktree', 'add', '-b', 'feature', feature);
  const other = host.workspace(a, feature); await other.sync();
  const theirs = other.propose({ ...stale, key: 'case.workspace', from: agent('w1') });
  expect(client.propose({ ...stale, key: 'case.workspace', text: fixed, from: agent('s2') }, shown(theirs.id)).outcome).toBe('quarantined');
  // Another project's memory id is meaningless here: the key is resolved in this project only.
  const foreign = host.project(b).propose({ ...stale, key: 'case.foreign', from: agent('b1') });
  expect(client.propose({ ...stale, key: 'case.foreign', text: fixed, from: agent('s2') }, shown(foreign.id)).outcome).toBe('persisted');
  expect(byId(foreign.id, b).status).toBe('persist');
  // A shown id of a different key never lets a correction reach this key.
  const elsewhere = client.propose({ ...stale, key: 'case.elsewhere', from: agent('s1') });
  const target = client.propose({ ...stale, key: 'case.target', from: agent('s1') });
  expect(client.propose({ ...stale, key: 'case.target', text: fixed, from: agent('s2') }, shown(elsewhere.id)).outcome).toBe('quarantined');
  expect(byId(elsewhere.id).status).toBe('persist'); expect(byId(target.id).status).toBe('needs_attention');
});

test(`one call applies at most ${MAX_CORRECTIONS} corrections`, () => {
  const client = host.project(a);
  const olds = Array.from({ length: MAX_CORRECTIONS + 1 }, (_, i) => client.propose({ ...stale, key: `mass.key-${i}`, from: agent('s1') }).id);
  const visible = shown(...olds);
  const results = client.proposeAll(olds.map((_, i) => ({ ...stale, key: `mass.key-${i}`, text: fixed, from: agent('s2') })), olds.map(() => visible));
  expect(results.map(r => r instanceof Error ? 'error' : r.outcome)).toEqual([...Array(MAX_CORRECTIONS).fill('superseded'), 'quarantined']);
});

test('agent-facing proposals cannot ask for a correction: Core, MCP stdio and local HTTP reject the field', async () => {
  const client = host.project(a);
  const old = client.propose({ ...stale, from: agent('s1') });
  expect(() => client.propose({ ...stale, text: fixed, from: agent('s2'), corrects: true })).toThrow();
  expect(() => client.propose({ ...stale, text: fixed, from: agent('s2'), visible: [old.id] })).toThrow();
  const attempt = { ...stale, text: fixed, from: agent('s2'), corrects: true };
  const mcp = new Client({ name: 'correction-test', version: '1.0.0' });
  await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [cli, '--home', home, '--project', a, 'mcp'], stderr: 'pipe' }));
  try { expect((await mcp.callTool({ name: 'continuity_memory_propose', arguments: attempt })).isError).toBe(true); }
  finally { await mcp.close(); }
  const token = 'correction-test-token-'.repeat(2), server = createLocalServer(host.project(a), token);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/v1/memory/propose`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(attempt) });
    expect(response.status).toBe(400);
  } finally { await new Promise(done => server.close(done)); }
  expect(client.memories().filter(m => m.key === stale.key).map(m => [m.id, m.status])).toEqual([[old.id, 'persist']]);
});

test('forgetting one side of an agent-only conflict leaves the other active; human or source sides never release a claim', () => {
  const client = host.project(a);
  // The issue: a correction without the flag quarantined both; forgetting the stale side resolves it.
  const old = client.propose({ ...stale, from: agent('s1') }), next = client.propose({ ...stale, text: fixed, from: agent('s2') });
  expect([byId(old.id).status, byId(next.id).status]).toEqual(['needs_attention', 'needs_attention']);
  expect(host.bootstrap(a)!.attention).toMatchObject({ conflicts: 1, conflict_keys: [stale.key] });
  client.forget(old.id);
  expect(byId(next.id)).toMatchObject({ status: 'persist', reason: expect.stringContaining('forgotten') });
  expect(host.bootstrap(a)!.attention).toMatchObject({ conflicts: 0, held: 0 });
  expect(renderBootstrap(host.bootstrap(a)!)).not.toContain('conflict');
  // Forgetting the correction instead restores the original.
  const one = client.propose({ ...stale, key: 'undo.key', from: agent('s1') }), two = client.propose({ ...stale, key: 'undo.key', text: fixed, from: agent('s2') });
  client.forget(two.id); expect(byId(one.id).status).toBe('persist');
  // With two contradicting claims left, it stays a conflict.
  const x = client.propose({ ...stale, key: 'three.key', from: agent('s1') });
  client.propose({ ...stale, key: 'three.key', text: fixed, from: agent('s2') });
  client.propose({ ...stale, key: 'three.key', text: 'The service token is read from a vault at startup, never from disk.', from: agent('s3') });
  client.forget(x.id);
  expect(client.memories().filter(m => m.key === 'three.key' && m.status === 'needs_attention')).toHaveLength(2);
  // A human-reviewed side never releases the claim it holds back.
  const human = client.propose({ ...stale, key: 'human.key' }); host.review(a, human.id, 'accepted', 'Maintainer');
  const held = client.propose({ ...stale, key: 'human.key', text: fixed, from: agent('s2') });
  client.forget(human.id); expect(byId(held.id).status).toBe('needs_attention');
  // Nor does an agent observation a human accepted, and such a memory is never corrected by an agent.
  const first = client.propose({ ...stale, key: 'reviewed.key', from: agent('s1') }), second = client.propose({ ...stale, key: 'reviewed.key', text: fixed, from: agent('s2') });
  host.review(a, second.id, 'accepted', 'Maintainer');
  expect(client.propose({ ...stale, key: 'reviewed.key', text: 'The service token is read from a vault at startup, never from disk.', from: agent('s3') }, shown(second.id)).outcome).toBe('quarantined');
  expect(byId(second.id).status).toBe('accepted');
  expect(byId(first.id).status).toBe('needs_attention');
  const kept = client.propose({ ...stale, key: 'accepted.key', from: agent('s1') }), approved = client.propose({ ...stale, key: 'accepted.key', text: fixed, from: agent('s2') });
  host.review(a, approved.id, 'accepted', 'Maintainer');
  client.forget(approved.id);
  expect(byId(kept.id).status).toBe('needs_attention');
  // Neither does a source-backed side.
  const source = client.propose({ key: 'source.key', kind: 'decision', text: 'The locale loader rejects blank lines in locale files.', source_path: 'README.md' });
  const claim = client.propose({ key: 'source.key', kind: 'decision', text: 'The locale loader accepts blank lines in locale files.', from: agent('s2') });
  client.forget(source.id); expect(byId(claim.id).status).toBe('needs_attention');
});

type Provider = 'claude' | 'codex';
const hookEnv = () => {
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE_CODE_|^CLAUDECODE$|^CONTINUITY_AUTOSAVE$|^CODEX_(DAEMON_SHUTDOWN_SOCKET|CI|THREAD_ID|SESSION_ID)$/.test(k)));
  return { ...env, CONTINUITY_AUTOSAVE: '1' };
};
const run = (provider: Provider, event: 'session-start' | 'tool-use' | 'stop', input: unknown) =>
  spawnSync(process.execPath, ['--no-warnings', cli, '--home', home, 'integrate', provider, event], { input: JSON.stringify(input), encoding: 'utf8', windowsHide: true, env: hookEnv() });
/** One provider session: optionally the startup context, then an edited turn whose final answer carries the save line. */
function turn(provider: Provider, id: string, memories: unknown[], start = true) {
  const context = start ? run(provider, 'session-start', { session_id: id, cwd: a, hook_event_name: 'SessionStart', source: 'startup' }).stdout : '';
  run(provider, 'tool-use', { session_id: id, cwd: a, tool_name: provider === 'claude' ? 'Edit' : 'apply_patch' });
  const stop = run(provider, 'stop', { session_id: id, cwd: a, stop_hook_active: false, last_assistant_message: `Done.\n\n[continuity-save]: <${JSON.stringify({ memories, handoff: null })}>` });
  return { context, stop: stop.stdout };
}

test.each(['claude', 'codex'] as const)('%s: a session corrects a stale lesson it was shown, with no command', (provider) => {
  const client = host.project(a);
  const old = client.propose({ ...stale, from: agent('earlier') });
  const { context, stop } = turn(provider, `${provider}-fix`, [{ key: stale.key, kind: 'experience', text: fixed, corrects: true }]);
  expect(context).toContain(stale.key); expect(stop).toBe('');
  expect(byId(old.id)).toMatchObject({ status: 'superseded' });
  const current = client.memories().find(m => m.key === stale.key && m.status === 'persist')!;
  expect(current).toMatchObject({ text: fixed, from: { agent: provider === 'claude' ? 'Claude Code' : 'Codex', session: `${provider}-fix` } });
  expect(renderBootstrap(host.bootstrap(a)!)).not.toContain('conflict');
  // The session state holds memory ids only.
  const dir = join(home, 'hooks', 'autosave');
  const seen = readdirSync(dir).filter(f => f.endsWith('.seen.json')).map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')) as unknown);
  expect(seen).toEqual([[old.id]]);
});

test('without the startup context, or without the flag, a same-key save stays quarantined', () => {
  const client = host.project(a);
  const old = client.propose({ ...stale, from: agent('earlier') });
  // The session never saw the memory: its ids were never recorded.
  turn('claude', 'unseen', [{ key: stale.key, kind: 'experience', text: fixed, corrects: true }], false);
  expect(byId(old.id).status).toBe('needs_attention');
  const other = client.propose({ ...stale, key: 'flag.key', from: agent('earlier') });
  // Shown, but the save does not say it corrects.
  turn('claude', 'no-flag', [{ key: 'flag.key', kind: 'experience', text: fixed }]);
  expect(byId(other.id).status).toBe('needs_attention');
});
