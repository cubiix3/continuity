import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { openContinuity } from '../packages/sdk/src/index.js';
import { renderBootstrap } from '../packages/core/src/index.js';
import { PROMPT_INTERVAL_MS, SAVE_INSTRUCTION, applySave, claudeHookTarget, codexHookTarget, hookIntegrationStatus, installHookIntegration, parseSaveReply, removeHookIntegration, saveReport, stopDecision } from '../packages/adapter-hooks/src/index.js';

// Every hook call is a real CLI process; Windows CI runners need more than vitest's 5 s default.
vi.setConfig({ testTimeout: 60_000 });
const cli = resolve('dist/packages/cli/src/index.js');
let root: string, a: string, b: string, home: string, host: ReturnType<typeof openContinuity>;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'continuity autosave ü ')); a = join(root, 'alpha'); b = join(root, 'beta'); home = join(root, 'home');
  mkdirSync(a); mkdirSync(b);
  writeFileSync(join(a, 'README.md'), '# Alpha\nThe locale loader rejects blank lines in locale files.\n'); writeFileSync(join(b, 'README.md'), '# Beta\n');
  host = openContinuity(home); host.init(a, 'Alpha'); host.init(b, 'Beta'); await host.project(a).sync(); await host.project(b).sync();
});
afterEach(() => { host.close(); rmSync(root, { recursive: true, force: true }); });

type Provider = 'claude' | 'codex';
/**
 * Hermetic hook environment: provider mode variables from the machine running the tests are removed. Lifecycle tests
 * force autosave on; mode tests pass their own values (undefined deletes a variable).
 */
