import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { openContinuity } from '../packages/sdk/src/index.js';
import { saveContract, scopeKey } from '../packages/adapter-hooks/src/index.js';
import { FileSources } from '../packages/source-files/src/index.js';

// Real CLI calls and Git-backed setup can exceed Vitest's defaults on Windows CI.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });
const cli = resolve('dist/packages/cli/src/index.js');
let root: string, a: string, b: string, plain: string, home: string, host: ReturnType<typeof openContinuity>, ids: Record<'a' | 'b' | 'plain', string>;
const git = (path: string, ...args: string[]) => execFileSync('git', ['-C', path, ...args], { stdio: 'pipe' });
const past = (path: string) => { const hour = (Date.now() - 60 * 60 * 1000) / 1000; utimesSync(path, hour, hour); };
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'continuity shell ü ')); a = join(root, 'alpha'); b = join(root, 'beta'); plain = join(root, 'plain'); home = join(root, 'home');
  for (const dir of [a, b, plain]) { mkdirSync(join(dir, 'src'), { recursive: true }); writeFileSync(join(dir, 'README.md'), `# ${dir}\n`); writeFileSync(join(dir, 'src', 'app.js'), 'export const x = 1;\n'); }
  for (const dir of [a, b]) { git(dir, 'init', '-q'); git(dir, 'config', 'user.name', 'Fixture'); git(dir, 'config', 'user.email', 'fixture@example.invalid'); git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'Initial'); }
  for (const dir of [a, b, plain]) { for (const f of ['README.md', join('src', 'app.js')]) past(join(dir, f)); past(join(dir, 'src')); }
  host = openContinuity(home); ids = { a: host.init(a, 'Alpha').project_id, b: host.init(b, 'Beta').project_id, plain: host.init(plain, 'Plain').project_id };
  for (const dir of [a, b, plain]) await host.project(dir).sync();
});
afterEach(() => { host.close(); rmSync(root, { recursive: true, force: true }); });

const hookEnv = (extra: Record<string, string> = {}) => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE_CODE_|^CLAUDECODE$|^CONTINUITY_AUTOSAVE$|^CODEX_(DAEMON_SHUTDOWN_SOCKET|CI|THREAD_ID|SESSION_ID)$/.test(k))), CONTINUITY_AUTOSAVE: '1', ...extra });
const run = (provider: 'claude' | 'codex', event: string, input: unknown, extra: Record<string, string> = {}, cwd?: string) => {
  const started = Date.now();
  const result = spawnSync(process.execPath, ['--no-warnings', cli, '--home', home, 'integrate', provider, event], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', windowsHide: true, env: hookEnv(extra), maxBuffer: 64 * 1024 * 1024, ...(cwd ? { cwd } : {}) });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error, ms: Date.now() - started };
};
interface Call { tool?: string; changed?: string[]; more?: number; duration?: unknown; agent?: string; prompt?: string; hunks?: string[]; cwd?: string }
/** A Claude Code shell tool call, as its PostToolUse hook sees it; the command and output must never be stored. */
const shellInput = (session: string, cwd: string, call: Call = {}) => ({
  session_id: session, cwd, hook_event_name: 'PostToolUse', prompt_id: call.prompt ?? `${session}-turn`, tool_name: call.tool ?? 'Bash', tool_use_id: 'toolu_1',
  tool_input: { command: 'echo SECRET-COMMAND', description: 'fixture' }, ...(call.duration === undefined ? { duration_ms: 500 } : call.duration === null ? {} : { duration_ms: call.duration }), ...(call.agent ? { agent_id: call.agent } : {}),
  tool_response: { stdout: 'SECRET-OUTPUT', stderr: '', interrupted: false, isImage: false, ...(call.changed?.length || call.more ? { bashEditDiff: { files: (call.changed ?? []).map(filePath => ({ filePath, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: call.hunks ?? [] }] })), moreFiles: call.more ?? 0, changedFiles: call.changed ?? [] } } : {}) },
});
const shell = (session: string, cwd: string, call: Call = {}) => run('claude', 'tool-use', shellInput(session, cwd, call), {}, call.cwd);
/** Another session's journal entry for a project, at an exact time (the reader matches only the scope prefix). */
const journal = (project: 'a' | 'b' | 'plain', time: number, name = 'other') => {
  const dir = join(home, 'hooks', 'autosave', 'edits'); mkdirSync(dir, { recursive: true });
  const file = join(dir, `${scopeKey(ids[project])}-${name}`); writeFileSync(file, String(time)); return file;
};
const junction = (target: string, path: string) => symlinkSync(target, path, 'junction');
// Node 24's recursive rmSync skips some paths with non-ASCII names, like this fixture's: remove a flat folder by hand.
const removeFolder = (dir: string) => { for (const name of readdirSync(dir)) unlinkSync(join(dir, name)); rmdirSync(dir); };
const offered = (result: { stdout: string }) => result.stdout.length > 0 && JSON.parse(result.stdout).hookSpecificOutput?.additionalContext === saveContract();
const stateFiles = () => existsSync(join(home, 'hooks', 'autosave')) ? readdirSync(join(home, 'hooks', 'autosave')).filter(f => f.endsWith('.json')) : [];
const allState = () => { const dir = join(home, 'hooks', 'autosave'); return existsSync(dir) ? [...stateFiles().map(f => readFileSync(join(dir, f), 'utf8')), ...(existsSync(join(dir, 'edits')) ? readdirSync(join(dir, 'edits')).map(f => `${f}:${readFileSync(join(dir, 'edits', f), 'utf8')}`) : [])].join('\n') : ''; };

