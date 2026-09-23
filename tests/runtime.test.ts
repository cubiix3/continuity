import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { openContinuity } from '../packages/sdk/src/index.js';
import { AutoSync, AUTO_SYNC } from '../packages/sdk/src/auto-sync.js';
import { runBackground, runtimeRequest } from '../packages/sdk/src/background.js';
import { continuityHome, coordinatedSync, exchange, ipcAddress } from '../packages/sdk/src/local-ipc.js';
import { startupRegistration, windowsArgument } from '../packages/sdk/src/startup-windows.js';
vi.mock('../packages/server/src/dashboard.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../packages/server/src/dashboard.js')>();
  return { ...actual, createDashboardServer: (host: ReturnType<typeof openContinuity>) => actual.createDashboardServer(host, new URL('../dist/packages/dashboard/', import.meta.url)) };
});

let root: string, project: string, home: string, host: ReturnType<typeof openContinuity>, auto: AutoSync | undefined;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean | Promise<boolean>, attempts = 150) { for (let i = 0; i < attempts; i++) { if (await predicate()) return; await delay(50); } throw new Error('Condition did not settle'); }
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'continuity runtime ü ')); project = join(root, 'project'); mkdirSync(project); writeFileSync(join(project, 'source.ts'), 'export const value = 1;'); home = continuityHome(join(root, 'home')); host = openContinuity(home); host.init(project); });
afterEach(async () => { await auto?.stop(); auto = undefined; host.close(); rmSync(root, { recursive: true, force: true }); });
function start() { auto = new AutoSync(host, () => {}, { ...AUTO_SYNC, debounce: 100, discovery: 150 }); auto.start(); return auto; }
const resources = () => host.inspection.page(host.projects()[0]!.project_id, '', 'sources', 50).items.map(i => i.record as { path: string; hash: string; state: string });

test('real changes debounce, update hashes, add/rename/delete, and keep integrity', async () => {
  const worker = start(); await until(() => worker.status().projects[0]?.status === 'healthy'); const hash = resources()[0]!.hash, runs = worker.status().projects[0]!.runs;
  for (let i = 0; i < 10; i++) writeFileSync(join(project, 'source.ts'), `export const value = ${i + 2};`);
  await until(() => resources().some(r => r.state === 'fresh' && r.hash !== hash)); await delay(200);
  expect(worker.status().projects[0]!.runs - runs).toBe(1);
  writeFileSync(join(project, 'added.ts'), 'export const added = true;'); await until(() => resources().some(r => r.path === 'added.ts' && r.state === 'fresh'));
  renameSync(join(project, 'added.ts'), join(project, 'renamed.ts')); await until(() => resources().some(r => r.path === 'renamed.ts' && r.state === 'fresh'));
  unlinkSync(join(project, 'renamed.ts')); expect(existsSync(join(project, 'renamed.ts'))).toBe(false); await until(() => !resources().some(r => r.path === 'renamed.ts' && r.state === 'fresh'));
  expect((await host.doctor()).integrity).toBe('ok');
});

test('ignored build outputs and secrets have no watches and do not trigger sync', async () => {
  mkdirSync(join(project, 'node_modules')); mkdirSync(join(project, 'generated')); writeFileSync(join(project, '.gitignore'), 'generated/\n');
  const worker = start(); await until(() => worker.status().projects[0]?.status === 'healthy'); const runs = worker.status().projects[0]!.runs;
  for (let i = 0; i < 100; i++) writeFileSync(join(project, 'generated', `${i}.ts`), 'ignored');
  writeFileSync(join(project, 'node_modules', 'ignored.js'), 'ignored'); writeFileSync(join(project, '.env'), 'SECRET=fixture'); await delay(350);
  expect(worker.status().projects[0]!.runs).toBe(runs); expect(worker.status().projects[0]!.watcher_count).toBe(1);
});

