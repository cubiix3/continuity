import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openContinuity } from '../packages/sdk/src/index.js';
import { createDashboardServer } from '../packages/server/src/dashboard.js';
import type { InspectionPage, Resource } from '../packages/core/src/contracts.js';
import { request } from 'node:http';
import { execFileSync } from 'node:child_process';

let root: string, project: string, other: string, host: ReturnType<typeof openContinuity>, server: ReturnType<typeof createDashboardServer>, base: string, token: string, id: string;
const handoff = { from: { agent: 'test', session: 's' }, task: { goal: 'Continue safely', status: 'blocked' }, completed: [], remaining: [], decisions: [], files_changed: [], risks: [], recommended_next_action: 'Run tests' };
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'continuity-dashboard-')); project = join(root, 'project'); other = join(root, 'other'); mkdirSync(project); mkdirSync(other);
  writeFileSync(join(project, 'README.md'), '# Current\nCurrent implementation.'); writeFileSync(join(other, 'README.md'), 'FOREIGN_CANARY');
  host = openContinuity(join(root, 'state')); id = host.init(project).project_id; host.init(other);
  await host.project(project).sync(); await host.project(other).sync();
  server = createDashboardServer(host, new URL('../dist/packages/dashboard/', import.meta.url));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing address'); base = `http://127.0.0.1:${address.port}`;
  token = (await (await fetch(`${base}/dashboard-api/session`, { headers: { 'X-Continuity-Dashboard': '1' } })).json() as { capability: string }).capability;
});
afterEach(async () => { await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }); host.close(); rmSync(root, { recursive: true, force: true }); });
const get = (path: string, headers: Record<string, string> = {}) => fetch(`${base}/dashboard-api/${path}`, { headers: { 'X-Continuity-Token': token, ...headers } });
const write = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${base}/dashboard-api/${path}`, { method: 'POST', headers: { 'X-Continuity-Token': token, Origin: base, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

it('serves only local assets with CSP and rejects DNS rebinding, foreign origins and unauthenticated reads', async () => {
  const page = await fetch(base); expect(page.status).toBe(200); expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'"); expect(page.headers.get('content-security-policy')).not.toContain('unsafe'); expect(page.headers.get('cache-control')).toBe('no-store');
  expect((await fetch(`${base}/dashboard-api/projects`)).status).toBe(403);
  for (const headers of [{ Origin: 'https://evil.example' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }, { 'X-Continuity-Token': 'é'.repeat(64) }]) expect((await get('projects', headers)).status, JSON.stringify(headers)).toBe(403);
  // Node fetch normalizes Host, so exercise DNS rebinding with the raw HTTP client.
  const rebinding = await new Promise<number | undefined>((resolve, reject) => { const req = request(base, { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); req.end(); }); expect(rebinding).toBe(403);
  expect((await fetch(`${base}/dashboard-api/session`)).status).toBe(403);
  expect((await fetch(`${base}/dashboard-api/session`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Headers': 'x-continuity-dashboard' } })).status).toBe(403);
  expect((await fetch(`${base}/app.js`)).headers.get('content-type')).toContain('javascript');
});
it('paginates without source bodies and denies wrong project/workspace record selection', async () => {
  for (let i = 0; i < 4; i++) host.project(project).createHandoff({ ...handoff, task: { ...handoff.task, goal: `Task ${i}` } });
  const foreign = host.project(other).createHandoff(handoff);
  const first = await (await get(`records?project=${id}&kind=handoffs&limit=2`)).json() as InspectionPage;
  const second = await (await get(`records?project=${id}&kind=handoffs&limit=2&after=${first.next}`)).json() as InspectionPage;
  expect(first.items).toHaveLength(2); expect(second.items).toHaveLength(2); expect(new Set([...first.items, ...second.items].map(i => i.cursor)).size).toBe(4); expect(second.next).toBeNull();
  expect(await (await get(`records?project=${id}&kind=handoffs&id=${foreign.id}`)).json()).toMatchObject({ items: [] });
  expect((await get(`records?project=${id}&workspace=forged`)).status).toBe(409);
  expect((await get(`records?project=${id}&kind=handoffs&limit=100000`)).status).toBe(400);
  const sources = await (await get(`records?project=${id}&kind=sources`)).text(); expect(sources).not.toContain('FOREIGN_CANARY'); expect(sources).not.toContain('Current implementation');
});
it('revalidates source previews and fails closed for removed sources', async () => {
  const page = await (await get(`records?project=${id}&kind=sources`)).json() as InspectionPage; const source = page.items[0]!.record as Resource;
  writeFileSync(join(project, 'README.md'), '# Changed\nNEW_CURRENT');
  const fresh = await (await get(`records?project=${id}&kind=sources&id=${source.id}`)).text(); expect(fresh).toContain('NEW_CURRENT'); expect(fresh).not.toContain('Current implementation');
  rmSync(join(project, 'README.md')); expect((await get(`records?project=${id}&kind=sources&id=${source.id}`)).status).toBe(404);
});
it('uses trusted review policy with explicit JSON writes and preserves revisions', async () => {
  const memory = host.project(project).propose({ key: 'review', kind: 'memory', text: 'A proposal requiring human review.' });
  const input = { project: id, id: memory.id, by: 'Human', decision: 'accepted' };
  expect((await write('review', input, { Origin: '' })).status).toBe(403);
  expect((await write('review', input, { 'Content-Type': 'text/plain' })).status).toBe(403);
  expect((await write('review', { ...input, namespace: '*' })).status).toBe(400);
  expect((await write('review', { ...input, by: 'x'.repeat(5000) })).status).toBe(413);
  expect((await write('review', input)).status).toBe(200);
  expect((await write('review', input)).status).toBe(409);
  const revisions = await (await get(`records?project=${id}&kind=revisions&id=${memory.id}`)).json() as InspectionPage; expect(revisions.items).toHaveLength(2);
  expect((await write('review', { ...input, project: host.init(other).project_id })).status).toBe(409);
});
it('exposes historical audit without changing current context or retrieval policy', async () => {
  const bundle = await host.project(project).context({ task: 'Current', budget: 2000 });
  expect((await get(`selection?project=${id}&id=${bundle.context_id}`)).status).toBe(200);
  expect((await get(`selection?project=${host.init(other).project_id}&id=${bundle.context_id}`)).status).toBe(409);
  expect(await (await get('diagnostics')).json()).toMatchObject({ integrity: 'ok', fts5: true });
  expect(await (await get(`retrieval?project=${id}`)).json()).toMatchObject({ status: 'disabled' });
});

it('rejects real sibling and foreign workspace identities, not only invented IDs', async () => {
  const checkout = (path: string, suffix: string) => {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: path, stdio: 'pipe' });
    git('init'); git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture');
    const work = join(root, suffix); git('worktree', 'add', '-b', suffix, work); return work;
  };
  const work = checkout(project, 'worker-a'), foreignWork = checkout(other, 'worker-b');
  const worker = host.workspace(project, work), foreign = host.workspace(other, foreignWork); await worker.sync(); await foreign.sync();
  const workspace = worker.status().workspace!.workspace_id, foreignWorkspace = foreign.status().workspace!.workspace_id;
  const primaryHandoff = host.project(project).createHandoff(handoff);
  expect(await (await get(`records?project=${id}&workspace=${workspace}&kind=handoffs&id=${primaryHandoff.id}`)).json()).toMatchObject({ items: [] });
  expect((await get(`records?project=${id}&workspace=${foreignWorkspace}&kind=sources`)).status).toBe(409);
  const primarySource = (await (await get(`records?project=${id}&kind=sources`)).json() as InspectionPage).items[0]!.record as Resource;
  expect((await get(`records?project=${id}&workspace=${workspace}&kind=sources&id=${primarySource.id}`)).status).toBe(404);
});