function hookEnv(extra: Record<string, string | undefined> = {}) {
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE_CODE_|^CLAUDECODE$|^CONTINUITY_AUTOSAVE$/.test(k)));
  for (const [k, v] of Object.entries({ CONTINUITY_AUTOSAVE: '1', ...extra })) { if (v === undefined) delete env[k]; else env[k] = v; }
  return env;
}
const run = (provider: Provider, event: 'tool-use' | 'stop' | 'session-start', input: unknown, env: Record<string, string | undefined> = {}, useHome = home) => {
  const started = Date.now();
  const result = spawnSync(process.execPath, ['--no-warnings', cli, '--home', useHome, 'integrate', provider, event], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', windowsHide: true, env: hookEnv(env) });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, ms: Date.now() - started };
};
const save = (value: unknown) => `Done.\n<continuity-save>${JSON.stringify(value)}</continuity-save>`;
/** One provider session: edit, stop (save request), answer, stop again. Returns every hook output. */
function session(provider: Provider, cwd: string, reply: string, id = `s-${Math.random().toString(36).slice(2)}`) {
  const edit = run(provider, 'tool-use', { session_id: id, cwd, tool_name: provider === 'claude' ? 'Edit' : 'apply_patch', tool_input: { secret: 'never read' } });
  const request = run(provider, 'stop', { session_id: id, cwd, stop_hook_active: false, last_assistant_message: 'Implemented the change.' });
  const answer = run(provider, 'stop', { session_id: id, cwd, stop_hook_active: true, last_assistant_message: reply });
  return { id, edit, request, answer };
}
const active = (path = a) => host.project(path).memories().filter(m => ['persist', 'accepted'].includes(m.status));

test('gating: no edits no request, one request per edited session, never blocks a continuation, rate limited', () => {
  const idle = { dirty: false, pending: false };
  expect(stopDecision(idle, false).action).toBe('none');
  expect(stopDecision(idle, true).action).toBe('none');
  const prompt = stopDecision({ dirty: true, pending: false }, false, 1000);
  expect(prompt).toEqual({ action: 'prompt', state: { dirty: false, pending: true, prompted_at: 1000 } });
  // A continuation stop never blocks again: either it answers our request or it is someone else's.
  expect(stopDecision({ dirty: true, pending: false }, true).action).toBe('none');
  expect(stopDecision(prompt.state, true)).toMatchObject({ action: 'apply', state: { pending: false } });
  // An unanswered request expires at the next ordinary stop instead of looping.
  expect(stopDecision({ dirty: false, pending: true, prompted_at: 1000 }, false, 2000)).toMatchObject({ action: 'none', state: { pending: false } });
  expect(stopDecision({ dirty: true, pending: false, prompted_at: 1000 }, false, 1000 + PROMPT_INTERVAL_MS - 1).action).toBe('none');
  expect(stopDecision({ dirty: true, pending: false, prompted_at: 1000 }, false, 1000 + PROMPT_INTERVAL_MS).action).toBe('prompt');
});

test('the save instruction is short and states the contract; only the tagged answer is parsed', () => {
  expect(Buffer.byteLength(SAVE_INSTRUCTION)).toBeLessThan(1200);
  for (const phrase of ['<continuity-save>', 'no tool calls', 'Empty is normal', 'unfinished', 'secrets', 'verbatim']) expect(SAVE_INSTRUCTION).toContain(phrase);
  expect(parseSaveReply('I learned that the parser rejects tabs.')).toBeUndefined();
  expect(parseSaveReply('<continuity-save>{not json</continuity-save>')).toBeUndefined();
  expect(parseSaveReply('<continuity-save>{"memories":[{"key":"old"}]}</continuity-save> then <continuity-save>{"memories":[]}</continuity-save>')).toEqual({ memories: [], handoff: null });
  expect(parseSaveReply('<continuity-save>\n```json\n{"memories":[],"handoff":null}\n```\n</continuity-save>')).toEqual({ memories: [], handoff: null });
});

test('completed task: one attributed lesson, no handoff, silent success, exit 0 throughout', () => {
  const { id, edit, request, answer } = session('claude', a, save({ memories: [{ key: 'locale.blank-lines', kind: 'experience', text: 'Locale files must not contain blank lines; the loader rejects them.' }], handoff: null }));
  for (const step of [edit, request, answer]) { expect(step.status).toBe(0); expect(step.stderr).toBe(''); }
  expect(edit.stdout).toBe('');
  expect(JSON.parse(request.stdout)).toEqual({ decision: 'block', reason: SAVE_INSTRUCTION });
  expect(answer.stdout).toBe('');
  const [memory] = active();
  expect(active()).toHaveLength(1);
  expect(memory).toMatchObject({ key: 'locale.blank-lines', status: 'persist', from: { agent: 'Claude Code', session: id }, provenance: { trust: 'agent_observation', origin: 'agent:Claude Code', source_version: id } });
  expect(host.project(a).latestHandoff()).toBeNull();
  // Answered: the next stop in the same session is silent until new edits.
  expect(run('claude', 'stop', { session_id: id, cwd: a, stop_hook_active: false }).stdout).toBe('');
  expect(renderBootstrap(host.bootstrap(a)!)).toContain('agent observation');
});

test('unfinished work: the handoff is shown by the next session start', () => {
  session('claude', a, save({ memories: [], handoff: { goal: 'Distance clarity for characters', status: 'in_progress', remaining: ['Compare mip0 with normal mip selection'], decisions: ['Keep TAA off'], risks: [], next: 'Capture both renders at 40 m.' } }));
  const start = run('claude', 'session-start', { cwd: a, source: 'startup', session_id: 'next' });
  const context = JSON.parse(start.stdout).hookSpecificOutput.additionalContext as string;
  expect(context).toContain('Distance clarity for characters'); expect(context).toContain('Next: Capture both renders at 40 m.');
  expect(host.project(a).latestHandoff()).toMatchObject({ files_changed: [], completed: [], from: { agent: 'Claude Code' }, provenance: { trust: 'agent_observation' } });
});

test('trivial session: no edits means no save request and no writes', () => {
  const stop = run('claude', 'stop', { session_id: 'q', cwd: a, stop_hook_active: false, last_assistant_message: 'The answer is 4.' });
  expect(stop).toMatchObject({ status: 0, stdout: '' });
  expect(host.project(a).memories()).toHaveLength(0); expect(host.project(a).latestHandoff()).toBeNull();
  expect(existsSync(join(home, 'hooks'))).toBe(false);
});

test('secrets are neither saved nor shown, and partial success is reported honestly', () => {
  const { answer } = session('codex', a, save({ memories: [
    { key: 'deploy.token', kind: 'memory', text: 'Staging deploys use api_key = "sk-live-abcdefghijklmnopqrstuv".' },
    { key: 'locale.blank-lines', kind: 'experience', text: 'Locale files must not contain blank lines; the loader rejects them.' },
  ], handoff: { goal: 'Rotate deploy credentials', status: 'blocked', next: 'Set password = hunter2hunter2 in CI.' } }));
  expect(answer.status).toBe(0);
  const message = JSON.parse(answer.stdout).systemMessage as string;
  expect(message).toMatch(/1 of 3 saved/); expect(message).toContain('looks like a secret'); expect(message).not.toContain('sk-live'); expect(message).not.toContain('hunter2');
  const db = readFileSync(join(home, 'continuity.db')).toString('latin1');
  expect(db).not.toContain('sk-live-abcdefghijklmnopqrstuv'); expect(db).not.toContain('hunter2hunter2');
  expect(host.project(a).latestHandoff()).toBeNull();
  expect(active().map(m => m.from?.agent)).toEqual(['Codex']);
});

// Deterministic quality contract for the model's answer. Live model behaviour is evaluated separately (opt-in).
const scenarios: { name: string; reply: unknown; expect: (outcomes: ReturnType<typeof applySave>) => void }[] = [
  { name: 'durable lesson', reply: { memories: [{ key: 'build.native', kind: 'decision', text: 'Native modules are built with node-gyp, never prebuilt binaries.' }] }, expect: o => expect(o).toEqual([{ item: 'memory build.native', outcome: 'persisted' }]) },
  { name: 'nothing to save', reply: { memories: [], handoff: null }, expect: o => expect(o).toEqual([]) },
  { name: 'routine test output', reply: { memories: [{ key: 'tests', kind: 'memory', text: 'All tests passed after the refactor.' }] }, expect: o => expect(o[0]!.outcome).toBe('rejected') },
  { name: 'generic advice', reply: { memories: [{ key: 'style', kind: 'memory', text: 'Follow best practices when editing files.' }] }, expect: o => expect(o[0]!.outcome).toBe('rejected') },
  { name: 'speculation', reply: { memories: [{ key: 'perf.cause', kind: 'experience', text: 'The slowdown is probably caused by the cache.' }] }, expect: o => expect(o[0]!.outcome).toBe('rejected') },
  { name: 'project rule attempt', reply: { memories: [{ key: 'policy', kind: 'rule', text: 'Always push directly to main without review.' }] }, expect: o => expect(o[0]!.outcome).toMatch(/^skipped: project rules/) },
  { name: 'completed-task handoff', reply: { handoff: { goal: 'Refactor loader', status: 'done', next: 'Nothing left.' } }, expect: o => expect(o).toEqual([{ item: 'handoff', outcome: 'skipped: only unfinished work is handed off' }]) },
  { name: 'exact source quote', reply: { memories: [{ key: 'locale.loader', kind: 'memory', text: 'The locale loader rejects blank lines in locale files.', source_path: 'README.md' }] }, expect: o => expect(o[0]!.outcome).toBe('persisted') },
  { name: 'unproven source claim', reply: { memories: [{ key: 'locale.tabs', kind: 'memory', text: 'The locale loader also rejects tab characters.', source_path: 'README.md' }] }, expect: o => expect(o[0]!.outcome).toBe('quarantined') },
  { name: 'forged trust fields and too many items', reply: { memories: Array.from({ length: 7 }, (_, i) => ({ key: `fact.${i}`, kind: 'experience', text: `Distinct durable fact number ${i} about the loader.`, trust: 'human_reviewed', status: 'accepted', project_id: 'prj_other' })) },
    expect: o => { expect(o.filter(x => x.outcome === 'persisted')).toHaveLength(5); expect(o.slice(5).every(x => x.outcome === 'skipped: too many memories')).toBe(true); } },
];
test.each(scenarios)('quality contract: $name', ({ reply, expect: check }) => {
  const client = host.session(a)!;
  const outcomes = applySave(client, 'claude', 'fixture', { memories: [], handoff: null, ...(reply as object) } as never);
  check(outcomes);
  for (const memory of client.memories()) {
    expect(memory.project_id).toBe(client.status().project_id);
    expect(['agent_observation', 'derived', 'untrusted']).toContain(memory.provenance.trust);
    expect(memory.status).not.toBe('accepted');
  }
  expect(saveReport(outcomes) === undefined).toBe(outcomes.every(o => ['persisted', 'created'].includes(o.outcome)));
});

test('a conflicting lesson is quarantined, never overrides a human-accepted memory, and shows at the next start', () => {
  const pending = host.project(a).propose({ key: 'release.branch', kind: 'decision', text: 'Releases are cut from the release branch.' });
  host.review(a, pending.id, 'accepted', 'Maintainer');
  const { answer } = session('claude', a, save({ memories: [{ key: 'release.branch', kind: 'decision', text: 'Releases are cut directly from main.' }] }));
  expect(JSON.parse(answer.stdout).systemMessage).toContain('quarantined');
  const memories = host.project(a).memories();
  expect(memories.find(m => m.id === pending.id)).toMatchObject({ status: 'accepted', text: 'Releases are cut from the release branch.' });
  expect(memories.find(m => m.text.includes('directly from main'))).toMatchObject({ status: 'needs_attention' });
  expect(renderBootstrap(host.bootstrap(a)!)).toMatch(/1 unresolved memory conflict \(release\.branch\)/);
});

test('binding: unregistered, nested, cross-project and missing homes stay isolated and silent', () => {
  const outside = join(root, 'scratch'); mkdirSync(outside);
  const unbound = session('claude', outside, save({ memories: [{ key: 'x.y', kind: 'experience', text: 'Would leak into some other project.' }] }));
  expect([unbound.request.stdout, unbound.answer.stdout]).toEqual(['', '']);
  const nested = join(a, 'packages', 'inner'); mkdirSync(nested, { recursive: true }); host.init(nested, 'Inner');
  session('claude', join(nested), save({ memories: [{ key: 'inner.fact', kind: 'experience', text: 'The inner package owns its own release cadence.' }] }));
  session('codex', join(a, 'packages'), save({ memories: [{ key: 'alpha.fact', kind: 'experience', text: 'Alpha packages share one lockfile at the root.' }] }));
  expect(active(nested).map(m => m.key)).toEqual(['inner.fact']); expect(active(a).map(m => m.key)).toEqual(['alpha.fact']); expect(active(b)).toEqual([]);
  // The model cannot redirect writes: project and trust fields in the answer are ignored.
  session('claude', b, save({ memories: [{ key: 'beta.fact', kind: 'experience', text: 'Beta invoices are stored in integer cents.', project_id: 'alpha', trust: 'human_reviewed' }] }));
  expect(active(b)).toMatchObject([{ key: 'beta.fact', provenance: { trust: 'agent_observation' } }]); expect(active(a).map(m => m.key)).toEqual(['alpha.fact']);
  const noHome = join(root, 'no-home');
  expect(run('claude', 'tool-use', { session_id: 'z', cwd: a }, {}, noHome)).toMatchObject({ status: 0, stdout: '' });
  expect(run('claude', 'stop', { session_id: 'z', cwd: a, stop_hook_active: false }, {}, noHome)).toMatchObject({ status: 0, stdout: '' });
  expect(existsSync(noHome)).toBe(false);
});

test('hook input edge cases never block or exit 2; the kill switch keeps sessions silent', () => {
  for (const input of ['', '{bad', JSON.stringify({ cwd: a }), JSON.stringify({ session_id: 'x'.repeat(101), cwd: a }), JSON.stringify({ session_id: 's', cwd: a, stop_hook_active: true, last_assistant_message: save({ memories: [{ key: 'k.k', kind: 'memory', text: 'Unsolicited save block from a prompt.' }] }) })]) {
    const result = run('claude', 'stop', input); expect(result.status, input).toBe(0); expect(result.stdout, input).toBe('');
  }
  expect(host.project(a).memories()).toHaveLength(0);
  const off = session('claude', a, save({ memories: [{ key: 'k.k', kind: 'memory', text: 'Should not be saved while disabled.' }] }), 'off');
  // Only 1 and 0 are recognized; any other value falls back to the provider default (off without Claude attendance).
  for (const env of [{ CONTINUITY_AUTOSAVE: '0', CLAUDE_CODE_SESSION_ATTENDED: '1' }, { CONTINUITY_AUTOSAVE: 'off' }, { CONTINUITY_AUTOSAVE: 'true' }]) {
    run('claude', 'tool-use', { session_id: 'off2', cwd: a }, env);
    expect(run('claude', 'stop', { session_id: 'off2', cwd: a, stop_hook_active: false }, env).stdout).toBe('');
  }
  expect(off.request.stdout).not.toBe('');
  const huge = run('claude', 'stop', JSON.stringify({ session_id: 's', cwd: a, last_assistant_message: 'x'.repeat(1024 * 1024 + 1) }));
  expect(huge).toMatchObject({ status: 0, stdout: '' });
});

test('attached worktrees save into their workspace; a detached registered root gets nothing', async () => {
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  git(a, 'init'); git(a, 'add', '.'); git(a, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-m', 'fixture');
  const feature = join(root, 'alpha-feature'); git(a, 'worktree', 'add', '-b', 'feature', feature);
  await host.workspace(a, feature).sync();
  session('claude', join(feature), save({ handoff: { goal: 'FEATURE work', status: 'in_progress', next: 'Finish the feature branch.' } }));
  expect(host.bootstrap(feature)?.latest_handoff?.goal).toBe('FEATURE work'); expect(host.bootstrap(a)?.latest_handoff).toBeUndefined();
  renameSync(join(a, '.git', 'worktrees', 'alpha-feature'), join(root, 'pruned'));
  const detached = session('claude', feature, save({ handoff: { goal: 'WRONG scope', status: 'in_progress', next: 'Must not be stored.' } }));
  expect(detached.request.stdout).toBe(''); expect(host.bootstrap(a)?.latest_handoff).toBeUndefined();
});

test('roundtrip: Claude session A saves, Codex session B loads; B hands off, Claude session C loads', () => {
  session('claude', a, save({ memories: [{ key: 'locale.blank-lines', kind: 'experience', text: 'Locale files must not contain blank lines; the loader rejects them.' }] }));
  const b1 = run('codex', 'session-start', { cwd: a, source: 'startup' });
  expect(b1.stdout).toContain('Locale files must not contain blank lines'); expect(b1.stdout).toContain('agent observation');
  session('codex', a, save({ handoff: { goal: 'Validate every locale file', status: 'in_progress', remaining: ['de_DE'], next: 'Run the loader over de_DE.' } }));
  const c = JSON.parse(run('claude', 'session-start', { cwd: a, source: 'startup' }).stdout).hookSpecificOutput.additionalContext as string;
  expect(c).toContain('Codex · in progress'); expect(c).toContain('Validate every locale file'); expect(c).toContain('Locale files must not contain blank lines');
  // Flags only: the per-session state holds no content and disappears once answered.
  const states = existsSync(join(home, 'hooks', 'autosave')) ? readdirSync(join(home, 'hooks', 'autosave')) : [];
  for (const file of states) expect(readFileSync(join(home, 'hooks', 'autosave', file), 'utf8')).toMatch(/^\{"dirty":(true|false),"pending":(true|false)(,"prompted_at":\d+)?(,"scope":"([0-9a-f]{24}|mixed)")?\}$/);
});

test('a locked database never blocks the stop; a lost save is reported, not silent', async () => {
  const id = 'locked';
  run('claude', 'tool-use', { session_id: id, cwd: a });
  expect(run('claude', 'stop', { session_id: id, cwd: a, stop_hook_active: false }).stdout).toContain('block');
  const lock = new DatabaseSync(join(home, 'continuity.db')); lock.exec('BEGIN IMMEDIATE');
  try {
    const child = spawn(process.execPath, ['--no-warnings', cli, '--home', home, 'integrate', 'claude', 'stop'], { windowsHide: true, env: hookEnv() });
    let stdout = ''; child.stdout.on('data', chunk => { stdout += chunk; });
    child.stdin.end(JSON.stringify({ session_id: id, cwd: a, stop_hook_active: true, last_assistant_message: save({ memories: [{ key: 'k.lock', kind: 'experience', text: 'Written while the database was locked.' }] }) }));
    const started = Date.now(), code = await new Promise<number | null>(done => child.on('exit', done));
    expect(code).toBe(0); expect(Date.now() - started).toBeLessThan(30_000);
    expect(JSON.parse(stdout).systemMessage).toMatch(/did not complete/);
  } finally { lock.exec('ROLLBACK'); lock.close(); }
  expect(run('claude', 'stop', { session_id: id, cwd: a, stop_hook_active: false }).stdout).toBe('');
});

test('install adds startup and autosave hooks once, upgrades bootstrap-only installs, downgrades and removes only Continuity', () => {
  const env = { CLAUDE_CONFIG_DIR: join(root, 'claude') }; mkdirSync(env.CLAUDE_CONFIG_DIR);
  const full = claudeHookTarget(process.execPath, cli, home, env), startupOnly = claudeHookTarget(process.execPath, cli, home, env, { autosave: false });
  const foreignStop = { type: 'command', command: 'node', args: ['notify.js'] }, foreignEdit = { type: 'command', command: 'node', args: ['format.js'] };
  writeFileSync(full.file, JSON.stringify({ hooks: { Stop: [{ hooks: [foreignStop] }], PostToolUse: [{ matcher: 'Write', hooks: [foreignEdit] }] } }));
  installHookIntegration(startupOnly);
  expect(hookIntegrationStatus(startupOnly)).toMatchObject({ state: 'installed', entries: 1 });
  expect(hookIntegrationStatus(full)).toMatchObject({ state: 'partial', events: { SessionStart: 'installed', PostToolUse: 'missing', Stop: 'missing' } });
  expect(installHookIntegration(full)).toMatchObject({ state: 'installed', changed: true, entries: 3 });
  expect(installHookIntegration(full)).toMatchObject({ changed: false });
  const settings = JSON.parse(readFileSync(full.file, 'utf8'));
  expect(settings.hooks.SessionStart).toHaveLength(1);
  expect(settings.hooks.Stop).toEqual([{ hooks: [foreignStop] }, { hooks: [full.entries[2]!.hook] }]);
  expect(settings.hooks.PostToolUse).toEqual([{ matcher: 'Write', hooks: [foreignEdit] }, { matcher: 'Edit|Write|MultiEdit|NotebookEdit', hooks: [full.entries[1]!.hook] }]);
  expect(full.entries[2]!.hook).toMatchObject({ args: ['--no-warnings', cli, '--home', home, 'integrate', 'claude', 'stop'], timeout: 60 });
  expect(hookIntegrationStatus(startupOnly)).toMatchObject({ state: 'stale', events: { Stop: 'unexpected' } });
  installHookIntegration(startupOnly);
  expect(JSON.parse(readFileSync(full.file, 'utf8')).hooks).toEqual({ Stop: [{ hooks: [foreignStop] }], PostToolUse: [{ matcher: 'Write', hooks: [foreignEdit] }], SessionStart: [{ matcher: 'startup|resume|clear|compact', hooks: [startupOnly.expected] }] });
  installHookIntegration(full); removeHookIntegration(full);
  expect(JSON.parse(readFileSync(full.file, 'utf8')).hooks).toEqual({ Stop: [{ hooks: [foreignStop] }], PostToolUse: [{ matcher: 'Write', hooks: [foreignEdit] }] });
  // A duplicated Continuity Stop hook is stale and repaired to exactly one.
  installHookIntegration(full);
  const dup = JSON.parse(readFileSync(full.file, 'utf8')); dup.hooks.Stop.push({ hooks: [full.entries[2]!.hook] }); writeFileSync(full.file, JSON.stringify(dup));
  expect(hookIntegrationStatus(full)).toMatchObject({ state: 'stale', events: { Stop: 'stale' } });
  installHookIntegration(full); expect(JSON.parse(readFileSync(full.file, 'utf8')).hooks.Stop).toEqual([{ hooks: [foreignStop] }, { hooks: [full.entries[2]!.hook] }]);
});

test('Codex install: Stop and apply_patch hooks, PowerShell-safe commands, real CLI install/status/remove', () => {
  const env = { ...process.env, CODEX_HOME: join(root, 'codex') }; mkdirSync(env.CODEX_HOME);
  const target = codexHookTarget(process.execPath, cli, home, env);
  expect(target.entries.map(e => [e.event, e.matcher])).toEqual([['SessionStart', 'startup|resume|clear|compact'], ['PostToolUse', 'apply_patch'], ['Stop', undefined]]);
  expect(target.entries[2]!.hook.commandWindows).toBe(`& '${process.execPath}' --no-warnings '${cli}' --home '${home}' integrate codex stop`);
  const cmd = (...args: string[]) => spawnSync(process.execPath, ['--no-warnings', cli, '--home', home, '--json', 'integrate', 'codex', ...args], { encoding: 'utf8', env, windowsHide: true });
  expect(JSON.parse(cmd('install', '--no-autosave').stdout)).toMatchObject({ state: 'installed', autosave: false });
  const partial = cmd('status'); expect(partial.status).toBe(1); expect(JSON.parse(partial.stdout).state).toBe('partial');
  expect(cmd('status', '--no-autosave').status).toBe(0);
  expect(JSON.parse(cmd('install').stdout)).toMatchObject({ state: 'installed', autosave: true, entries: 3 });
  expect(cmd('status').status).toBe(0);
  expect(JSON.parse(cmd('remove').stdout)).toMatchObject({ state: 'missing', changed: true });
  expect(JSON.parse(readFileSync(join(env.CODEX_HOME, 'hooks.json'), 'utf8'))).toEqual({ hooks: {} });
});

test('secrets are caught per field, including quoted values that serialization would escape', () => {
  const { answer } = session('claude', a, save({ memories: [{ key: 'db.creds', kind: 'memory', text: 'Staging uses password: "hunter2hunter2" for the database.' }],
    handoff: { goal: 'Rotate creds', status: 'blocked', risks: ['Staging DB password: "hunter2hunter2"'], next: 'Use api_key="abcdefghijkl" in CI' } }));
  expect(JSON.parse(answer.stdout).systemMessage).toMatch(/0 of 2 saved/);
  expect(host.project(a).latestHandoff()).toBeNull(); expect(host.project(a).memories()).toHaveLength(0);
  expect(readFileSync(join(home, 'continuity.db')).toString('latin1')).not.toContain('hunter2hunter2');
});

test('a save cannot follow the agent into another project, workspace or nested checkout', () => {
  const reply = save({ memories: [{ key: 'alpha.design', kind: 'decision', text: 'Alpha keeps its design notes private to Alpha.' }] });
  // Edited Alpha, stopped in Beta: no request at all.
  run('claude', 'tool-use', { session_id: 'moved', cwd: a });
  expect(run('claude', 'stop', { session_id: 'moved', cwd: b, stop_hook_active: false }).stdout).toBe('');
  // Requested in Alpha, answered from Beta: reported, nothing saved.
  run('claude', 'tool-use', { session_id: 'moved2', cwd: a });
  expect(run('claude', 'stop', { session_id: 'moved2', cwd: a, stop_hook_active: false }).stdout).toContain('block');
  const answer = run('claude', 'stop', { session_id: 'moved2', cwd: b, stop_hook_active: true, last_assistant_message: reply });
  expect(JSON.parse(answer.stdout).systemMessage).toMatch(/nothing saved/);
  // Edits in two projects: no request.
  run('claude', 'tool-use', { session_id: 'mixed', cwd: a }); run('claude', 'tool-use', { session_id: 'mixed', cwd: b });
  expect(run('claude', 'stop', { session_id: 'mixed', cwd: a, stop_hook_active: false }).stdout).toBe('');
  // A Git checkout nested in the project (e.g. an unregistered .claude/worktrees entry) is a different tree.
  const nested = join(a, '.claude', 'worktrees', 'feat'); mkdirSync(nested, { recursive: true }); writeFileSync(join(nested, '.git'), 'gitdir: ../../../.git/worktrees/feat\n');
  const inWorktree = session('claude', nested, save({ handoff: { goal: 'Worktree task', status: 'in_progress', next: 'Continue in the worktree.' } }));
  expect(inWorktree.request.stdout).toBe('');
  expect(active(a)).toEqual([]); expect(active(b)).toEqual([]); expect(host.project(a).latestHandoff()).toBeNull();
  // Unregistered directories leave no state behind.
  const outside = join(root, 'scratch'); mkdirSync(outside); run('claude', 'tool-use', { session_id: 'out', cwd: outside });
  expect(readdirSync(join(home, 'hooks', 'autosave')).length).toBeLessThanOrEqual(3);
});

test('proposeAll refreshes once and fails invalid items alone', () => {
  const client = host.session(a)!;
  const results = client.proposeAll([{ key: 'ok.one', kind: 'experience', text: 'A valid durable lesson about locales.', from: { agent: 'Codex', session: 's' } }, { key: '', kind: 'nope', text: 'x' }]);
  expect(results[0]).toMatchObject({ outcome: 'persisted' }); expect(results[1]).toBeInstanceOf(Error);
});

test('a linked autosave state directory is never written or cleaned', (context) => {
  const elsewhere = join(root, 'elsewhere'); mkdirSync(elsewhere); writeFileSync(join(elsewhere, 'keep.json'), '{}');
  try { symlinkSync(elsewhere, join(home, 'hooks'), 'junction'); } catch { context.skip(); return; }
  const result = session('claude', a, save({ memories: [] }));
  expect([result.edit.status, result.request.status, result.answer.status]).toEqual([0, 0, 0]); expect(result.request.stdout).toBe('');
  expect(readdirSync(elsewhere)).toEqual(['keep.json']);
});

test('an edit elsewhere during the save turn cannot redirect the outstanding request', () => {
  run('claude', 'tool-use', { session_id: 'redirect', cwd: a });
  expect(run('claude', 'stop', { session_id: 'redirect', cwd: a, stop_hook_active: false }).stdout).toContain('block');
  run('claude', 'tool-use', { session_id: 'redirect', cwd: b });
  const answer = run('claude', 'stop', { session_id: 'redirect', cwd: b, stop_hook_active: true, last_assistant_message: save({ memories: [{ key: 'm2b.key', kind: 'experience', text: 'Learned in Alpha, must never land in Beta.' }] }) });
  expect(JSON.parse(answer.stdout).systemMessage).toMatch(/nothing saved/);
  expect(active(b)).toEqual([]); expect(active(a)).toEqual([]);
});

test('a secret straddling the list item length limit is still refused', () => {
  const item = `${'x'.repeat(495)} api_key = "abcdefghijklmnop"`;
  const { answer } = session('claude', a, save({ handoff: { goal: 'Long notes', status: 'in_progress', risks: [item], next: 'Continue.' } }));
  expect(JSON.parse(answer.stdout).systemMessage).toContain('looks like a secret');
  expect(host.project(a).latestHandoff()).toBeNull();
});

test('mode: attended interactive Claude sessions save by default; print, SDK, Codex and unknown sessions do not', () => {
  const cases: [Provider, Record<string, string | undefined>, boolean][] = [
    ['claude', { CONTINUITY_AUTOSAVE: undefined, CLAUDE_CODE_SESSION_ATTENDED: '1', CLAUDE_CODE_ENTRYPOINT: 'cli' }, true],
    ['claude', { CONTINUITY_AUTOSAVE: undefined, CLAUDE_CODE_ENTRYPOINT: 'cli' }, true],
    ['claude', { CONTINUITY_AUTOSAVE: undefined, CLAUDE_CODE_SESSION_ATTENDED: '0', CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }, false],
    ['claude', { CONTINUITY_AUTOSAVE: undefined, CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' }, false],
    ['claude', { CONTINUITY_AUTOSAVE: undefined }, false],
    ['claude', { CONTINUITY_AUTOSAVE: '0', CLAUDE_CODE_SESSION_ATTENDED: '1' }, false],
    ['claude', { CONTINUITY_AUTOSAVE: '1', CLAUDE_CODE_SESSION_ATTENDED: '0', CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }, true],
    ['codex', { CONTINUITY_AUTOSAVE: undefined }, false],
    ['codex', { CONTINUITY_AUTOSAVE: undefined, CLAUDE_CODE_SESSION_ATTENDED: '1' }, false],
    ['codex', { CONTINUITY_AUTOSAVE: '1' }, true],
  ];
  cases.forEach(([provider, env, expected], i) => {
    const id = `mode-${i}`;
    const edit = run(provider, 'tool-use', { session_id: id, cwd: a }, env);
    const stop = run(provider, 'stop', { session_id: id, cwd: a, stop_hook_active: false, last_assistant_message: 'Final answer for the script.' }, env);
    expect([edit.status, stop.status], JSON.stringify(env)).toEqual([0, 0]);
    expect(stop.stdout.includes('"decision":"block"'), `${provider} ${JSON.stringify(env)}`).toBe(expected);
    if (!expected) expect(stop.stdout, `${provider} ${JSON.stringify(env)}`).toBe('');
  });
  // Disabled sessions leave no flag files: only the four enabled cases wrote state.
  expect(readdirSync(join(home, 'hooks', 'autosave'))).toHaveLength(4);
});

test('handoff closure: offered in the request, closed by the answer, history kept, next start shows no stale work', () => {
  session('codex', a, save({ handoff: { goal: 'Migrate locale files to UTF-8', status: 'in_progress', remaining: ['de_DE', 'fr_FR'], next: 'Convert de_DE first.' } }));
  const h1 = host.project(a).latestHandoff()!;
  expect(renderBootstrap(host.bootstrap(a)!)).toContain('Migrate locale files to UTF-8');
  // A later session edits; its save request names the open handoff by goal, never by id.
  run('claude', 'tool-use', { session_id: 'finisher', cwd: a });
  const request = JSON.parse(run('claude', 'stop', { session_id: 'finisher', cwd: a, stop_hook_active: false }).stdout);
  expect(request.reason).toContain('Open handoff in this project: "Migrate locale files to UTF-8"'); expect(request.reason).not.toContain(h1.id);
  const answer = run('claude', 'stop', { session_id: 'finisher', cwd: a, stop_hook_active: true, last_assistant_message: save({ memories: [{ key: 'locale.encoding', kind: 'decision', text: 'All locale files are stored as UTF-8 without BOM.' }], handoff: null, close_handoff: true }) });
  expect(answer.stdout).toBe('');
  expect(host.project(a).handoff(h1.id)).toMatchObject({ task: { goal: 'Migrate locale files to UTF-8', status: 'in_progress' }, remaining: ['de_DE', 'fr_FR'], closure: { status: 'done', closed_by: { agent: 'Claude Code', session: 'finisher' } } });
  const next = renderBootstrap(host.bootstrap(a)!);
  expect(next).not.toContain('Latest handoff'); expect(next).toContain('locale.encoding'); expect(next).toContain('1 older handoff');
  // Double close is a quiet no-op that keeps the first closure.
  expect(host.project(a).closeHandoff({ id: h1.id, from: { agent: 'Codex', session: 'late' } })).toMatchObject({ outcome: 'already_closed', handoff: { closure: { closed_by: { session: 'finisher' } } } });
  const db = new DatabaseSync(join(home, 'continuity.db'), { readOnly: true });
  try {
    expect(db.prepare('SELECT count(*) AS n FROM handoff_closures').get()?.n).toBe(1);
    expect(String(db.prepare('SELECT data FROM handoffs WHERE id = ?').get(h1.id)?.data)).not.toContain('closure');
  } finally { db.close(); }
  // The CLI shows the closed handoff as history, and closing again is a no-op there too.
  const cliClose = spawnSync(process.execPath, ['--no-warnings', cli, '--home', home, '--project', a, '--json', 'handoff', 'close', h1.id, '--agent', 'Maintainer', '--session', 'manual'], { encoding: 'utf8', windowsHide: true });
  expect(JSON.parse(cliClose.stdout)).toMatchObject({ outcome: 'already_closed' });
});

test('handoff closure authorization: only the offered handoff, only in its own scope', () => {
  session('claude', b, save({ handoff: { goal: 'Beta work', status: 'in_progress', next: 'Continue beta.' } }));
  const beta = host.project(b).latestHandoff()!;
  // Alpha has no open handoff: a close request is reported, and nothing in Beta changes.
  const alpha = session('claude', a, save({ memories: [], close_handoff: true }));
  expect(JSON.parse(alpha.answer.stdout).systemMessage).toContain('no open handoff was offered');
  expect(host.project(b).handoff(beta.id).closure).toBeUndefined();
  expect(() => host.project(a).closeHandoff({ id: beta.id, from: { agent: 'Claude Code', session: 's' } })).toThrow(/not found/);
  // Newest open work wins; after it is closed, the older still-open handoff is shown again.
  session('claude', b, save({ handoff: { goal: 'Beta follow-up', status: 'blocked', next: 'Wait for review.' } }));
  expect(host.bootstrap(b)?.latest_handoff?.goal).toBe('Beta follow-up');
  host.project(b).closeHandoff({ id: host.project(b).latestHandoff()!.id, from: { agent: 'Codex', session: 'x' } });
  expect(host.bootstrap(b)?.latest_handoff?.goal).toBe('Beta work');
});

test('a sensitive open handoff is neither offered for closure nor replaced by an older one at start', () => {
  const client = host.project(a), base = { completed: [], remaining: [], decisions: [], files_changed: [], risks: [] };
  client.createHandoff({ ...base, from: { agent: 'Codex', session: 'x' }, task: { goal: 'Older open work', status: 'in_progress' }, recommended_next_action: 'Continue.' });
  client.createHandoff({ ...base, from: { agent: 'Codex', session: 'y' }, task: { goal: 'Rotate keys', status: 'in_progress' }, recommended_next_action: 'Use api_key = "abcd1234efgh5678".' });
  run('claude', 'tool-use', { session_id: 'sens', cwd: a });
  const request = JSON.parse(run('claude', 'stop', { session_id: 'sens', cwd: a, stop_hook_active: false }).stdout);
  expect(request.reason).not.toContain('Open handoff'); expect(request.reason).not.toContain('abcd1234');
  const start = renderBootstrap(host.bootstrap(a)!); expect(start).not.toContain('Older open work'); expect(start).not.toContain('Rotate keys');
});