test('a Bash call whose report lists a project file is an edit and gets the offer; a read-only one is silent and writes nothing', () => {
  const quiet = shell('reader', a);
  expect([quiet.status, quiet.stdout, quiet.stderr]).toEqual([0, '', '']);
  expect(stateFiles()).toEqual([]);
  const edit = shell('writer', a, { changed: [join(a, 'src', 'app.js')] });
  expect(edit.status).toBe(0); expect(offered(edit)).toBe(true);
  // Later edits of the same turn are covered by that offer.
  expect(shell('writer', a, { changed: [join(a, 'README.md')] }).stdout).toBe('');
  // Neither the command nor its output is stored anywhere.
  const stored = allState();
  expect(stored).not.toContain('SECRET'); expect(stored).not.toContain('echo');
});

test('files outside every registered project, dependencies, build output and VCS or Continuity state do not count', () => {
  const outside = join(root, 'scratch'); mkdirSync(outside);
  expect(shell('s1', a, { changed: [join(outside, 'notes.txt')] }).stdout).toBe('');
  expect(shell('s1', a, { changed: [join(a, 'node_modules', 'x', 'index.js'), join(a, 'dist', 'app.js'), join(a, '.git', 'index'), join(a, 'build', 'out.js')] }).stdout).toBe('');
  expect(stateFiles()).toEqual([]);
  // One real file among them is enough, and a file deleted with its folder still binds through its ancestors.
  expect(offered(shell('s1', a, { changed: [join(a, 'dist', 'app.js'), join(a, 'src', 'old', 'gone.js')] }))).toBe(true);
});

test('edits in two registered projects are mixed: recorded, never offered, and no save can bind to one of them', () => {
  expect(shell('both', a, { changed: [join(a, 'src', 'app.js'), join(b, 'src', 'app.js')] }).stdout).toBe('');
  const [state] = stateFiles().map(f => JSON.parse(readFileSync(join(home, 'hooks', 'autosave', f), 'utf8')));
  expect(state).toMatchObject({ dirty: true, pending: false, scope: 'mixed' });
  // A later single-project edit in the same session stays mixed.
  expect(shell('both', a, { changed: [join(a, 'README.md')] }).stdout).toBe('');
  // Both projects are on record: a session whose command overlapped the mixed edit cannot claim it.
  expect(shell('beta-reader', b, { changed: [join(b, 'src', 'app.js')], duration: 10_000 }).stdout).toBe('');
});

test('two sessions in one workspace: only the one whose report is not shared with another session edit gets the offer', () => {
  // Session A edits through the shell; session B's long read-only command overlapped and its report lists A's file.
  expect(offered(shell('session-a', a, { changed: [join(a, 'src', 'app.js')] }))).toBe(true);
  expect(shell('session-b', a, { changed: [join(a, 'src', 'app.js')], duration: 20_000 })).toMatchObject({ stdout: '' });
  expect(stateFiles()).toHaveLength(1);
  // A Codex edit of the same workspace while Claude's command ran makes Claude's report ambiguous as well.
  run('codex', 'tool-use', { session_id: 'codex-1', cwd: b, hook_event_name: 'PostToolUse', tool_name: 'apply_patch', turn_id: 't1' }, { CONTINUITY_AUTOSAVE: '1' });
  expect(shell('claude-c', b, { changed: [join(b, 'README.md')], duration: 10_000 }).stdout).toBe('');
  // The same session's own earlier edit never makes its report ambiguous.
  expect(offered(shell('session-a', a, { changed: [join(a, 'README.md')], prompt: 'next-turn' }))).toBe(true);
});