test('new registration, nested boundary, unavailable scope and rebind are reconciled', async () => {
  const worker = start(); await until(() => worker.status().projects[0]?.status === 'healthy');
  const nested = join(project, 'nested'); mkdirSync(nested); writeFileSync(join(nested, 'private.ts'), 'nested only'); const registered = host.init(nested);
  await until(() => worker.status().projects.find(p => p.id === registered.project_id)?.status === 'healthy');
  await until(() => !resources().some(r => r.path === 'nested/private.ts' && r.state === 'fresh'));
  const moved = join(root, 'moved'); renameSync(nested, moved); host.rebind(registered.project_id, registered.root, moved);
  await until(() => worker.status().projects.find(p => p.id === registered.project_id)?.root === host.projects().find(p => p.project_id === registered.project_id)?.root);
  await until(() => worker.status().projects.find(p => p.id === registered.project_id)?.status === 'healthy');
  renameSync(moved, join(root, 'missing')); const fresh = new AutoSync(host, () => {}, { ...AUTO_SYNC, reconcile: 100, discovery: 100 });
  try { fresh.start(); await until(() => fresh.status().projects.some(p => ['degraded', 'unavailable'].includes(p.status)) && fresh.status().projects.some(p => p.status === 'healthy')); expect(fresh.status().projects.some(p => p.status === 'healthy')).toBe(true); } finally { await fresh.stop(); }
});

test('dirty during a slow sync coalesces and never runs project syncs in parallel', async () => {
  let concurrent = 0, max = 0;
  const original = host.project.bind(host);
  vi.spyOn(host, 'project').mockImplementation(path => { const c = original(path), sync = c.sync.bind(c); c.sync = async () => { concurrent++; max = Math.max(max, concurrent); try { await delay(250); return await sync(); } finally { concurrent--; } }; return c; });
  const worker = start(); await until(() => worker.status().projects[0]?.status === 'syncing');
  for (let i = 0; i < 10; i++) writeFileSync(join(project, 'source.ts'), `export const value = ${i};`);
  await until(() => worker.status().projects[0]?.runs === 2 && worker.status().projects[0]?.status === 'healthy'); expect(max).toBe(1);
});

test('manual sync shares the same OS lease and failures release it', async () => {
  let calls = 0;
  const run = async () => { calls++; await delay(100); return { files: 1 }; };
  expect(await Promise.all([coordinatedSync(home, 'test', run), coordinatedSync(home, 'test', run)])).toEqual([{ files: 1 }, { files: 1 }]); expect(calls).toBe(1);
  await expect(coordinatedSync(home, 'test', async () => { throw new Error('fixture'); })).rejects.toThrow('fixture');
  await expect(coordinatedSync(home, 'test', run)).resolves.toEqual({ files: 1 });
});

test('sync coordination rejects a forged local endpoint result', async () => {
  const forged = createServer(socket => { socket.once('data', () => socket.end('{"result":{"ok":true,"value":"forged"},"proof":"invalid"}\n')); });
  await new Promise<void>(resolve => forged.listen(ipcAddress(home, 'sync:forged'), resolve));
  try { await expect(coordinatedSync(home, 'forged', async () => 'real')).rejects.toThrow('authentication failed'); }
  finally { await new Promise<void>(resolve => forged.close(() => resolve())); }
});

test('runtime ignores stale PID metadata, is single-instance and authenticates stop', async () => {
  writeFileSync(join(home, 'runtime.key'), JSON.stringify({ pid: process.pid, token: 'stale' })); expect(await runtimeRequest(home)).toEqual({ running: false });
  const running = await runBackground(home, 0, false);
  try {
    const status = await runtimeRequest(home); expect(status.running).toBe(true); expect(status.home).toBe(home); expect(status.dashboard).toMatch(/^http:\/\/127\.0\.0\.1:/); expect(status).not.toHaveProperty('token');
    await expect(runBackground(home, 0)).rejects.toThrow('already running');
    expect(await exchange(ipcAddress(home, 'runtime'), { token: 'forged', command: 'stop' })).toHaveProperty('error'); expect((await runtimeRequest(home)).running).toBe(true);
    const page = await fetch(running.url); expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'"); await page.text();
    expect((await fetch(running.url, { headers: { Origin: 'https://example.invalid' } })).status).toBe(403);
  } finally { await running.stop(); }
  expect(await runtimeRequest(home)).toEqual({ running: false });
});

