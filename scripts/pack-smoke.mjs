import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
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
  const { openContinuity } = await import(pathToFileURL(join(install, 'node_modules', 'continuity-local', 'dist/packages/sdk/src/index.js')).href);
  const host = openContinuity(join(root, 'state'));
  try {
    const result = await host.project(project).agentContext({ task: 'reconnect', delivery_budget: 2048 });
    assert.equal(result.delivery.schema, 'continuity.agent-context/1');
    assert.equal(result.delivery.items.length, 1);
    assert.equal(Buffer.byteLength(JSON.stringify(result.delivery)), result.budget.used);
    assert.ok(result.budget.used <= 2048);
  } finally { host.close(); }
  // Also exercise the installed package-manager bin shim, not just its target.
  const help = run(['exec', 'continuity', '--help'], install); assert.match(help, /Persistent context/);
  console.log(JSON.stringify({ packed: true, installed_in_fresh_project: true, bin: true, context: true, file_count: files.length }));
} finally { rmSync(root, { recursive: true, force: true }); }