test('an edit by another session before the command started does not block the report', async () => {
  run('codex', 'tool-use', { session_id: 'codex-early', cwd: a, hook_event_name: 'PostToolUse', tool_name: 'apply_patch', turn_id: 't1' });
  await new Promise(done => setTimeout(done, 2100));
  expect(offered(shell('claude-late', a, { changed: [join(a, 'src', 'app.js')], duration: 100 }))).toBe(true);
});

test('without Git, or through PowerShell, the indexed files show the edit; nothing changed stays silent', () => {
  // No Git: the provider never reports; a Bash call that changed nothing stays silent.
  expect(shell('plain-read', plain).stdout).toBe('');
  writeFileSync(join(plain, 'src', 'app.js'), 'export const x = 2;\n');
  expect(offered(shell('plain-edit', plain))).toBe(true);
  // PowerShell reports nothing even in a Git tree: the bounded check sees a modified indexed file...
  expect(shell('ps-read', a, { tool: 'PowerShell' }).stdout).toBe('');
  writeFileSync(join(a, 'README.md'), '# changed\n');
  expect(offered(shell('ps-edit', a, { tool: 'PowerShell' }))).toBe(true);
  // ...and a new file beside the indexed ones.
  writeFileSync(join(b, 'src', 'added.js'), 'export const y = 1;\n');
  expect(offered(shell('ps-new', b, { tool: 'PowerShell' }))).toBe(true);
});

test('a sub-agent shell edit is recorded for the session but never offered to the sub-agent; a truncated report is not bound', () => {
  expect(shell('parent', a, { changed: [join(a, 'src', 'app.js')], agent: 'sub-1' }).stdout).toBe('');
  const [state] = stateFiles().map(f => JSON.parse(readFileSync(join(home, 'hooks', 'autosave', f), 'utf8')));
  expect(state).toMatchObject({ dirty: true, pending: false });
  expect(shell('truncated', a, { more: 12 }).stdout).toBe('');
  expect(stateFiles()).toHaveLength(1);
});

test('an edit of another project from this session is mixed: never offered, and journaled for that project', () => {
  // Stop could never apply a save made in alpha for a beta edit, so the turn is mixed instead of offered.
  expect(shell('cross', a, { changed: [join(b, 'src', 'app.js')] }).stdout).toBe('');
  const [crossed] = stateFiles().map(f => JSON.parse(readFileSync(join(home, 'hooks', 'autosave', f), 'utf8')));
  expect(crossed).toMatchObject({ dirty: true, pending: false, scope: 'mixed' });
  // The beta edit is on record: a beta session whose command overlapped it cannot claim it.
  expect(shell('beta-reader', b, { changed: [join(b, 'src', 'app.js')], duration: 10_000 }).stdout).toBe('');
});

test('a created file, a rename and a worktree of the same project: each binds to its own workspace', () => {
  // A registered worktree is its own workspace: its own edit is offered, an edit of the primary checkout is mixed.
  const worktree = join(root, 'alpha-wt');
  git(a, 'worktree', 'add', '-q', '-b', 'wt', worktree); host.workspace(a, worktree);
  expect(offered(shell('in-worktree', worktree, { changed: [join(worktree, 'README.md')] }))).toBe(true);
  expect(shell('to-primary', worktree, { changed: [join(a, 'README.md')] }).stdout).toBe('');
  const states = stateFiles().map(f => JSON.parse(readFileSync(join(home, 'hooks', 'autosave', f), 'utf8')) as { scope?: string });
  expect(states.filter(s => s.scope === 'mixed')).toHaveLength(1);
  // A new file, and a rename whose old path is gone, are edits of the project (beta: alpha is on record above).
  writeFileSync(join(b, 'src', 'created.js'), 'export const y = 1;\n');
  expect(offered(shell('creator', b, { changed: [join(b, 'src', 'created.js')] }))).toBe(true);
  mkdirSync(join(plain, 'lib')); renameSync(join(plain, 'src', 'app.js'), join(plain, 'lib', 'app.js'));
  expect(offered(shell('mover', plain, { changed: [join(plain, 'src', 'app.js'), join(plain, 'lib', 'app.js')] }))).toBe(true);
});