test('other-home port conflict releases runtime ownership', async () => {
  const occupied = createServer(); await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve)); const addr = occupied.address(); if (!addr || typeof addr === 'string') throw new Error('address');
  try { await expect(runBackground(home, addr.port)).rejects.toThrow('occupied'); } finally { await new Promise<void>(resolve => occupied.close(() => resolve())); }
  const running = await runBackground(home, 0, false); await running.stop();
});

test('periodic fallback works when watcher directory bound is exceeded', async () => {
  auto = new AutoSync(host, () => {}, { ...AUTO_SYNC, maxWatchers: 0, reconcile: 100, discovery: 100 }); auto.start();
  await until(() => auto!.status().projects[0]?.status === 'healthy'); const hash = resources()[0]!.hash;
  writeFileSync(join(project, 'source.ts'), 'export const changed = true;'); await until(() => resources().some(r => r.state === 'fresh' && r.hash !== hash));
  expect(auto.status().projects[0]!.watcher_status).toContain('periodic only');
});

test('more than 512 eligible directories use bounded reconciliation without watchers', async () => {
  for (let i = 0; i < 513; i++) mkdirSync(join(project, `directory-${i}`));
  auto = new AutoSync(host, () => {}, { ...AUTO_SYNC, reconcile: 250 }); auto.start();
  await until(() => auto!.status().projects[0]?.status === 'healthy');
  expect(auto.status().projects[0]!.watcher_count).toBe(0);
  expect(auto.status().projects[0]!.watcher_status).toBe('periodic only: directory limit');
  const hash = resources()[0]!.hash;
  writeFileSync(join(project, 'source.ts'), 'export const reconciled = true;');
  await until(() => resources().some(r => r.state === 'fresh' && r.hash !== hash));
  expect((await host.doctor()).integrity).toBe('ok');
}, 30_000); // 513 directories are slow to create and traverse on loaded Windows runners.

const write = (path: string, content: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); };
const sourcesOf = (id: string) => host.inspection.page(id, '', 'sources', 50).items.map(i => i.record as { id: string; path: string; hash: string; state: string });
const freshPaths = (id: string) => sourcesOf(id).filter(r => r.state === 'fresh').map(r => r.path).sort();

test('runtime watch plan and scan use one resolved local source scope', async () => {
  const files = ['README.md', 'notes.md', 'docs/guide.md', 'docs/nested/deep.md', 'docs/archive/old.md', 'docs/generated/out.md', 'docs/image.png', 'docs/.env', 'tests/unit.test.ts', 'src/app.ts', 'src/deep/lib.ts'];
  for (const file of files) write(join(project, file), `# ${file}\n`);
  write(join(project, '.gitignore'), 'docs/generated/\n');
  const id = host.projects()[0]!.project_id;
  host.setSourceScope(project, { include: ['docs/**', 'tests/**', 'README.md'], exclude: ['docs/archive/**'] });
  const synced = await host.project(project).sync(); const scanned = new Set(freshPaths(id));
  expect([...scanned].sort()).toEqual(['README.md', 'docs/guide.md', 'docs/nested/deep.md', 'tests/unit.test.ts']);
  expect(host.previewSourceScope(project)).toMatchObject({ files: synced.files, complete: true });
  const plan = host.watchPlan(id), base = plan[0]!.path, local = (path: string) => relative(base, path).split(sep).join('/');
  // Exactly the scan traversal: the root (an include ancestor) and in-scope directories. docs/archive/** excludes
  // contents, so the scan still visits that directory and its watch accepts no files.
  expect(plan.map(d => local(d.path)).sort()).toEqual(['', 'docs', 'docs/archive', 'docs/nested', 'tests']);
  // For every candidate, the runtime event filter accepts exactly what the scan indexes.
  for (const file of [...files, 'source.ts']) {
    const directory = plan.find(d => local(d.path) === (dirname(file) === '.' ? '' : dirname(file)));
    expect(Boolean(directory?.accepts(basename(file))), file).toBe(scanned.has(file));
  }
  const at = (path: string) => plan.find(d => local(d.path) === path)!;
  expect(at('').accepts('docs')).toBe(true); expect(at('').accepts('src')).toBe(false); expect(at('').accepts('unrelated')).toBe(false);
  expect(at('docs/archive').accepts('new.md')).toBe(false); expect(at('docs').accepts('generated')).toBe(false); expect(at('docs').accepts('added.md')).toBe(true);
});

