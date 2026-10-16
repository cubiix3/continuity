import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { openContinuity } from '../packages/sdk/src/index.js';
import type { ContextBundle } from '../packages/core/src/contracts.js';

// A realistic project: current rules, and many documents that mention worktrees, Windows, pnpm and removal in
// passing. None of them contains the durable lesson an agent learned the hard way.
const FILES: Record<string, string> = {
  'AGENTS.md': `# Working on Relay\n\nGit and current project files are the source of truth. Agents are clients.\n\n## Boundaries\n\n- Keep changes small and test real paths where affected.\n- Never delete a registered workspace from agent code; ask the host.\n- Canonical paths, symlink exclusion and secret exclusion are security invariants.\n`,
  'README.md': `# Relay\n\nRelay keeps project identity stable while agents and sessions change.\n\n## Install\n\nRequires Node.js 24 and pnpm 10. On Windows, run the install from a short path; old checkouts keep their own node_modules.\n\n## Workspaces\n\nGit worktrees share one project identity but keep separate current sources. Remove a workspace registration with the CLI; the worktree itself stays on disk.\n`,
};
const topics = ['registration', 'snapshots', 'freshness', 'rebinding', 'health', 'diagnostics', 'retention', 'relocation'];
for (const [i, topic] of topics.entries()) {
  FILES[`docs/workspaces-${topic}.md`] = `# Workspace ${topic}\n\n` + Array.from({ length: 6 }, (_, j) =>
    `## ${topic} note ${j + 1}\n\nEach Git worktree of the project is a workspace with its own source snapshot. The ${topic} step reads the worktree link files and records the result per workspace. ` +
    `On Windows the old worktree path is compared case-insensitively. pnpm installs inside a worktree are ignored by the source scan. Removing a workspace registration never removes files. Step ${i}.${j}.\n`).join('\n');
}
FILES['packages/sdk/src/workspaces.ts'] = Array.from({ length: 12 }, (_, i) =>
  `export function workspaceStep${i}(root: string) {\n  // Resolve the worktree common dir on Windows and POSIX; old registrations are re-validated.\n  return verifyWorktree(root, ${i});\n}\n`).join('\n');

const LESSON = {
  key: 'windows-pnpm-worktree-removal', kind: 'experience' as const,
  text: 'On Windows, git worktree remove --force and PowerShell or cmd removal fail on a worktree that contains pnpm node_modules (long paths and junctions). Node fs.rmSync(path, { recursive: true, force: true }) removes it; then run git worktree prune.',
  from: { agent: 'Claude Code', session: 'session-worktree' },
};
const TASK = 'Remove the old pnpm worktree on Windows';

let root: string, path: string, host: ReturnType<typeof openContinuity>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'continuity-context-selection-'));
  path = join(root, 'relay'); mkdirSync(path);
  for (const [file, text] of Object.entries(FILES)) { mkdirSync(dirname(join(path, file)), { recursive: true }); writeFileSync(join(path, file), text); }
  host = openContinuity(join(root, 'home')); host.init(path);
});
afterEach(() => { host.close(); rmSync(root, { recursive: true, force: true }); });
const client = () => host.project(path);
const bytes = (bundle: ContextBundle) => Buffer.byteLength(JSON.stringify(bundle));

test('a strongly relevant agent experience survives a crowded source context', async () => {
  const lesson = client().propose(LESSON);
  expect(lesson).toMatchObject({ status: 'persist', provenance: { trust: 'agent_observation' } });
  for (const budget of [6000, 20000]) {
    const bundle = await client().context({ task: TASK, budget });
    const audit = client().explain(bundle.context_id, true).selection!;
    expect(audit.candidates, 'the source context is crowded').toBeGreaterThan(20);
    expect(audit.entries.some(e => e.outcome === 'budget'), 'sources alone exceed the budget').toBe(true);
    expect(bundle.items.map(i => i.id), `budget ${budget}`).toContain(lesson.id);
    expect(bundle.items[0]?.kind).toBe('rule');
    expect(bundle.items.at(-1)?.id, 'observations are still presented after current sources').toBe(lesson.id);
    expect(bytes(bundle)).toBe(bundle.budget.used);
    expect(bundle.budget.used).toBeLessThanOrEqual(budget);
  }
});

test('a weakly related memory does not displace useful source context', async () => {
  const baseline = await client().context({ task: TASK, budget: 6000 });
  const weak = client().propose({ key: 'windows-terminal-font', kind: 'experience', text: 'The Windows terminal renders the dashboard table with a narrow monospace font.', from: LESSON.from });
  expect(weak.status).toBe('persist');
  const bundle = await client().context({ task: TASK, budget: 6000 });
  expect(bundle.items.map(i => i.id)).toEqual(baseline.items.map(i => i.id));
});

