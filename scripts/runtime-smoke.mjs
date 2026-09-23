import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

if (!process.env.npm_execpath) throw new Error('Run pnpm test:runtime-pack.');
const root = mkdtempSync(join(tmpdir(), 'continuity background ü '));
const pm = (args, cwd = process.cwd()) => execFileSync(process.execPath, [process.env.npm_execpath, ...args], { cwd, encoding: 'utf8', stdio: 'pipe' });
let cli, host, browser, startupInstalled = false;
const home = join(root, 'custom home'), project = join(root, 'project');
const command = (...args) => JSON.parse(execFileSync(process.execPath, [cli, '--home', home, '--project', project, '--json', ...args], { encoding: 'utf8', stdio: 'pipe' }));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let i = 0; i < 100; i++) { if (await fn()) return; await wait(100); } throw new Error('Background fixture did not settle'); }
try {
  pm(['pack', '--pack-destination', root]);
  const tarball = readdirSync(root).find(p => p.endsWith('.tgz'));
  const install = join(root, 'install space ü'); mkdirSync(install); writeFileSync(join(install, 'package.json'), '{"private":true}'); pm(['add', '--ignore-scripts', join(root, tarball)], install);
  const pkg = join(install, 'node_modules/continuity-local'); cli = join(pkg, 'dist/packages/cli/src/index.js');
  mkdirSync(project); writeFileSync(join(project, 'source.ts'), 'export const value = 1;'); command('init');
  const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve)); const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  if (process.platform === 'win32') {
    const installed = command('startup', 'install', '--port', String(port)); startupInstalled = true;
    assert(installed.installed); assert(command('startup', 'status', '--port', String(port)).current_command);
    execFileSync('schtasks.exe', ['/Run', '/TN', installed.name], { windowsHide: true, stdio: 'pipe' });
  } else command('runtime', 'start', '--port', String(port));
  await until(() => command('runtime', 'status').running);
  const status = command('runtime', 'status'); assert.equal(status.dashboard, `http://127.0.0.1:${port}`);
  if (process.platform === 'win32') {
    const bindings = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-NetTCPConnection -OwningProcess ${Number(status.pid)} -State Listen | Select-Object -ExpandProperty LocalAddress`], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/);
    assert.deepEqual(bindings, ['127.0.0.1']);
  }
  assert.equal(command('runtime', 'start').pid, status.pid);
  const { openContinuity } = await import(pathToFileURL(join(pkg, 'dist/packages/sdk/src/index.js')).href); host = openContinuity(home);
  const id = host.projects()[0].project_id;
  const fresh = () => host.inspection.page(id, '', 'sources', 20).items.map(i => i.record).find(r => r.state === 'fresh' && r.path === 'source.ts');
  await until(() => fresh() && command('runtime', 'status').projects?.[0]?.status === 'healthy'); const before = fresh().hash;
  const runs = command('runtime', 'status').projects[0].runs;
  const client = host.project(project);
  const memory = client.propose({ key: 'runtime.retry-budget', kind: 'decision', text: 'Provider retry budget is preserved across reconnect attempts.', from: { agent: 'runtime-fixture', session: 'package-smoke' } });
  assert.equal(memory.status, 'persist'); assert.equal(memory.provenance.trust, 'agent_observation'); assert(!memory.review);
  for (let i = 0; i < 10; i++) writeFileSync(join(project, 'source.ts'), `export const value = ${i + 2};`);
  await until(() => fresh().hash !== before && command('runtime', 'status').projects?.[0]?.status === 'healthy');
  assert.equal(command('runtime', 'status').projects[0].runs - runs, 1);
  command('sync'); assert.equal(command('doctor').integrity, 'ok');
  assert.equal(client.memory(memory.id).status, 'persist'); assert.equal(client.memory(memory.id).provenance.trust, 'agent_observation');
  browser = await chromium.launch(); const page = await browser.newPage(); const errors = [], external = [];
  page.on('pageerror', error => errors.push(error.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); }); page.on('request', r => { if (!r.url().startsWith(status.dashboard)) external.push(r.url()); });
  await page.goto(status.dashboard); await page.getByRole('heading', { name: 'Overview', exact: true }).waitFor();
  await page.getByRole('link', { name: 'Sources', exact: true }).click(); await page.getByRole('link', { name: 'source.ts', exact: true }).first().waitFor();
  await page.getByRole('link', { name: 'Diagnostics', exact: true }).click(); await page.getByText('Disabled · FTS5 active', { exact: true }).waitFor();
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  console.log(JSON.stringify({ packaged_runtime: true, registered_command: process.platform === 'win32' ? 'Task Scheduler' : 'runtime start', background: true, auto_sync_hash_changed: true, rapid_saves: 10, additional_runs: 1, dashboard: true, integrity: 'ok' }));
} finally {
  await browser?.close(); host?.close();
  if (cli) { command('runtime', 'stop'); if (startupInstalled) { assert.equal(command('startup', 'remove').installed, false); assert.equal(command('startup', 'status').installed, false); } }
  rmSync(root, { recursive: true, force: true });
}
