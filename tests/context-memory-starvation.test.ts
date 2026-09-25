import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openContinuity } from '../packages/sdk/src/index.js';
import type { ContextBundle, ContextItem } from '../packages/core/src/contracts.js';

// A crowded project: three current rule files and many small documents that mention Windows, pnpm, worktrees and
// removal in passing. Small passages leave no budget gap large enough for a memory once sources have filled it.
const CROWDED: Record<string, string> = {
  'AGENTS.md': '# Working on Relay\n\nGit and current project files are the source of truth. Agents are clients.\n\n## Boundaries\n\n- Keep changes small and test real paths where affected.\n- Never delete a registered workspace from agent code; ask the host to remove it.\n- Canonical paths, symlink exclusion and secret exclusion are security invariants.\n- Do not add a second build or retrieval system.\n',
  'packages/app/AGENTS.md': '# App package\n\n- The app package owns the command line only.\n- Keep command output stable; scripts parse it.\n- Run the package tests before changing flags.\n',
  'docs/AGENTS.md': '# Documentation\n\n- Write short sentences and name exact commands.\n- Keep examples runnable on Windows and POSIX.\n',
  'docs/worktree-removal.md': '# Removal\n\nTo remove an old pnpm worktree on Windows, delete node_modules with fs.rmSync first.\n',
};
const topics = ['registration', 'snapshots', 'freshness', 'rebinding', 'health', 'diagnostics', 'retention', 'relocation', 'imports', 'locking'];
for (const [i, topic] of topics.entries()) {
  CROWDED[`docs/workspaces-${topic}.md`] = `# Workspace ${topic}\n\n` + Array.from({ length: 8 }, (_, j) =>
    `## ${topic} ${j + 1}\n\nEach worktree is a workspace with its own snapshot. On Windows the old path is compared without case. pnpm installs are ignored. Removing a registration never removes files (${i}.${j}).\n`).join('\n');
}
const TASK = 'Remove the old pnpm worktree on Windows';
const FROM = { agent: 'Claude Code', session: 'session-worktree' };
/** Strong: covers remove, pnpm, worktree and windows (4 of the 5 meaningful task terms). */
const AGENT = { key: 'windows.pnpm-worktree-removal', kind: 'experience' as const, from: FROM,
  text: 'On Windows, git worktree remove and PowerShell or cmd deletion fail on a pnpm worktree because of long paths and node_modules junctions; remove it with fs.rmSync(path, { recursive: true, force: true }) and then run git worktree prune.' };
const HUMAN = { key: 'windows.worktree-policy', kind: 'decision' as const,
  text: 'Maintainers remove an old pnpm worktree on Windows only after its branch is merged; the removal is logged in the release notes.' };
const BACKED_TEXT = 'To remove an old pnpm worktree on Windows, delete node_modules with fs.rmSync first.';
/** Weak: covers only one of the five meaningful task terms. */
const WEAK = { key: 'terminal.font', kind: 'experience' as const, text: 'The Windows terminal renders the dashboard table with a narrow monospace font.', from: FROM };
const SHARE = 0.25;

let root: string, path: string, home: string, host: ReturnType<typeof openContinuity>;
const write = (base: string, files: Record<string, string>) => {
  for (const [file, text] of Object.entries(files)) { mkdirSync(dirname(join(base, file)), { recursive: true }); writeFileSync(join(base, file), text); }
};
const project = (name: string, files: Record<string, string>) => { const dir = join(root, name); mkdirSync(dir); write(dir, files); host.init(dir, name); return dir; };
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'continuity context memory ')); home = join(root, 'home'); host = openContinuity(home); path = project('relay', CROWDED); });
afterEach(() => { host.close(); rmSync(root, { recursive: true, force: true }); });
const client = (dir = path) => host.project(dir);
const human = (dir = path, input: Record<string, unknown> = HUMAN) => { const m = client(dir).propose(input); host.review(dir, m.id, 'accepted', 'Maintainer'); return m; };
const backed = () => client().propose({ key: 'windows.worktree-note', kind: 'decision', text: BACKED_TEXT, source_path: 'docs/worktree-removal.md' });
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const ids = (bundle: ContextBundle) => bundle.items.map(i => i.id);
const isSource = (i: ContextItem) => i.kind === 'source' || i.kind === 'rule';
async function context(budget: number, dir = path, task = TASK) {
  const bundle = await client(dir).context({ task, budget });
  // Byte budget: the whole serialized bundle, measured in UTF-8, never above the request.
  expect(bytes(bundle)).toBe(bundle.budget.used);
  expect(bundle.budget.used).toBeLessThanOrEqual(budget);
  const audit = client(dir).explain(bundle.context_id, true).selection!;
  const outcome = (id: string) => audit.entries.find(e => e.id === id)?.outcome ?? 'not a candidate';
  return { bundle, audit, outcome };
}
/** Presentation order is unchanged: rules, then sources in rank order, then memories, then the handoff. */
function expectRankOrder(bundle: ContextBundle, audit: { entries: { id: string }[] }) {
  const rank = new Map(audit.entries.map((e, i) => [e.id, i]));
  const positions = bundle.items.map(i => rank.get(i.id)!);
  expect(positions).toEqual([...positions].sort((x, y) => x - y));
  const lastSource = bundle.items.findLastIndex(isSource), firstMemory = bundle.items.findIndex(i => !isSource(i));
  if (firstMemory >= 0) expect(firstMemory).toBeGreaterThan(lastSource);
}