test('source scope changes while the runtime runs replace watches, and manual sync matches automatic sync', async () => {
  write(join(project, 'docs', 'guide.md'), '# Guide\n'); write(join(project, 'src', 'app.ts'), 'export const app = 1;');
  const id = host.projects()[0]!.project_id, worker = start(), entry = () => worker.status().projects[0]!;
  await until(() => entry().status === 'healthy' && freshPaths(id).includes('src/app.ts'));
  expect(entry().watcher_count).toBe(3);
  host.setSourceScope(project, { include: ['docs/**'] });
  await until(() => entry().status === 'healthy' && entry().watcher_count === 2 && !freshPaths(id).includes('src/app.ts'));
  expect(freshPaths(id)).toEqual(['docs/guide.md']);
  const outside = sourcesOf(id).find(r => r.path === 'src/app.ts')!;
  expect(host.previewSource(id, '', outside.id)).toBeUndefined();
  const automatic = freshPaths(id), manual = await host.project(project).sync();
  expect(manual.files).toBe(automatic.length); expect(freshPaths(id)).toEqual(automatic);
  await until(() => entry().status === 'healthy'); const runs = entry().runs;
  writeFileSync(join(project, 'src', 'app.ts'), 'export const app = 2;'); await delay(350);
  expect(entry().runs).toBe(runs); expect(freshPaths(id)).not.toContain('src/app.ts');
  host.clearSourceScope(project);
  await until(() => entry().status === 'healthy' && entry().watcher_count === 3 && freshPaths(id).includes('src/app.ts'));
  expect(freshPaths(id)).toEqual(['docs/guide.md', 'source.ts', 'src/app.ts']);
});

test('invalid sources.json fails closed without stopping the runtime and recovers after repair', async () => {
  const other = join(root, 'other'); mkdirSync(other); writeFileSync(join(other, 'other.ts'), 'export const other = 1;'); host.init(other);
  write(join(project, 'docs', 'guide.md'), '# Guide\n');
  host.setSourceScope(project, { include: ['docs/**'] });
  const events: string[] = [], id = host.projects().find(p => p.root.endsWith('project'))!.project_id;
  auto = new AutoSync(host, event => events.push(event), { ...AUTO_SYNC, debounce: 100, discovery: 150 }); auto.start();
  const all = () => auto!.status().projects;
  await until(() => all().length === 2 && all().every(p => p.status === 'healthy'));
  const valid = readFileSync(join(home, 'sources.json'), 'utf8');
  writeFileSync(join(home, 'sources.json'), JSON.stringify({ version: 1, projects: { [id]: { include: ['../escape'] } } }));
  // sources.json is one trusted file; an invalid file blocks every scan instead of falling back unfiltered.
  await until(() => all().every(p => p.status === 'degraded' && p.last_error?.includes('sources.json') && p.watcher_count === 0));
  writeFileSync(join(project, 'source.ts'), 'export const value = 99;'); await delay(400);
  expect(freshPaths(id)).toEqual(['docs/guide.md']);
  expect(events).toContain('source scope configuration invalid'); expect(events.join('\n')).not.toContain('Guide');
  expect((await host.doctor()).problems.some(p => p.includes('sources.json'))).toBe(true);
  writeFileSync(join(home, 'sources.json'), valid);
  await until(() => all().every(p => p.status === 'healthy' && p.watcher_count > 0));
  expect(freshPaths(id)).toEqual(['docs/guide.md']);
});

test('a project over source limits degrades alone and a local source scope restores it', async () => {
  const large = join(root, 'large'); mkdirSync(large); host.init(large);
  for (let i = 0; i < 130; i++) write(join(large, 'bulk', `${i}.md`), `${'lorem ipsum '.repeat(5400)}\n`);
  write(join(large, 'docs', 'readme.md'), '# Large project docs\n');
  const worker = start(), status = (name: string) => worker.status().projects.find(p => p.root === host.projects().find(q => q.root.endsWith(name))!.root);
  await until(() => status('large')?.status === 'degraded' && status('project')?.status === 'healthy', 400);
  expect(status('large')!.last_error).toContain('Source limit exceeded');
  const id = host.projects().find(p => p.root.endsWith('project'))!.project_id, hash = sourcesOf(id)[0]!.hash;
  writeFileSync(join(project, 'source.ts'), 'export const isolated = true;');
  await until(() => sourcesOf(id).some(r => r.state === 'fresh' && r.hash !== hash));
  host.setSourceScope(large, { include: ['docs/**'] });
  await until(() => status('large')?.status === 'healthy', 400);
  expect(status('large')!.watcher_count).toBe(2);
});

