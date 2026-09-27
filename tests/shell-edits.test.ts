import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { openContinuity } from '../packages/sdk/src/index.js';
import { saveContract } from '../packages/adapter-hooks/src/index.js';

// Every hook call is a real CLI process; Windows CI runners need more than vitest's 5 s default.
vi.setConfig({ testTimeout: 60_000 });
const cli = resolve('dist/packages/cli/src/index.js');
let root: string, a: string, b: string, plain: string, home: string, host: ReturnType<typeof openContinuity>;
const git = (path: string, ...args: string[]) => execFileSync('git', ['-C', path, ...args], { stdio: 'pipe' });
const past = (path: string) => { const hour = (Date.now() - 60 * 60 * 1000) / 1000; utimesSync(path, hour, hour); };
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'continuity shell ü ')); a = join(root, 'alpha'); b = join(root, 'beta'); plain = join(root, 'plain'); home = join(root, 'home');
  for (const dir of [a, b, plain]) { mkdirSync(join(dir, 'src'), { recursive: true }); writeFileSync(join(dir, 'README.md'), `# ${dir}\n`); writeFileSync(join(dir, 'src', 'app.js'), 'export const x = 1;\n'); }
  for (const dir of [a, b]) { git(dir, 'init', '-q'); git(dir, 'config', 'user.name', 'Fixture'); git(dir, 'config', 'user.email', 'fixture@example.invalid'); git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'Initial'); }
  for (const dir of [a, b, plain]) { for (const f of ['README.md', join('src', 'app.js')]) past(join(dir, f)); past(join(dir, 'src')); }
  host = openContinuity(home); host.init(a, 'Alpha'); host.init(b, 'Beta'); host.init(plain, 'Plain');
  for (const dir of [a, b, plain]) await host.project(dir).sync();
});
afterEach(() => { host.close(); rmSync(root, { recursive: true, force: true }); });

const hookEnv = (extra: Record<string, string> = {}) => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE_CODE_|^CLAUDECODE$|^CONTINUITY_AUTOSAVE$|^CODEX_(DAEMON_SHUTDOWN_SOCKET|CI|THREAD_ID|SESSION_ID)$/.test(k))), CONTINUITY_AUTOSAVE: '1', ...extra });
const run = (provider: 'claude' | 'codex', event: string, input: unknown, extra: Record<string, string> = {}) => {
  const started = Date.now();
  const result = spawnSync(process.execPath, ['--no-warnings', cli, '--home', home, 'integrate', provider, event], { input: JSON.stringify(input), encoding: 'utf8', windowsHide: true, env: hookEnv(extra) });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, ms: Date.now() - started };
};
interface Call { tool?: string; changed?: string[]; more?: number; duration?: number; agent?: string; prompt?: string }
/** A Claude Code shell tool call, as its PostToolUse hook sees it; the command and output must never be stored. */
const shell = (session: string, cwd: string, call: Call = {}) => run('claude', 'tool-use', {
  session_id: session, cwd, hook_event_name: 'PostToolUse', prompt_id: call.prompt ?? `${session}-turn`, tool_name: call.tool ?? 'Bash', tool_use_id: 'toolu_1',
  tool_input: { command: 'echo SECRET-COMMAND', description: 'fixture' }, duration_ms: call.duration ?? 500, ...(call.agent ? { agent_id: call.agent } : {}),
  tool_response: { stdout: 'SECRET-OUTPUT', stderr: '', interrupted: false, isImage: false, ...(call.changed?.length || call.more ? { bashEditDiff: { files: (call.changed ?? []).map(filePath => ({ filePath, hunks: [] })), moreFiles: call.more ?? 0, changedFiles: call.changed ?? [] } } : {}) },
});
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

test('the quiet path answers a read-only Bash call before the CLI loads', () => {
  const quiet = [], full = [];
  for (let i = 0; i < 5; i++) { quiet.push(shell(`q${i}`, a).ms); full.push(shell(`f${i}`, a, { tool: 'PowerShell' }).ms); }
  const median = (xs: number[]) => [...xs].sort((x, y) => x - y)[2]!;
  // Informative on CI; the quiet path skips loading the CLI and should be clearly faster.
  expect(median(quiet)).toBeLessThan(median(full));
});