test.each([6000, 20000])('A. a strongly relevant agent lesson survives a crowded source context at %i bytes', async budget => {
  const baseline = await context(budget);
  expect(baseline.audit.entries.filter(e => e.outcome === 'budget').length, 'sources alone exceed the budget').toBeGreaterThan(20);
  const lesson = client().propose(AGENT);
  expect(lesson).toMatchObject({ status: 'persist', provenance: { trust: 'agent_observation' } });
  const { bundle, audit, outcome } = await context(budget);
  expect(outcome(lesson.id)).toBe('included');
  expect(bundle.items.at(-1)).toMatchObject({ id: lesson.id, kind: 'experience' });
  expect(bundle.items.at(-1)!.reasons).toEqual(expect.arrayContaining(['agent-learned observation; not source truth or project policy', 'strong task match: 4/5 terms; bounded memory share']));
  expectRankOrder(bundle, audit);
  // Every baseline rule stays in place; only a few low-ranked source passages make room.
  const rules = baseline.bundle.items.filter(i => i.kind === 'rule').map(i => i.id);
  expect(ids(bundle).slice(0, rules.length)).toEqual(rules);
  const displaced = baseline.bundle.items.filter(isSource).length - bundle.items.filter(isSource).length;
  expect(displaced).toBeGreaterThanOrEqual(0); expect(displaced).toBeLessThanOrEqual(2);
});

test.each([6000, 20000])('A. a strongly relevant human-reviewed memory survives a crowded source context at %i bytes', async budget => {
  const memory = human();
  const { bundle, audit, outcome } = await context(budget);
  expect(outcome(memory.id)).toBe('included');
  expect(bundle.items.find(i => i.id === memory.id)!.reasons).toContain('human-reviewed claim; current sources take precedence');
  expectRankOrder(bundle, audit);
});

test('B. a fresh source-backed memory is kept next to its current supporting source', async () => {
  const memory = backed();
  expect(memory).toMatchObject({ status: 'persist', source_path: 'docs/worktree-removal.md' });
  for (const budget of [6000, 20000]) {
    const { bundle, audit, outcome } = await context(budget);
    expect(outcome(memory.id), `budget ${budget}`).toBe('included');
    expect(bundle.items.find(i => i.id === memory.id)!.reasons).toContain('source-backed memory; source version still current');
    expectRankOrder(bundle, audit);
  }
  // With room for everything the supporting source passage is present as well, ranked with the sources.
  const all = await context(32000);
  expect(all.bundle.items.some(i => i.kind === 'source' && i.passage?.path === 'docs/worktree-removal.md')).toBe(true);
});

test('C. trust order holds among strong memories; an agent lesson never takes the share from a higher-trust one', async () => {
  const lesson = client().propose(AGENT), memory = human(), note = backed();
  // 6 KB: the 1,500-byte share fits the human-reviewed and the source-backed memory, not the agent lesson as well.
  const small = await context(6000);
  expect([small.outcome(memory.id), small.outcome(note.id), small.outcome(lesson.id)]).toEqual(['included', 'included', 'budget']);
  // 20 KB: all three, presented in trust order after the sources.
  const large = await context(20000);
  const memories = large.bundle.items.filter(i => !isSource(i)).map(i => i.id);
  expect(memories).toEqual([memory.id, note.id, lesson.id]);
  expectRankOrder(large.bundle, large.audit);
});