test('Windows argv escapes spaces, unicode, quotes and trailing slashes', () => {
  expect(windowsArgument('C:\\space ü\\')).toBe('"C:\\space ü\\\\"'); expect(windowsArgument('a"b')).toBe('"a\\"b"');
});

test('startup unsupported platform is explicit', () => { if (process.platform !== 'win32') expect(() => startupRegistration('install', home, 'cli')).toThrow('not implemented'); });

test('metadata file never serves as a PID-kill authority', async () => { writeFileSync(join(home, 'runtime.key'), JSON.stringify({ pid: process.pid, token: 'fake' })); expect(await runtimeRequest(home, 'stop')).toEqual({ running: false }); expect(readFileSync(join(home, 'runtime.key'), 'utf8')).toContain('fake'); });

test('git bulk changes coalesce and runtime capabilities cannot become source content', async () => {
  const git = (...args: string[]) => execFileSync('git', ['-C', project, ...args], { stdio: 'pipe' });
  git('init'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Fixture');
  for (let i = 0; i < 40; i++) writeFileSync(join(project, `bulk-${i}.ts`), 'export const value = 1;');
  writeFileSync(join(project, 'runtime.key'), JSON.stringify({ token: 'test-only-do-not-index' }));
  git('add', '.'); git('commit', '-m', 'fixture');
  auto = new AutoSync(host, () => {}, { ...AUTO_SYNC, debounce: 100, discovery: 1000 }); auto.start();
  await until(() => auto!.status().projects[0]?.status === 'healthy'); const runs = auto.status().projects[0]!.runs;
  for (let i = 0; i < 40; i++) writeFileSync(join(project, `bulk-${i}.ts`), 'export const value = 2;');
  git('checkout', '--', '.');
  await until(() => auto!.status().projects[0]!.runs > runs); await delay(250);
  expect(auto.status().projects[0]!.runs - runs).toBe(1);
  expect(resources().some(r => r.path === 'runtime.key')).toBe(false);
  expect(resources().filter(r => r.state === 'fresh')).toHaveLength(41);
  expect((await host.doctor()).integrity).toBe('ok');
});

test('separate processes share a sync and OS ownership recovers after an owned child crash', async () => {
  const module = pathToFileURL(resolve('dist/packages/sdk/src/local-ipc.js')).href;
  const launch = (body: string) => spawn(process.execPath, ['--input-type=module', '-e', `import {coordinatedSync} from ${JSON.stringify(module)}; ${body}`], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const owner = launch(`await coordinatedSync(${JSON.stringify(home)}, 'process-test', async () => { console.log('ready'); await new Promise(r=>setTimeout(r,700)); return 'owner-result'; });`);
  const line = (child: ReturnType<typeof launch>) => new Promise<string>((resolve, reject) => { child.stdout!.once('data', chunk => resolve(chunk.toString())); child.once('error', reject); child.once('exit', code => { if (code) reject(new Error('Fixture exited')); }); });
  await line(owner);
  const contender = launch(`console.log(await coordinatedSync(${JSON.stringify(home)}, 'process-test', async () => 'unexpected duplicate'));`);
  expect(await line(contender)).toContain('owner-result');
  const crashed = launch(`await coordinatedSync(${JSON.stringify(home)}, 'crash-test', async () => { console.log('ready'); await new Promise(()=>{}); });`);
  try { await line(crashed); } finally { const exited = new Promise(resolve => crashed.once('exit', resolve)); crashed.kill(); await exited; }
  await expect(coordinatedSync(home, 'crash-test', async () => 'recovered')).resolves.toBe('recovered');
});