test('the journal window: duration plus a 1.5 s margin, 60 s without a valid duration, odd entries ignored', () => {
  // Another session's edit 0.5 s before a 1 s command started is inside the margin; 3 s before is not.
  const now = Date.now(), early = journal('a', now - 1000 - 500);
  expect(shell('m1', a, { changed: [join(a, 'src', 'app.js')], duration: 1000 }).stdout).toBe('');
  writeFileSync(early, String(now - 1000 - 3000));
  expect(offered(shell('m2', a, { changed: [join(a, 'src', 'app.js')], duration: 1000 }))).toBe(true);
  // Without a duration, or with an invalid one, the window is 60 s.
  journal('b', Date.now() - 30_000);
  for (const duration of [null, -100_000, 'slow']) expect(shell(`d${String(duration)}`, b, { changed: [join(b, 'src', 'app.js')], duration }).stdout).toBe('');
  // An entry dated in the future (the clock was set back) and a half-written temporary file are ignored.
  journal('plain', Date.now() + 10 * 60_000);
  writeFileSync(join(home, 'hooks', 'autosave', 'edits', `${scopeKey(ids.plain)}-writer.123.tmp`), String(Date.now()));
  expect(offered(shell('future', plain, { changed: [join(plain, 'src', 'app.js')], duration: 1000 }))).toBe(true);
});

test('Claude and Codex sessions with the same id are different sessions', () => {
  run('codex', 'tool-use', { session_id: 'same-id', cwd: a, hook_event_name: 'PostToolUse', tool_name: 'apply_patch', turn_id: 't1' });
  expect(shell('same-id', a, { changed: [join(a, 'src', 'app.js')], duration: 10_000 }).stdout).toBe('');
});

test('the overlap race: the first hook to run wins, so an overlapping reader can take a writer offer (documented limit)', () => {
  // B's read-only command overlapped A's edit and B's hook ran first: B's report listed A's file, and A's is ambiguous.
  expect(offered(shell('reader-first', a, { changed: [join(a, 'src', 'app.js')], duration: 2000 }))).toBe(true);
  expect(shell('writer-second', a, { changed: [join(a, 'src', 'app.js')], duration: 5000 }).stdout).toBe('');
});

test('reported paths bind by their real folder, one report binds at most 50 paths, and odd paths never bind', () => {
  mkdirSync(join(a, 'node_modules', 'pkg'), { recursive: true });
  junction(join(a, 'src'), join(a, 'build'));
  junction(join(a, 'node_modules', 'pkg'), join(a, 'src', 'pkg'));
  // One session, a new turn per step: its own journal entries never make its reports ambiguous.
  const step = (prompt: string, call: Call, cwd = a) => shell('binder', cwd, { ...call, prompt });
  // Through a junction into node_modules: denied. A real source file reached through a junction named build: counted.
  expect(step('j1', { changed: [join(a, 'src', 'pkg', 'index.js')] }).stdout).toBe('');
  expect(offered(step('j2', { changed: [join(a, 'build', 'app.js')] }))).toBe(true);
  // Many denied folders before a real file do not hide it.
  const vendor = Array.from({ length: 25 }, (_, i) => join(a, 'node_modules', `dep-${i}`, 'index.js'));
  expect(offered(step('vendor', { changed: [...vendor, join(a, 'README.md')] }))).toBe(true);
  // Only the first 50 paths are read.
  const outside = Array.from({ length: 50 }, (_, i) => join(root, 'scratch', `f${i}.txt`));
  expect(step('capped', { changed: [...outside, join(a, 'README.md')] }).stdout).toBe('');
  // Relative paths and paths with a NUL character are dropped, even where they would resolve.
  expect(step('relative', { changed: ['src/app.js'], cwd: a }).stdout).toBe('');
  expect(step('nul', { changed: [`${join(a, 'src', 'app.js')}${String.fromCharCode(0)}x`] }).stdout).toBe('');
  // Denial is relative to the bound root, not to the session directory.
  mkdirSync(join(a, 'dist'));
  expect(step('in-dist', { changed: [join(a, 'dist', 'app.js')] }, join(a, 'dist')).stdout).toBe('');
  expect(offered(step('control', { changed: [join(a, 'README.md')] }))).toBe(true);
});