test('C. a weakly matching higher-trust memory keeps the outcome it had without the lesson', async () => {
  const weakHuman = human(path, { key: 'terminal.policy', kind: 'decision', text: 'The Windows terminal is the supported shell for release checks.' });
  const before = await context(6000);
  const lesson = client().propose(AGENT);
  const after = await context(6000);
  // The share is for strong matches only; a weak memory of any trust keeps its previous (after-sources) admission.
  expect(after.outcome(weakHuman.id)).toBe(before.outcome(weakHuman.id));
  expect(after.outcome(lesson.id)).toBe('included');
  const order = after.bundle.items.filter(i => !isSource(i)).map(i => i.id);
  expect(order.indexOf(weakHuman.id), 'a human-reviewed memory is still presented first').toBeLessThan(order.indexOf(lesson.id));
});

test('D. a stale source-backed memory stays excluded however strongly it matches', async () => {
  const note = backed();
  expect((await context(6000)).outcome(note.id)).toBe('included');
  write(path, { 'docs/worktree-removal.md': '# Removal\n\nWorktrees are removed by the host.\n' });
  await client().sync();
  const { bundle, outcome } = await context(6000);
  expect(ids(bundle)).not.toContain(note.id);
  expect(outcome(note.id)).toBe('not a candidate');
});

test('E. conflicting claims stay quarantined and a rule keeps its place ahead of a contradicting lesson', async () => {
  const first = client().propose({ ...AGENT, key: 'windows.removal' });
  const second = client().propose({ ...AGENT, key: 'windows.removal', text: 'On Windows, never remove an old pnpm worktree yourself; git worktree remove always works there.' });
  expect([client().memory(first.id)!.status, second.status]).toEqual(['needs_attention', 'needs_attention']);
  const baseline = await context(6000);
  const contradicting = client().propose({ key: 'workspace.delete', kind: 'rule', text: 'Agents delete an old pnpm worktree on Windows directly from agent code; the host never needs to remove it.', from: FROM });
  const { bundle, outcome } = await context(6000);
  expect([outcome(first.id), outcome(second.id)]).toEqual(['not a candidate', 'not a candidate']);
  const rules = baseline.bundle.items.filter(i => i.kind === 'rule').map(i => i.id);
  expect(ids(bundle).slice(0, rules.length)).toEqual(rules);
  expect(bundle.items.find(i => i.content.includes('ask the host to remove it'))?.kind).toBe('rule');
  expect(bundle.items.find(i => i.id === contradicting.id)?.kind, 'a learned rule is delivered as a memory').toBe('memory');
});

/** One rule, one matching source passage of about 1 KB, one strong memory. */
const EDGE = { 'AGENTS.md': '# Rules\n\n- Keep changes small.\n', 'docs/removal.md': `# Removal\n\nRemoving an old pnpm worktree on Windows needs long path support in Git. ${'Worktree removal notes and background. '.repeat(24)}\n` };
async function edge(name: string, text: string) {
  const dir = project(name, EDGE);
  const memory = client(dir).propose({ key: 'win.rm', kind: 'experience', text, from: FROM });
  const all = await context(32000, dir);
  expect(all.bundle.items.map(i => i.kind)).toEqual(['rule', 'source', 'experience']);
  const [, source, lesson] = all.bundle.items.map(i => bytes(i) + 1);
  // One byte short of everything: rules + source fits, rules + memory fits, all three do not. The bundle states its
  // requested budget, so a shorter number shrinks the bundle as well.
  const full = all.bundle.budget.used, tight = full - 1 - (String(32000).length - String(full - 1).length);
  expect(Math.max(source!, lesson!)).toBeLessThan(source! + lesson!);
  return { dir, memory, lesson: lesson!, tight, result: await context(tight, dir) };
}

test('F. budget edge, memory within its share: rules plus either item fit, not both, and the strong memory is admitted', async () => {
  const { memory, lesson, tight, result } = await edge('edge-fit', 'Remove a pnpm worktree on Windows with fs.rmSync.');
  expect(lesson).toBeLessThanOrEqual(Math.floor(tight * SHARE));
  expect(result.bundle.items.map(i => i.kind)).toEqual(['rule', 'experience']);
  expect(result.outcome(memory.id)).toBe('included');
});

test('F. budget edge, memory larger than its share: the ranked source is admitted as before', async () => {
  const { memory, lesson, tight, result } = await edge('edge-large', `Remove a pnpm worktree on Windows with fs.rmSync. ${'It avoids long path and junction failures. '.repeat(14)}`);
  expect(lesson).toBeGreaterThan(Math.floor(tight * SHARE));
  expect(result.bundle.items.map(i => i.kind)).toEqual(['rule', 'source']);
  expect(result.outcome(memory.id)).toBe('budget');
});

test('F. the smallest budget stays valid and never exceeds the request', async () => {
  client().propose(AGENT); human();
  const { bundle } = await context(512);
  expect(bundle.budget.used).toBeLessThanOrEqual(512);
});

