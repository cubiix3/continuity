import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

// Invoke via pnpm test:pack so npm_execpath identifies the exact pnpm installation.
if (!process.env.npm_execpath) throw new Error('Run pnpm test:pack.');
const root = mkdtempSync(join(tmpdir(), 'continuity-pack-'));
const run = (args, cwd = process.cwd()) => execFileSync(process.execPath, [process.env.npm_execpath, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
try {
  run(['pack', '--pack-destination', root]);
  const tarball = readdirSync(root).find(p => p.endsWith('.tgz')); assert.ok(tarball);
  const files = execFileSync('tar', ['-tf', join(root, tarball)], { encoding: 'utf8' }).trim().split(/\r?\n/);
  assert.ok(files.every(p => /^package\/(?:dist\/packages\/|docs\/|package.json$|README.md$|LICENSE$)/.test(p)), 'Unexpected package entry');
  assert.ok(!files.some(p => /(?:\.continuity|\.db|tests\/|scripts\/|node_modules\/)/.test(p)), 'Private files included');
  const install = join(root, 'install'); mkdirSync(install); writeFileSync(join(install, 'package.json'), '{"private":true}');
  run(['add', '--ignore-scripts', join(root, tarball)], install);
  const project = join(root, 'project'); mkdirSync(project); writeFileSync(join(project, 'README.md'), 'Reconnect uses bounded retries.');
  const manifest = JSON.parse(readFileSync(join(install, 'node_modules', 'continuity-local', 'package.json'), 'utf8'));
  const cli = join(install, 'node_modules', 'continuity-local', manifest.bin.continuity);
  const command = (...args) => JSON.parse(execFileSync(process.execPath, [cli, '--home', join(root, 'state'), '--project', project, '--json', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  command('init'); assert.equal(command('sync').files, 1); assert.equal(command('context', 'reconnect').items.length, 1); assert.equal(command('doctor').integrity, 'ok');
  // Also exercise the installed package-manager bin shim, not just its target.
  const help = run(['exec', 'continuity', '--help'], install); assert.match(help, /Persistent context/);
  assert.ok(files.includes('package/dist/packages/dashboard/public/index.html'));
  assert.ok(files.includes('package/dist/packages/dashboard/src/app.js'));
  const started = Date.now(); let startupMs;
  const dashboard = spawn(process.execPath, [cli, '--home', join(root, 'state'), 'dashboard', '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const url = await new Promise((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(() => reject(new Error('Dashboard startup timed out')), 10000);
      dashboard.on('error', error => { clearTimeout(timeout); reject(error); });
      dashboard.on('exit', () => { clearTimeout(timeout); reject(new Error('Dashboard exited before ready')); });
      dashboard.stderr.on('data', chunk => { output += chunk; const found = output.match(/http:\/\/127\.0\.0\.1:\d+/); if (found) { clearTimeout(timeout); resolve(found[0]); } });
    });
    startupMs = Date.now() - started;
    const page = await fetch(url); assert.equal(page.status, 200); assert.match(await page.text(), /Local project continuity/);
    assert.equal((await fetch(`${url}/app.js`)).status, 200); assert.equal((await fetch(`${url}/app.css`)).status, 200);
    const session = await (await fetch(`${url}/dashboard-api/session`, { headers: { 'X-Continuity-Dashboard': '1' } })).json();
    const registrations = await (await fetch(`${url}/dashboard-api/projects`, { headers: { 'X-Continuity-Token': session.capability } })).json(); assert.equal(registrations.projects.length, 1);
  } finally {
    if (dashboard.exitCode === null && dashboard.signalCode === null) {
      const closed = new Promise(resolve => dashboard.once('close', resolve)); dashboard.kill(); await closed;
    }
  }
  console.log(JSON.stringify({ packed: true, installed_in_fresh_project: true, bin: true, context: true, dashboard: true, dashboard_startup_ms: startupMs, file_count: files.length }));
} finally { rmSync(root, { recursive: true, force: true }); }