test('a Bash call below the root of a Git tree trusts the report: no bounded check runs', () => {
  writeFileSync(join(a, 'src', 'app.js'), 'export const x = 3;\n');
  expect(shell('subdir', join(a, 'src'), { duration: 10_000 })).toMatchObject({ status: 0, stdout: '' });
});

test('the bounded check takes only files the scanner would take, never through a link', () => {
  // Tool output beside indexed files: caches, build info, source maps, swap files, gitignored output and secret-looking names.
  writeFileSync(join(a, '.gitignore'), 'src/gen.js\n'); past(join(a, '.gitignore'));
  for (const file of ['.eslintcache', 'tsconfig.tsbuildinfo', join('src', 'app.js.map'), join('src', '.app.js.swp'), join('src', 'gen.js'), join('src', '.env'), join('src', 'credentials.json')]) writeFileSync(join(a, file), 'x\n');
  expect(shell('generated', a, { tool: 'PowerShell' }).stdout).toBe('');
  // A new file the scanner would index counts, even when copied with an older modification time (where the file system
  // records creation times).
  copyFileSync(join(a, 'src', 'app.js'), join(a, 'src', 'copy.js')); past(join(a, 'src', 'copy.js'));
  if (statSync(join(a, 'src', 'copy.js')).birthtimeMs > Date.now() - 60_000) expect(offered(shell('copied', a, { tool: 'PowerShell' }))).toBe(true);
  // A folder replaced by a junction is not followed, even when files behind it are new.
  const elsewhere = join(root, 'elsewhere'); mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, 'app.js'), 'export const x = 9;\n'); writeFileSync(join(elsewhere, 'new.js'), 'export const y = 9;\n');
  removeFolder(join(plain, 'src')); junction(elsewhere, join(plain, 'src'));
  expect(shell('linked-folder', plain).stdout).toBe('');
  // An indexed file replaced by a file link is not followed (only where this account may create links).
  let linked = true;
  unlinkSync(join(plain, 'README.md'));
  try { symlinkSync(join(elsewhere, 'app.js'), join(plain, 'README.md'), 'file'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error; linked = false; }
  if (linked) expect(shell('linked-file', plain).stdout).toBe('');
});

