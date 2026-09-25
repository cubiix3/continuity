import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

// Only the asynchronous workspace verifier is replaced, so every test controls how long verification takes. Storage
// checks, the doctor's scheduling and ordering, and the Dashboard server are the real implementations. Real Git
// worktrees are covered in workspaces.test.ts and doctor-git-bound.test.ts.
const verifier = vi.hoisted(() => ({ active: 0, peak: 0, started: [] as string[], finished: [] as string[], fail: new Set<string>(), delay: (() => Promise.resolve()) as (workspace: string) => Promise<void> }));
vi.mock('../packages/sdk/src/workspaces.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../packages/sdk/src/workspaces.js')>();
  return {
    ...actual,
    verifyWorkspaceAsync: async (_project: string, workspace: string) => {
      verifier.started.push(workspace); verifier.active++; verifier.peak = Math.max(verifier.peak, verifier.active);
      try {
        await verifier.delay(workspace);
        if (verifier.fail.has(workspace)) throw new Error('Workspace is not registered with Git.');
        return workspace;
      } finally { verifier.active--; verifier.finished.push(workspace); }
    },
  };
});
import { openContinuity, DOCTOR_WORKSPACE_CONCURRENCY } from '../packages/sdk/src/index.js';
import { createDashboardServer } from '../packages/server/src/dashboard.js';
import { SqliteStorage } from '../packages/storage-sqlite/src/index.js';

const WORKSPACES = 24;
let root: string, host: ReturnType<typeof openContinuity>, projectId: string, roots: string[], ids: string[];
const canonical = (path: string) => { const real = realpathSync.native(path); return process.platform === 'win32' ? real.toLowerCase() : real; };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'continuity-diagnostics-')); const project = join(root, 'project'); mkdirSync(project);
  writeFileSync(join(project, 'README.md'), '# Project\n');
  host = openContinuity(join(root, 'state')); projectId = host.init(project).project_id;
  // Registered in storage directly: these tests are about the doctor's scheduling, not Git membership.
  const storage = new SqliteStorage(join(root, 'state', 'continuity.db'));
  try {
    for (let i = 0; i < WORKSPACES; i++) {
      const dir = join(root, `ws-${String(i).padStart(2, '0')}`); mkdirSync(dir);
      storage.registerWorkspace({ workspace_id: `ws_${randomUUID()}`, project_id: projectId, root: canonical(dir) });
    }
  } finally { storage.close(); }
  const registered = host.inspection.workspaces(projectId);
  roots = registered.map(w => w.root); ids = registered.map(w => w.workspace_id);
  Object.assign(verifier, { active: 0, peak: 0, started: [], finished: [], fail: new Set<string>(), delay: () => Promise.resolve() });
});
afterEach(() => { vi.restoreAllMocks(); host.close(); rmSync(root, { recursive: true, force: true }); });

const serve = async () => {
  const server = createDashboardServer(host, new URL('../dist/packages/dashboard/', import.meta.url));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing address');
  const origin = `http://127.0.0.1:${address.port}`;
  const capability = (await (await fetch(`${origin}/dashboard-api/session`, { headers: { 'X-Continuity-Dashboard': '1' } })).json() as { capability: string }).capability;
  const call = async (path: string) => { const response = await fetch(`${origin}/dashboard-api/${path}`, { headers: { 'X-Continuity-Token': capability } }); return { path, status: response.status, body: await response.json() as Record<string, unknown>, at: performance.now() }; };
  return { call, close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
};
// The request set the Overview page issues (packages/dashboard/src/app.ts overview()).
const overview = () => ['records?kind=handoffs&limit=5', 'stats', 'status', 'health', 'retrieval'].map(path => `${path}${path.includes('?') ? '&' : '?'}project=${projectId}&workspace=`);

it('verifies at most DOCTOR_WORKSPACE_CONCURRENCY workspaces at once and reports them in registration order', async () => {
  // Earlier registrations take longest, so verifications finish out of order.
  verifier.delay = workspace => new Promise(resolve => setTimeout(resolve, 5 + (roots.length - roots.indexOf(workspace)) * 4));
  verifier.fail = new Set([roots[3]!, roots[17]!]);
  const report = await host.doctor();
  expect(verifier.peak).toBe(DOCTOR_WORKSPACE_CONCURRENCY);
  expect(verifier.started).toEqual(roots);
  expect(verifier.finished).not.toEqual(roots); expect([...verifier.finished].sort()).toEqual([...roots].sort());
  expect(report.workspaces.map(w => [w.workspace_id, w.accessible])).toEqual(ids.map((id, i) => [id, i !== 3 && i !== 17]));
  expect(report.problems).toEqual([`inaccessible/stale workspace: ${ids[3]}`, `inaccessible/stale workspace: ${ids[17]}`]);
  // Same input, same report, whatever the completion order.
  verifier.delay = workspace => new Promise(resolve => setTimeout(resolve, 5 + roots.indexOf(workspace) % 5));
  expect(await host.doctor()).toEqual(report);
});

it('answers Dashboard requests while the real doctor is still verifying workspaces', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  verifier.delay = () => gate;
  const dashboard = await serve();
  // The server runs in this process: a synchronous stall anywhere in the doctor delays this 10 ms watchdog.
  let last = performance.now(), stall = 0;
  const watchdog = setInterval(() => { const now = performance.now(); stall = Math.max(stall, now - last); last = now; }, 10);
  try {
    let settled = false;
    const full = dashboard.call('diagnostics').then(result => { settled = true; return result; });
    // The doctor has finished its storage checks and holds the maximum number of verifications open.
    await vi.waitFor(() => expect(verifier.active).toBe(DOCTOR_WORKSPACE_CONCURRENCY), { timeout: 10_000 });
    const during = await Promise.all([...overview(), `workspaces?project=${projectId}&workspace=&limit=50`, `stats?project=${projectId}&workspace=${ids.at(-1)}`].map(dashboard.call));
    expect(during.map(r => [r.path.split('?')[0], r.status])).toEqual(during.map(r => [r.path.split('?')[0], 200]));
    expect(during.at(-1)!.body).toMatchObject({ workspaces: WORKSPACES + 1 });
    expect(settled).toBe(false); expect(verifier.active).toBe(DOCTOR_WORKSPACE_CONCURRENCY); expect(verifier.finished).toEqual([]);
    release();
    const report = await full;
    expect(report.status).toBe(200); expect(Math.max(...during.map(r => r.at))).toBeLessThan(report.at);
    expect((report.body.workspaces as { workspace_id: string; accessible: boolean }[]).map(w => [w.workspace_id, w.accessible])).toEqual(ids.map(id => [id, true]));
    clearInterval(watchdog); expect(stall).toBeLessThan(1000);
  } finally { clearInterval(watchdog); release(); await dashboard.close(); }
});

it('serves the Overview without workspace verification or the storage scan', async () => {
  const diagnose = vi.spyOn(SqliteStorage.prototype, 'diagnose');
  const dashboard = await serve();
  try {
    const loads = await Promise.all([0, 1].map(() => Promise.all(overview().map(dashboard.call))));
    for (const load of loads) expect(load.map(r => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(verifier.started).toEqual([]); expect(diagnose).not.toHaveBeenCalled();
    // Diagnostics is the only route that runs them.
    expect((await dashboard.call('diagnostics')).status).toBe(200);
    expect(verifier.started).toEqual(roots); expect(diagnose).toHaveBeenCalledTimes(1);
  } finally { await dashboard.close(); }
});
