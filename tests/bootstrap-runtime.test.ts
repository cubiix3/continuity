import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { openContinuity } from '../packages/sdk/src/index.js';
import { AutoSync, AUTO_SYNC } from '../packages/sdk/src/auto-sync.js';
import { renderBootstrap } from '../packages/core/src/index.js';

// Bootstrap and the background runtime share storage but not responsibilities: the runtime keeps sources fresh,
// bootstrap only reads. Neither depends on the other.
let root: string, a: string, b: string, home: string, host: ReturnType<typeof openContinuity>, auto: AutoSync | undefined;
const cli = resolve('dist/packages/cli/src/index.js');
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(predicate: () => boolean, attempts = 200) { for (let i = 0; i < attempts; i++) { if (predicate()) return; await delay(50); } throw new Error('Condition did not settle'); }
const hook = (cwd: string) => new Promise<{ status: number | null; stdout: string; ms: number }>((done, fail) => {
  const started = performance.now(), child = spawn(process.execPath, ['--no-warnings', cli, '--home', home, 'integrate', 'claude', 'session-start'], { windowsHide: true });
  let stdout = ''; child.stdout.on('data', d => { stdout += d; }); child.on('error', fail);
  child.on('close', status => done({ status, stdout, ms: performance.now() - started }));
  child.stdin.end(JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', cwd }));
});
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'continuity bootstrap runtime ü ')); a = join(root, 'alpha'); b = join(root, 'beta'); home = join(root, 'home');
  for (const [dir, text] of [[a, 'The renderer uses cascaded shadow maps without a TAA dependency.'], [b, 'Beta billing uses integer cents.']] as const) { mkdirSync(dir); writeFileSync(join(dir, 'README.md'), `# Fixture\n${text}\n`); }
  host = openContinuity(home); host.init(a, 'Alpha'); host.init(b, 'Beta'); await host.project(a).sync(); await host.project(b).sync();
});
afterEach(async () => { await auto?.stop(); auto = undefined; host.close(); rmSync(root, { recursive: true, force: true }); });

test('bootstrap works with the runtime stopped and running, stays silent outside projects, and never registers', { timeout: 60_000 }, async () => {
  host.project(a).createHandoff({ from: { agent: 'Claude Code', session: 's' }, task: { goal: 'Alpha distance clarity', status: 'in_progress' }, completed: [], remaining: [], decisions: [], files_changed: [], risks: [], recommended_next_action: 'Compare mip selection.' });
  const stopped = await hook(a); expect(stopped.status).toBe(0); expect(stopped.stdout).toContain('Alpha distance clarity');
  auto = new AutoSync(host, () => {}, { ...AUTO_SYNC, debounce: 100, discovery: 150 }); auto.start();
  await until(() => auto!.status().projects.length === 2 && auto!.status().projects.every(p => p.status === 'healthy'));
  const running = await hook(a); expect(running.status).toBe(0); expect(running.stdout).toContain('Alpha distance clarity'); expect(running.stdout).not.toContain('Beta');
  const outside = join(root, 'unregistered'); mkdirSync(outside);
  const silent = await hook(outside); expect(silent.status).toBe(0); expect(silent.stdout).toBe('');
  expect(host.projects()).toHaveLength(2);
});

test('one unavailable project does not affect bootstrap for another', { timeout: 60_000 }, async () => {
  auto = new AutoSync(host, () => {}, { ...AUTO_SYNC, debounce: 100, discovery: 150, reconcile: 200 }); auto.start();
  await until(() => auto!.status().projects.every(p => p.status === 'healthy'));
  renameSync(b, join(root, 'beta-moved'));
  await until(() => auto!.status().projects.some(p => p.status === 'unavailable' || p.status === 'degraded'));
  const result = await hook(a); expect(result.status).toBe(0); expect(JSON.parse(result.stdout).hookSpecificOutput.additionalContext).toContain('Continuity · Alpha');
});

test('auto-sync keeps state fresh and bootstrap reads it; a stale human-accepted claim stays withheld', { timeout: 60_000 }, async () => {
  const client = host.project(a);
  // Unproven against README.md (quarantined), then explicitly accepted: human-reviewed and tied to README's current version.
  const accepted = client.propose({ key: 'deploy.branch', kind: 'decision', text: 'Deploys always come from the release branch.', source_path: 'README.md' });
  expect(accepted.status).toBe('needs_attention'); host.review(a, accepted.id, 'accepted', 'Maintainer');
  expect(host.bootstrap(a)!.memories.map(m => m.id)).toContain(accepted.id);
  auto = new AutoSync(host, () => {}, { ...AUTO_SYNC, debounce: 100, discovery: 150 }); auto.start();
  await until(() => auto!.status().projects.every(p => p.status === 'healthy'));
  const runs = () => auto!.status().projects.find(p => p.root.endsWith('alpha'))!.runs, before = runs();
  writeFileSync(join(a, 'README.md'), '# Fixture\nThe renderer switched to a different shadow technique.\n');
  await until(() => runs() > before && auto!.status().projects.every(p => p.status === 'healthy'));
  const result = host.bootstrap(a)!;
  expect(result.memories.map(m => m.id)).not.toContain(accepted.id); expect(result.attention.stale_source_backed).toBe(1);
  expect(renderBootstrap(result)).toContain('supporting source changed since capture');
});

test('parallel session starts during runtime syncs succeed without blocking or corruption', async () => {
  auto = new AutoSync(host, () => {}, { ...AUTO_SYNC, debounce: 50, discovery: 100 }); auto.start();
  await until(() => auto!.status().projects.every(p => p.status === 'healthy'));
  let writing = true;
  const churn = (async () => { for (let i = 0; writing; i++) { writeFileSync(join(a, `churn-${i % 5}.md`), `Churn ${i}\n`); await delay(30); } })();
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => hook(i % 2 ? a : b)));
  writing = false; await churn;
  for (const [i, r] of results.entries()) { expect(r.status).toBe(0); expect(r.stdout).toContain(i % 2 ? 'Continuity · Alpha' : 'Continuity · Beta'); }
  expect(Math.max(...results.map(r => r.ms))).toBeLessThan(10_000);
  expect(host.doctor().integrity).toBe('ok');
}, 60_000);