test('the source adapter lists only files scan would take, and examines nothing through a link', () => {
  const project = join(root, 'direct'), outside = join(root, 'outside');
  for (const dir of [join(project, 'src'), join(project, 'nested'), join(project, 'gen'), outside]) mkdirSync(dir, { recursive: true });
  // Folders that became ignored or a nested checkout after indexing, a linked folder, and new files scan would skip.
  writeFileSync(join(project, '.gitignore'), 'src/gen.js\ngen/\n');
  for (const file of ['src/app.js', 'nested/y.js', 'gen/a.js']) writeFileSync(join(project, file), 'x\n');
  mkdirSync(join(project, 'nested', '.git'));
  writeFileSync(join(outside, 'x.js'), 'x\n');
  junction(outside, join(project, 'lib'));
  let fileLink = true;
  try { symlinkSync(join(outside, 'x.js'), join(project, 'src', 'link.js'), 'file'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error; fileLink = false; }
  for (const file of ['src/new.js', 'src/credentials.json', 'src/gen.js', 'src/app.js.map']) writeFileSync(join(project, file), 'x\n');
  writeFileSync(join(outside, 'h.js'), 'x\n'); linkSync(join(outside, 'h.js'), join(project, 'src', 'hard.js'));
  const real = realpathSync.native(project), canonical = process.platform === 'win32' ? real.toLowerCase() : real;
  const changed = new FileSources().changedSince({ project_id: 'direct', root: canonical, name: 'direct' } as never, ['src/app.js', 'lib/x.js', 'nested/y.js', 'gen/a.js', ...(fileLink ? ['src/link.js'] : [])], Date.now() - 60_000);
  expect(changed.map(file => relative(real, file).split(sep).join('/')).sort()).toEqual(['src/app.js', 'src/new.js']);
  // The local source scope applies too.
  const scoped = new FileSources(() => [], { include: ['src/app.js'] }).changedSince({ project_id: 'direct', root: canonical, name: 'direct' } as never, ['src/app.js'], Date.now() - 60_000);
  expect(scoped.map(file => relative(real, file).split(sep).join('/'))).toEqual(['src/app.js']);
});

test.runIf(process.platform === 'win32')('the source adapter never opens what an indexed file link points to (a named pipe here)', async () => {
  const pipe = `\\\\.\\pipe\\continuity-shell-${process.pid}-${Date.now()}`;
  let connections = 0;
  const server = createServer(socket => { connections++; socket.destroy(); });
  await new Promise<void>(done => server.listen(pipe, done));
  try {
    unlinkSync(join(plain, 'README.md'));
    try { symlinkSync(pipe, join(plain, 'README.md'), 'file'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error; return; }
    const real = realpathSync.native(plain), canonical = real.toLowerCase();
    expect(new FileSources().changedSince({ project_id: 'plain', root: canonical, name: 'plain' } as never, ['README.md', 'src/app.js'], 0).map(file => relative(real, file))).toEqual([join('src', 'app.js')]);
    await new Promise(done => setTimeout(done, 300));
    expect(connections).toBe(0);
  } finally { await new Promise(done => server.close(done)); }
});

test('the bounded check skips a folder that became a nested checkout after it was indexed', () => {
  mkdirSync(join(plain, 'src', '.git'));
  writeFileSync(join(plain, 'src', 'app.js'), 'export const x = 5;\n');
  expect(shell('nested', plain).stdout).toBe('');
  writeFileSync(join(plain, 'README.md'), '# changed\n');
  expect(offered(shell('nested', plain, { prompt: 'control' }))).toBe(true);
});

test('the bounded check does not count again what an earlier edit of this session already counted', () => {
  writeFileSync(join(plain, 'src', 'app.js'), 'export const x = 4;\n');
  expect(offered(shell('turns', plain, { tool: 'PowerShell', duration: 30_000, prompt: 'turn-1' }))).toBe(true);
  expect(shell('turns', plain, { tool: 'PowerShell', duration: 30_000, prompt: 'turn-2' }).stdout).toBe('');
});

test('hook input beyond 1 MiB still counts; input beyond the limit is read to the end and ignored', () => {
  const big = shell('big', a, { changed: [join(a, 'src', 'app.js')], hunks: Array.from({ length: 2048 }, () => `+${'x'.repeat(1024)}`) });
  expect(big.error).toBeUndefined(); expect(offered(big)).toBe(true);
  const huge = run('claude', 'tool-use', JSON.stringify(shellInput('huge', a, { changed: [join(a, 'README.md')] })).replace('SECRET-OUTPUT', 'y'.repeat(17 * 1024 * 1024)));
  expect(huge).toMatchObject({ status: 0, stdout: '', error: undefined });
  // Codex hooks and Stop read their input after the CLI loads: oversized input is read to the end there too.
  const oversized = JSON.stringify({ session_id: 'huge', cwd: a, hook_event_name: 'Stop', padding: 'y'.repeat(17 * 1024 * 1024) });
  for (const [provider, event] of [['codex', 'tool-use'], ['claude', 'stop']] as const) expect(run(provider, event, oversized)).toMatchObject({ status: 0, stdout: '', error: undefined });
});

test('the edit journal: never written through a link, entries expire after an hour', () => {
  const edit = [join(a, 'src', 'app.js')];
  const old = journal('b', Date.now() - 2 * 60 * 60_000, 'old'), recent = journal('b', Date.now() - 30 * 60_000, 'recent');
  const hour = (Date.now() - 2 * 60 * 60_000) / 1000; utimesSync(old, hour, hour);
  expect(offered(shell('cleaner', a, { changed: edit }))).toBe(true);
  expect([existsSync(old), existsSync(recent)]).toEqual([false, true]);
  // A journal folder that is a link fails closed: nothing is written behind it and nothing is offered.
  const edits = join(home, 'hooks', 'autosave', 'edits'), target = join(root, 'journal-target'); mkdirSync(target);
  removeFolder(edits); junction(target, edits);
  expect(shell('linked-journal', b, { changed: [join(b, 'src', 'app.js')] }).stdout).toBe('');
  expect(readdirSync(target)).toEqual([]);
});

test('the quiet path answers a read-only Bash call before the CLI loads', () => {
  const quiet = [], full = [];
  for (let i = 0; i < 5; i++) { quiet.push(shell(`q${i}`, a).ms); full.push(shell(`f${i}`, a, { tool: 'PowerShell' }).ms); }
  const median = (xs: number[]) => [...xs].sort((x, y) => x - y)[2]!;
  // Informative on CI; the quiet path skips loading the CLI and should be clearly faster.
  expect(median(quiet)).toBeLessThan(median(full));
});
