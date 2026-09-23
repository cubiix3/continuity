import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { symlinkSync } from 'node:fs';
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
const run = (provider: Provider, event: 'tool-use' | 'stop' | 'session-start', input: unknown, env: NodeJS.ProcessEnv = {}, useHome = home) => {
  const started = Date.now();
  const result = spawnSync(process.execPath, ['--no-warnings', cli, '--home', useHome, 'integrate', provider, event], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env } });
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
  for (const env of [{ CONTINUITY_AUTOSAVE: '0' }, { CONTINUITY_AUTOSAVE: 'off' }]) {
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
    const child = spawn(process.execPath, ['--no-warnings', cli, '--home', home, 'integrate', 'claude', 'stop'], { windowsHide: true });
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
