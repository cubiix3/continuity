import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openContinuity } from '../packages/sdk/src/index.js';
import { createDashboardServer } from '../packages/server/src/dashboard.js';
import type { InspectionPage, Resource } from '../packages/core/src/contracts.js';
import { request, createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { SqliteStorage } from '../packages/storage-sqlite/src/index.js';

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

it('exposes local source scope read-only and fails closed with actionable config diagnostics', async () => {
  host.setSourceScope(project, { include: ['README.md'] });
  expect(await (await get(`source-scope?project=${id}`)).json()).toMatchObject({ project_id: id, filtered: true, include: ['README.md'] });
  expect((await get(`source-scope?project=${id}`, { 'X-Continuity-Token': '' })).status).toBe(403);
  expect((await write('source-scope', { project: id })).status).toBe(404);
  writeFileSync(join(root, 'state', 'sources.json'), '{invalid');
  expect((await get(`source-scope?project=${id}`)).status).toBe(409);
  expect((await (await get('diagnostics')).json()).problems.join(' ')).toContain('sources.json');
  const sync = await write('sync', { project: id }); expect(sync.status).toBe(409);
  expect((await sync.json()).error).toContain('Source indexing is blocked');
});

it('shows automatic memory counts and protects explicit forget with ownership and browser write checks', async () => {
  const memory = host.project(project).propose({ key: 'durable', kind: 'experience', text: 'Reconnect cancellation releases the shared provider registry lease.', from: { agent: 'test', session: 'automatic' } });
  const stats = await (await get(`stats?project=${id}`)).json() as { active: number; conflicts: number }; expect(stats).toMatchObject({ active: 1, conflicts: 0 });
  const filtered = await (await get(`records?project=${id}&kind=memories&status=agent_learned`)).json() as InspectionPage; expect(filtered.items[0]?.record).toMatchObject({ id: memory.id });
  expect((await get(`forget?project=${id}&id=${memory.id}`)).status).toBe(404);
  const input = { project: id, id: memory.id }; expect((await write('forget', input, { Origin: 'https://foreign.invalid' })).status).toBe(403);
  expect((await write('forget', { ...input, project: host.init(other).project_id })).status).toBe(409);
  expect(host.project(project).memory(memory.id).status).toBe('persist');
  expect((await write('forget', input)).status).toBe(200); expect(host.project(project).memory(memory.id).status).toBe('forgotten');
  expect(host.inspection.page(id, '', 'revisions', 20, 0, memory.id).items).toHaveLength(2);
});

it('serves only local assets with CSP and rejects DNS rebinding, foreign origins and unauthenticated reads', async () => {
  const page = await fetch(base); expect(page.status).toBe(200); expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'"); expect(page.headers.get('content-security-policy')).not.toContain('unsafe'); expect(page.headers.get('cache-control')).toBe('no-store');
  expect((await fetch(`${base}/dashboard-api/projects`)).status).toBe(403);
  for (const headers of [{ Origin: 'https://evil.example' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }, { 'X-Continuity-Token': 'é'.repeat(64) }]) expect((await get('projects', headers)).status, JSON.stringify(headers)).toBe(403);
  // Node fetch normalizes Host, so exercise DNS rebinding with the raw HTTP client.
  const rebinding = await new Promise<number | undefined>((resolve, reject) => { const req = request(base, { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); req.end(); }); expect(rebinding).toBe(403);
  expect((await fetch(`${base}/dashboard-api/session`)).status).toBe(403);
  expect((await fetch(`${base}/dashboard-api/session`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Headers': 'x-continuity-dashboard' } })).status).toBe(403);
  expect((await fetch(`${base}/app.js`)).headers.get('content-type')).toContain('javascript');
  const favicon = await fetch(`${base}/favicon.svg`); expect(favicon.headers.get('content-type')).toBe('image/svg+xml'); expect(await favicon.text()).not.toMatch(/<script|href=["']?http/i);
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
  const before = host.project(project).status().sync;
  writeFileSync(join(project, 'README.md'), '# Changed\nNEW_CURRENT');
  const fresh = await (await get(`records?project=${id}&kind=sources&id=${source.id}`)).text(); expect(fresh).toContain('NEW_CURRENT'); expect(fresh).not.toContain('Current implementation');
  expect(fresh).toContain('"changed_since_sync":true');
  await get(`retrieval?project=${id}`);
  expect(host.project(project).status().sync).toEqual(before);
  const stored = host.inspection.page(id, '', 'sources', 1, 0, source.id).items[0]!.record as Resource;
  expect(stored.hash).toBe(source.hash); expect(stored.content).toContain('Current implementation');
  rmSync(join(project, 'README.md')); expect((await get(`records?project=${id}&kind=sources&id=${source.id}`)).status).toBe(404);
});

it('returns JSON null for historical contexts without a selection audit', async () => {
  const bundle = await host.project(project).context({ task: 'Current' });
  const storage = new SqliteStorage(join(root, 'state', 'continuity.db'));
  const historical = { ...bundle, context_id: 'ctx_before_selection_audit' }; storage.saveContext(historical); storage.close();
  const response = await get(`selection?project=${id}&id=${historical.context_id}`);
  expect(response.status).toBe(200); expect(await response.json()).toBeNull();
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

it('inspects a current semantic cache without replacing resource IDs or sync state', async () => {
  const backend = createServer(async (req, res) => {
    if (req.url === '/api/tags') { res.end(JSON.stringify({ models: [{ name: 'nomic-embed-text:latest', digest: 'fixture-only' }] })); return; }
    let body = ''; for await (const chunk of req) body += String(chunk);
    const input = JSON.parse(body) as { input: string[] }; res.end(JSON.stringify({ embeddings: input.input.map(() => [1, 0]) }));
  });
  await new Promise<void>(resolve => backend.listen(0, '127.0.0.1', resolve)); const address = backend.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  writeFileSync(join(root, 'state', 'retrieval.json'), JSON.stringify({ semantic: { enabled: true, endpoint: `http://127.0.0.1:${address.port}` } }));
  const semanticHost = openContinuity(join(root, 'state'));
  try {
    const client = semanticHost.project(project); expect(await client.sync()).toMatchObject({ semantic: { status: 'ready' } }); const before = client.status().sync;
    expect(await semanticHost.inspectionRetrievalHealth(id, '')).toMatchObject({ status: 'ready' }); expect(client.status().sync).toEqual(before);
    writeFileSync(join(project, 'README.md'), '# Changed\nNew current implementation.');
    expect(await semanticHost.inspectionRetrievalHealth(id, '')).toMatchObject({ status: 'incomplete' }); expect(client.status().sync).toEqual(before);
  } finally { semanticHost.close(); backend.closeAllConnections(); await new Promise<void>(resolve => backend.close(() => resolve())); }
});