test('G. with enough budget everything is included in the unchanged order', async () => {
  const small = project('small', { 'AGENTS.md': '# Rules\n\n- Keep changes small.\n', 'docs/removal.md': '# Removal\n\nRemoving an old pnpm worktree on Windows needs long path support enabled in Git first.\n' });
  const lesson = client(small).propose(AGENT), memory = human(small), weak = client(small).propose(WEAK);
  const { bundle, audit } = await context(32000, small);
  expect(audit.entries.every(e => e.outcome === 'included')).toBe(true);
  expect(bundle.items.map(i => i.kind)).toEqual(['rule', 'source', 'decision', 'experience', 'experience']);
  expect(bundle.items.slice(2).map(i => i.id)).toEqual([memory.id, ...[lesson.id, weak.id].sort()]);
});

test.each([6000, 20000])('H. without memories, or with only weak ones, the context is unchanged at %i bytes', async budget => {
  const baseline = await context(budget);
  expect(baseline.bundle.items.every(isSource)).toBe(true);
  expect(baseline.bundle.items.flatMap(i => i.reasons).some(r => r.includes('bounded memory share'))).toBe(false);
  client().propose(WEAK);
  client().propose({ key: 'release.cadence', kind: 'decision', text: 'Releases are cut every second Thursday after the changelog review.', from: FROM });
  const { bundle } = await context(budget);
  expect(ids(bundle)).toEqual(ids(baseline.bundle));
  expect(bundle.budget.used).toBe(baseline.bundle.budget.used);
});

test('I. without sources, memories follow in trust order within the budget', async () => {
  const bare = project('bare', { 'README.md': '# Bare\n\nNothing here matches.\n' });
  const lesson = client(bare).propose(AGENT), memory = human(bare);
  const { bundle } = await context(6000, bare);
  expect(bundle.items.filter(isSource)).toEqual([]);
  expect(ids(bundle)).toEqual([memory.id, lesson.id]);
});

test('J. a strongly matching memory from another project never enters the context', async () => {
  const other = project('other', { 'README.md': '# Other\n' });
  const foreign = client(other).propose(AGENT), foreignHuman = human(other);
  const { bundle, outcome } = await context(6000);
  expect([outcome(foreign.id), outcome(foreignHuman.id)]).toEqual(['not a candidate', 'not a candidate']);
  for (const item of bundle.items) expect(item.provenance.project_id).toBe(bundle.project_id);
});

test('strongly matching memories cannot claim more than their bounded share ahead of sources', async () => {
  const budget = 6000;
  const lessons = Array.from({ length: 6 }, (_, i) => client().propose({ ...AGENT, key: `windows.pnpm-worktree-${i}`, text: `${AGENT.text} Variant ${i} applies to worktree number ${i}.` }));
  const { bundle, audit } = await context(budget);
  const memories = bundle.items.filter(i => lessons.some(l => l.id === i.id));
  expect(memories.length).toBeGreaterThan(0);
  expect(memories.reduce((sum, i) => sum + bytes(i) + 1, 0)).toBeLessThanOrEqual(Math.floor(budget * SHARE));
  expect(audit.entries.filter(e => lessons.some(l => l.id === e.id) && e.outcome === 'budget').length).toBeGreaterThan(0);
  expect(bundle.items.filter(i => i.kind === 'source').length, 'sources keep the rest of the budget').toBeGreaterThan(0);
  // Memories keep their existing order (trust, then id); match strength does not reorder them.
  expect(memories.map(i => i.id)).toEqual([...lessons].map(l => l.id).sort().slice(0, memories.length));
});

test('selection is deterministic', async () => {
  client().propose(AGENT); client().propose(WEAK); human();
  const first = await context(6000), second = await context(6000);
  expect(ids(second.bundle)).toEqual(ids(first.bundle));
  expect(second.bundle.budget.used).toBe(first.bundle.budget.used);
});

test('the real CLI context path includes the lesson', () => {
  client().propose(AGENT);
  host.close();
  const cli = resolve('dist/packages/cli/src/index.js');
  const run = spawnSync(process.execPath, ['--no-warnings', cli, '--home', home, '--project', path, '--json', 'context', TASK, '--budget', '6000'], { encoding: 'utf8', windowsHide: true });
  host = openContinuity(home);
  expect(run.status, run.stderr).toBe(0);
  const bundle = JSON.parse(run.stdout) as ContextBundle;
  expect(bundle.items.some(i => i.content === AGENT.text)).toBe(true);
  expect(bundle.budget.used).toBeLessThanOrEqual(6000);
});
