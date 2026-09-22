import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { openContinuity } from '../packages/sdk/src/index.js';
import { FileSources } from '../packages/source-files/src/index.js';

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

let root: string, project: string, other: string, home: string, id: string;
let host: ReturnType<typeof openContinuity>;
const paths = () => host.inspection.page(id, '', 'sources', 50).items.map(i => i.record).filter(r => 'state' in r && r.state === 'fresh').map(r => 'path' in r ? r.path : '').sort();
beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), 'continuity scope ü ')); home = join(root, 'state'); project = join(root, 'project space'); other = join(root, 'other');
  fs.mkdirSync(join(project, 'Dokumente Größe'), { recursive: true }); fs.mkdirSync(other);
  fs.writeFileSync(join(project, 'README.md'), 'Root source.');
  fs.writeFileSync(join(project, 'Dokumente Größe', 'decision.md'), 'Durable source decision.');
  fs.writeFileSync(join(project, 'Dokumente Größe', 'draft.md'), 'Draft implementation.');
  fs.writeFileSync(join(other, 'README.md'), 'Other project source.');
  host = openContinuity(home); id = host.init(project).project_id; host.init(other);
});
afterEach(() => { vi.restoreAllMocks(); host.close(); fs.rmSync(root, { recursive: true, force: true }); });

it('preserves default selection, preview is read-only, and clear restores it without changing identity', async () => {
  const identities = host.projects(), client = host.project(project);
  const direct = new FileSources(() => identities.map(p => p.root)).scan(identities.find(p => p.project_id === id)!);
  expect(host.previewSourceScope(project)).toMatchObject({ files: direct.length, bytes: direct.reduce((n, r) => n + Buffer.byteLength(r.content), 0), limit_exceeded: false });
  expect(host.previewSourceScope(project, { include: ['README.md'] })).toMatchObject({ files: 1 });
  expect(fs.existsSync(join(home, 'sources.json'))).toBe(false);
  expect(client.status().sync).toBeUndefined();
  expect(host.inspection.page(id, '', 'sources', 10).items).toEqual([]);
  await client.sync(); expect(paths()).toEqual(direct.map(r => r.path).sort());
  host.setSourceScope(project, { include: ['Dokumente Größe/**'], exclude: ['Dokumente Größe/draft.md'] });
  await client.sync(); expect(paths()).toEqual(['Dokumente Größe/decision.md']);
  host.setSourceScope(other, { include: ['README.md'] });
  host.clearSourceScope(project); await client.sync(); expect(paths()).toEqual(direct.map(r => r.path).sort());
  expect(host.sourceScope(host.project(other).status().project_id).filtered).toBe(true);
  expect(host.projects()).toEqual(identities);
});

it('supports allowlists and denylists, isolates projects, and intersects host selections', async () => {
  host.setSourceScope(project, { exclude: ['Dokumente Größe/**'] }); await host.project(project).sync(); expect(paths()).toEqual(['README.md']);
  host.setSourceScope(project, { include: ['Dokumente Größe/**'] }); await host.project(project).sync(); expect(paths()).toHaveLength(2);
  expect(host.previewSourceScope(other)).toMatchObject({ files: 1 });
  expect(host.sourceScope(host.project(other).status().project_id).filtered).toBe(false);
  const restricted = openContinuity(home, { sources: { include: ['README.md'] } });
  try { expect(restricted.previewSourceScope(project)).toMatchObject({ files: 0 }); } finally { restricted.close(); }
});

