import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Real worktrees and real Git processes. execFile is wrapped only to count Git processes that are alive at once.
const processes = vi.hoisted(() => ({ active: 0, peak: 0, total: 0, calls: [] as { args: readonly string[]; options: Record<string, unknown> }[] }));
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const execFile = (file: string, args: readonly string[], options: object, callback: (...result: unknown[]) => void) => {
    if (file !== 'git') return actual.execFile(file, args, options, callback as never);
    processes.active++; processes.total++; processes.peak = Math.max(processes.peak, processes.active); processes.calls.push({ args, options: options as Record<string, unknown> });
    return actual.execFile(file, args, options, ((...result: unknown[]) => { processes.active--; callback(...result); }) as never);
  };
  return { ...actual, execFile };
});
import { execFileSync } from 'node:child_process';
import { openContinuity, DOCTOR_WORKSPACE_CONCURRENCY } from '../packages/sdk/src/index.js';

const WORKTREES = 10;
// Real worktree creation in beforeEach is slow on Windows runners.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
let root: string, primary: string, host: ReturnType<typeof openContinuity>, projectId: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'continuity-doctor-git-')); primary = join(root, 'project'); mkdirSync(primary);
  writeFileSync(join(primary, 'README.md'), '# Project\n');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: primary, stdio: 'pipe' });
  git('init', '-q'); git('add', '.'); git('-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'fixture');
  host = openContinuity(join(root, 'state')); projectId = host.init(primary).project_id;
  for (let i = 0; i < WORKTREES; i++) { const worktree = join(root, `wt-${String(i).padStart(2, '0')}`); git('worktree', 'add', '-q', '-b', `wt-${i}`, worktree); host.workspace(primary, worktree); }
  Object.assign(processes, { active: 0, peak: 0, total: 0, calls: [] });
});
afterEach(() => { host.close(); rmSync(root, { recursive: true, force: true }); });

it('verifies real worktrees with at most DOCTOR_WORKSPACE_CONCURRENCY Git processes alive at once', async () => {
  // Git runs outside the event loop: a 10 ms watchdog keeps firing during the real doctor.
  let last = performance.now(), stall = 0;
  const watchdog = setInterval(() => { const now = performance.now(); stall = Math.max(stall, now - last); last = now; }, 10);
  let report: Awaited<ReturnType<typeof host.doctor>>;
  try { report = await host.doctor(); } finally { clearInterval(watchdog); }
  expect(stall).toBeLessThan(1000);
  expect(report.problems).toEqual([]);
  expect(report.workspaces.map(w => [w.workspace_id, w.accessible])).toEqual(host.inspection.workspaces(projectId).map(w => [w.workspace_id, true]));
  // Five Git calls per workspace, run in sequence per workspace; workspaces run in parallel up to the bound.
  expect(processes.total).toBe(WORKTREES * 5);
  expect(processes.peak).toBe(DOCTOR_WORKSPACE_CONCURRENCY);
  expect(processes.active).toBe(0);
  // Every Git call: argument array, no shell, the 5 s timeout and a bounded output buffer.
  for (const { args, options } of processes.calls) {
    expect(Array.isArray(args)).toBe(true); expect(args[0]).toBe('-C');
    expect(options).toMatchObject({ shell: false, timeout: 5000 }); expect(options.maxBuffer).toBeGreaterThan(0); expect(options.maxBuffer).toBeLessThanOrEqual(1024 * 1024);
  }
});

it('reports a removed real worktree and still verifies the others in parallel', async () => {
  const [removed] = host.inspection.workspaces(projectId).slice(4, 5);
  rmSync(removed!.root, { recursive: true, force: true });
  const report = await host.doctor();
  expect(report.problems).toEqual([`inaccessible/stale workspace: ${removed!.workspace_id}`]);
  expect(report.workspaces.filter(w => !w.accessible).map(w => w.workspace_id)).toEqual([removed!.workspace_id]);
  expect(processes.peak).toBeLessThanOrEqual(DOCTOR_WORKSPACE_CONCURRENCY); expect(processes.active).toBe(0);
});