test('strongly relevant memories take at most a quarter of the budget from crowded source context', async () => {
  const budget = 6000, itemBytes = (b: ContextBundle, keep: (id: string) => boolean) => b.items.filter(i => keep(i.id)).reduce((sum, i) => sum + Buffer.byteLength(JSON.stringify(i)) + 1, 0);
  const baseline = await client().context({ task: TASK, budget });
  const lessons = [LESSON,
    { ...LESSON, key: 'worktree-prune-after-removal', text: 'After removing an old pnpm worktree on Windows, git worktree prune clears its stale registration from the main checkout.' },
    { ...LESSON, key: 'worktree-short-root', text: 'Creating Windows worktrees under a short root such as G:/relay-topic keeps pnpm paths below the long-path limit, so removal succeeds.' },
    { ...LESSON, key: 'worktree-junction-cleanup', text: 'pnpm junctions inside an old Windows worktree survive git worktree remove; fs.rmSync with force deletes them without following the junction targets.' },
  ].map(l => client().propose(l));
  expect(lessons.every(l => l.status === 'persist')).toBe(true);
  const bundle = await client().context({ task: TASK, budget });
  const isLesson = (id: string) => lessons.some(l => l.id === id);
  expect(bundle.items.some(i => isLesson(i.id))).toBe(true);
  // Memories never take more than a quarter of the budget from sources; passages are indivisible, so packing can
  // cost at most one more passage. Leftover bytes that no remaining passage fits into may still hold a memory.
  const largestPassage = Math.max(...baseline.items.map(i => Buffer.byteLength(JSON.stringify(i)) + 1));
  expect(itemBytes(bundle, id => !isLesson(id))).toBeGreaterThan(itemBytes(baseline, () => true) - budget / 4 - largestPassage);
  expect(bundle.items.filter(i => i.kind === 'rule')).toHaveLength(2);
  expect(bundle.items.filter(i => i.kind === 'source').length).toBeGreaterThan(0);
});

test('a current rule beats a conflicting memory, including when the budget fits only one', async () => {
  const conflicting = client().propose({ key: 'workspace-deletion', kind: 'decision', text: 'Agents delete an old registered pnpm worktree on Windows directly from agent code with fs.rmSync to remove it.', from: LESSON.from });
  expect(conflicting.status).toBe('persist');
  const roomy = await client().context({ task: TASK, budget: 32000 });
  const rule = roomy.items.find(i => i.kind === 'rule' && i.content.includes('Never delete a registered workspace'))!;
  const ids = roomy.items.map(i => i.id);
  expect(ids.indexOf(rule.id)).toBeGreaterThanOrEqual(0);
  expect(ids.indexOf(rule.id)).toBeLessThan(ids.indexOf(conflicting.id));
  const memory = roomy.items.find(i => i.id === conflicting.id)!;
  expect(memory.reasons).toContain('agent-learned observation; not source truth or project policy');
  const rulesOnly = bytes({ ...roomy, items: roomy.items.filter(i => i.kind === 'rule') });
  const memoryOnly = bytes({ ...roomy, items: [memory] });
  const tight = await client().context({ task: TASK, budget: Math.max(rulesOnly, memoryOnly) });
  expect(tight.items.some(i => i.id === rule.id)).toBe(true);
  expect(tight.items.some(i => i.id === conflicting.id)).toBe(false);
});

test('a stale source-backed memory stays excluded even when strongly relevant', async () => {
  const note = 'Remove an old pnpm worktree on Windows with fs.rmSync before running git worktree prune.';
  writeFileSync(join(path, 'docs', 'cleanup.md'), `# Cleanup\n\n${note}\n`);
  const backed = client().propose({ key: 'cleanup-note', kind: 'memory', text: note, source_path: 'docs/cleanup.md' });
  expect(backed.provenance.trust).toBe('derived');
  expect((await client().context({ task: TASK })).items.some(i => i.id === backed.id)).toBe(true);
  writeFileSync(join(path, 'docs', 'cleanup.md'), '# Cleanup\n\nThe host removes worktrees.\n');
  expect((await client().context({ task: TASK })).items.some(i => i.id === backed.id)).toBe(false);
});

test('selection is deterministic and always within the byte budget', async () => {
  client().propose(LESSON);
  for (const budget of [512, 1024, 2000, 6000, 20000]) {
    const a = await client().context({ task: TASK, budget }), b = await client().context({ task: TASK, budget });
    expect(b.items).toEqual(a.items);
    expect(b.budget).toEqual(a.budget);
    for (const bundle of [a, b]) { expect(bytes(bundle)).toBe(bundle.budget.used); expect(bundle.budget.used).toBeLessThanOrEqual(budget); }
  }
});