it('cannot override nested project, gitignore, secret, generated, symlink or hardlink exclusions', async () => {
  const nested = join(project, 'nested'); fs.mkdirSync(nested); fs.writeFileSync(join(nested, 'hidden.md'), 'Foreign nested source.'); host.init(nested);
  fs.mkdirSync(join(project, 'node_modules')); fs.writeFileSync(join(project, 'node_modules', 'generated.ts'), 'Generated code.');
  fs.writeFileSync(join(project, '.env'), 'PRIVATE_ENV'); fs.writeFileSync(join(project, 'credentials.json'), '{}');
  fs.writeFileSync(join(project, 'sensitive.md'), 'api_key=' + 'x'.repeat(30));
  fs.writeFileSync(join(project, 'ignored.md'), 'Ignored source.'); fs.writeFileSync(join(project, '.gitignore'), 'ignored.md\n');
  fs.symlinkSync(other, join(project, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.linkSync(join(other, 'README.md'), join(project, 'linked.md'));
  host.setSourceScope(project, { include: ['**'] }); await host.project(project).sync();
  expect(paths()).toEqual(['Dokumente Größe/decision.md', 'Dokumente Größe/draft.md', 'README.md']);
});

it('fails closed on malformed, oversized and unknown-field configs without resetting state', async () => {
  await host.project(project).sync(); const before = paths(), client = host.project(project);
  for (const bad of ['{', JSON.stringify({ version: 2, projects: {} }), JSON.stringify({ version: 1, projects: {}, extra: true }), ' '.repeat(65537), JSON.stringify({ version: 1, projects: { [id]: { include: ['../escape'] } } })]) {
    fs.writeFileSync(join(home, 'sources.json'), bad);
    await expect(client.sync()).rejects.toThrow('sources.json');
    expect(() => host.previewSourceScope(project, { include: ['README.md'] })).toThrow('sources.json');
    expect(() => host.setSourceScope(project, { include: ['README.md'] })).toThrow('sources.json');
    expect(host.doctor().problems.join(' ')).toContain('sources.json'); expect(paths()).toEqual(before);
    await expect(host.inspectionRetrievalHealth(id, '')).rejects.toThrow('sources.json');
  }
});

it('rejects unsafe and malformed patterns and forged selectors', () => {
  for (const value of ['C:/data/**', 'C:\\data', '\\\\server\\share', '//server/share', '/etc/**', '../x', 'a/../x', './x', 'a//x', '!**', '#comment', 'a\nx', 'a/***/x', '[bad', 'a\\b', '']) {
    expect(() => host.setSourceScope(project, { include: [value] })).toThrow();
  }
  expect(() => host.setSourceScope(project, { include: ['**'], project_id: id })).toThrow();
  expect(() => host.setSourceScope(project, undefined)).toThrow();
  expect(() => host.setSourceScope(join(root, 'unknown'), { include: ['**'] })).toThrow();
  expect(fs.existsSync(join(home, 'sources.json'))).toBe(false);
});

it('writes atomically, rejects concurrent writers, and leaves the previous file intact on rename failure', () => {
  host.setSourceScope(project, { include: ['README.md'] }); const path = join(home, 'sources.json'), before = fs.readFileSync(path, 'utf8');
  fs.writeFileSync(path + '.lock', '');
  expect(() => host.clearSourceScope(project)).toThrow('locked'); expect(fs.readFileSync(path, 'utf8')).toBe(before); fs.unlinkSync(path + '.lock');
  const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('Injected rename failure'); });
  expect(() => host.setSourceScope(project, { exclude: ['README.md'] })).toThrow('Injected rename failure'); rename.mockRestore();
  expect(fs.readFileSync(path, 'utf8')).toBe(before);
  expect(fs.readdirSync(home).filter(p => p.endsWith('.tmp') || p.endsWith('.lock'))).toEqual([]);
});

it('revalidates previews against the current filter and retains historical source rows', async () => {
  await host.project(project).sync();
  const resource = host.inspection.page(id, '', 'sources', 10).items.map(i => i.record).find(r => 'path' in r && r.path === 'README.md')!;
  if (!('id' in resource)) throw new Error('Expected source record');
  host.setSourceScope(project, { include: ['Dokumente Größe/**'] });
  expect(host.previewSource(id, '', String(resource.id))).toBeUndefined();
  expect(host.inspection.page(id, '', 'sources', 10).items.length).toBe(3);
});

it('reports bounded preview counts and oversized skips without raising any safety limits', async () => {
  fs.writeFileSync(join(project, 'too-large.md'), 'x'.repeat(65537));
  expect(host.previewSourceScope(project)).toMatchObject({ files: 3, skipped_oversized: 1, complete: true });
  const many = join(project, 'many'); fs.mkdirSync(many);
  for (let i = 0; i < 2001; i++) fs.writeFileSync(join(many, `${i}.md`), 'x');
  expect(host.previewSourceScope(project, { include: ['many/**'] })).toMatchObject({ files: 2001, bytes: 2001, limit_exceeded: true, complete: false });
  host.setSourceScope(project, { include: ['many/**'] }); await expect(host.project(project).sync()).rejects.toThrow('2,000 files / 8 MiB');
  const large = join(project, 'large'); fs.mkdirSync(large);
  for (let i = 0; i < 129; i++) fs.writeFileSync(join(large, `${i}.md`), 'x'.repeat(65536));
  expect(host.previewSourceScope(project, { include: ['large/**'] })).toMatchObject({ files: 129, bytes: 129 * 65536, limit_exceeded: true });
});

it('uses the same project filter in real worktrees, including existing clients', async () => {
  const git = (...args: string[]) => execFileSync('git', ['-C', project, ...args], { stdio: 'pipe' });
  git('init'); git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Fixture');
  const work = join(root, 'worktree ü'); git('worktree', 'add', '-b', 'scope', work);
  const client = host.workspace(project, work);
  host.setSourceScope(project, { include: ['README.md'] }); expect(await client.sync()).toMatchObject({ files: 1 });
  host.setSourceScope(project, { include: ['Dokumente Größe/**'] }); expect(await client.sync()).toMatchObject({ files: 2 });
  const context = await client.context({ task: 'Durable source decision' });
  expect(context.items.some(i => i.passage?.path === 'README.md')).toBe(false);
});

it('exercises CLI show, preview, set and clear with Unicode paths', () => {
  const cli = (...args: string[]) => JSON.parse(execFileSync(process.execPath, ['dist/packages/cli/src/index.js', '--home', home, '--project', project, '--json', 'sources', ...args], { encoding: 'utf8', stdio: 'pipe' }));
  expect(cli('show')).toMatchObject({ project_id: id, filtered: false });
  expect(cli('preview', '--include', 'Dokumente Größe/**')).toMatchObject({ files: 2 }); expect(fs.existsSync(join(home, 'sources.json'))).toBe(false);
  expect(cli('set', '--include', 'README.md')).toMatchObject({ filtered: true });
  expect(cli('preview')).toMatchObject({ files: 1 });
  expect(cli('clear')).toMatchObject({ filtered: false });
});
