import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { openContinuity } from '../packages/sdk/src/index.js';
import { renderBootstrap } from '../packages/core/src/index.js';
import { PROMPT_INTERVAL_MS, SAVE_REQUEST, applySave, claudeHookTarget, codexHookTarget, editDecision, hookIntegrationStatus, installHookIntegration, parseSaveReply, removeHookIntegration, saveContract, saveReport, stopDecision } from '../packages/adapter-hooks/src/index.js';

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
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE_CODE_|^CLAUDECODE$|^CONTINUITY_AUTOSAVE$|^CODEX_(DAEMON_SHUTDOWN_SOCKET|CI|THREAD_ID|SESSION_ID)$/.test(k)));
  for (const [k, v] of Object.entries({ CONTINUITY_AUTOSAVE: '1', ...extra })) { if (v === undefined) delete env[k]; else env[k] = v; }
  return env;
}
const run = (provider: Provider, event: 'tool-use' | 'stop' | 'session-start', input: unknown, env: Record<string, string | undefined> = {}, useHome = home) => {
  const started = Date.now();
  const result = spawnSync(process.execPath, ['--no-warnings', cli, '--home', useHome, 'integrate', provider, event], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', windowsHide: true, env: hookEnv(env) });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, ms: Date.now() - started };
};
/** The final answer of an edited turn: the normal text, an empty line, then the save line (hidden by CommonMark renderers). */
const save = (value: unknown) => `Done.\n\n[continuity-save]: <${JSON.stringify(value)}>`;
const edit = (provider: Provider, id: string, cwd: string, env: Record<string, string | undefined> = {}) => run(provider, 'tool-use', { session_id: id, cwd, tool_name: provider === 'claude' ? 'Edit' : 'apply_patch', tool_input: { secret: 'never read' } }, env);
const offer = (goal?: string) => ({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: saveContract(goal) } });
/** One edited provider turn: the edit gets the contract, and the turn's final answer carries the save. No extra turn. */
function session(provider: Provider, cwd: string, reply: string, id = `s-${Math.random().toString(36).slice(2)}`) {
  const changed = edit(provider, id, cwd);
  const answer = run(provider, 'stop', { session_id: id, cwd, stop_hook_active: false, last_assistant_message: reply });
  return { id, edit: changed, answer };
}
/** The fallback: the final answer has no save line, so Stop asks through a continuation, which answers. */
function fallbackSession(provider: Provider, cwd: string, reply: string, id = `f-${Math.random().toString(36).slice(2)}`) {
  const changed = edit(provider, id, cwd);
  const request = run(provider, 'stop', { session_id: id, cwd, stop_hook_active: false, last_assistant_message: 'Implemented the change.' });
  const answer = run(provider, 'stop', { session_id: id, cwd, stop_hook_active: true, last_assistant_message: reply });
  return { id, edit: changed, request, answer };
}
const active = (path = a) => host.project(path).memories().filter(m => ['persist', 'accepted'].includes(m.status));

test('gating: the first edit of a turn is offered, the answer is applied at that stop, the fallback asks once and never loops', () => {
  const idle = { dirty: false, pending: false };
  const offered = { dirty: false, pending: true, offered: true, turn: 't1', scope: 'x' };
  expect(editDecision(idle, 'x', false, 't1')).toEqual({ offer: true, state: offered });
  // Later edits of the turn are covered by the offer; an edit elsewhere makes the answer unusable.
  expect(editDecision(offered, 'x', false, 't1')).toEqual({ offer: false, state: offered });
  expect(editDecision(offered, 'y', false, 't1')).toEqual({ offer: false, state: { ...offered, scope: 'mixed' } });
  // Without turn ids (older providers) one offer covers edits until its Stop.
  expect(editDecision({ dirty: false, pending: true, offered: true, scope: 'x' }, 'x', false)).toMatchObject({ offer: false });
  // A sub-agent's edit is recorded, not offered; edits in two scopes are never offered.
  expect(editDecision(idle, 'x', true, 't1')).toEqual({ offer: false, state: { dirty: true, pending: false, scope: 'x' } });
  expect(editDecision({ dirty: true, pending: false, scope: 'x' }, 'y', false)).toEqual({ offer: false, state: { dirty: true, pending: false, scope: 'mixed' } });
  expect(stopDecision(idle, false, false).action).toBe('none');
  expect(stopDecision(idle, true, true).action).toBe('none');
  // An answered offer is applied at the turn's own stop; an unsolicited save is never applied.
  expect(stopDecision(offered, false, true, 't1')).toEqual({ action: 'apply', state: { dirty: false, pending: false, scope: 'x' } });
  // The line is missing: one continuation request, rate limited.
  const request = stopDecision({ ...offered, close: 'handoff_1' }, false, false, 't1', 1000);
  expect(request).toEqual({ action: 'request', state: { dirty: false, pending: true, asked: true, prompted_at: 1000, scope: 'x', close: 'handoff_1' } });
  expect(stopDecision({ dirty: true, pending: false, scope: 'x' }, false, false, 't1', 1000).action).toBe('request');
  expect(stopDecision({ ...offered, prompted_at: 1000 }, false, false, 't1', 1000 + PROMPT_INTERVAL_MS - 1)).toEqual({ action: 'none', state: { dirty: false, pending: false, prompted_at: 1000 } });
  // Rate limited edits are dropped with their scope, so a kept `mixed` cannot block the next offers.
  expect(stopDecision({ dirty: true, pending: false, scope: 'mixed', prompted_at: 1000 }, false, false, 't2', 2000)).toEqual({ action: 'none', state: { dirty: false, pending: false, prompted_at: 1000 } });
  expect(stopDecision({ dirty: true, pending: false, prompted_at: 1000 }, false, false, 't1', 1000 + PROMPT_INTERVAL_MS).action).toBe('request');
  // A continuation stop never blocks again: it answers the request, or the request expires.
  expect(stopDecision(request.state, true, true)).toMatchObject({ action: 'apply', state: { pending: false } });
  expect(stopDecision(request.state, true, false)).toEqual({ action: 'none', state: { dirty: false, pending: false, prompted_at: 1000, scope: 'x' } });
  expect(stopDecision({ dirty: true, pending: false }, true, false).action).toBe('none');
  // A request whose continuation never came (interrupted) expires at the next ordinary stop.
  expect(stopDecision(request.state, false, false, 't2', 2000)).toMatchObject({ action: 'none', state: { pending: false } });
  // An answer to the request without stop_hook_active (as Claude Code may report it) is applied too.
  expect(stopDecision(request.state, false, true, 't1', 2000).action).toBe('apply');
});

test('an interrupted turn: its offer expires silently, and the next edit is offered again', () => {
  const stale = { dirty: false, pending: true, offered: true, turn: 't1', scope: 'x' };
  // A read-only next turn: no request on a turn that made no edit, then or later. The next edited turn's offer covers
  // the session, so the interrupted turn's edits leave nothing behind (no scope that could turn a later edit `mixed`).
  expect(stopDecision(stale, false, false, 't2', 1000)).toEqual({ action: 'none', state: { dirty: false, pending: false } });
  // An edit in the next turn gets a fresh offer, in whatever project it happens.
  expect(editDecision(stale, 'x', false, 't2')).toEqual({ offer: true, state: { dirty: false, pending: true, offered: true, turn: 't2', scope: 'x' } });
  expect(editDecision(stale, 'y', false, 't2')).toEqual({ offer: true, state: { dirty: false, pending: true, offered: true, turn: 't2', scope: 'y' } });
  // A request pending from an earlier release was never an offer: it expires the same way, without a save.
  expect(stopDecision({ dirty: false, pending: true, prompted_at: 5, scope: 'x' }, false, false, 't2', 1000)).toEqual({ action: 'none', state: { dirty: false, pending: false, prompted_at: 5 } });
  expect(stopDecision({ dirty: false, pending: true, prompted_at: 5, scope: 'x' }, true, true).action).toBe('none');
});

test('the offer is complete, the fallback request is short and self-contained; only an unfenced save line is parsed', () => {
  const text = saveContract();
  expect(Buffer.byteLength(text)).toBeLessThan(1100);
  for (const phrase of ['[continuity-save]: <{"memories":[],"handoff":null}>', 'End your final answer with an empty line', 'Empty is normal', 'unfinished', 'secrets', 'verbatim', '\\u003c']) expect(text).toContain(phrase);
  // Shown to the user only as a fallback: short, and it carries the template for a model that never saw the offer.
  expect(Buffer.byteLength(SAVE_REQUEST)).toBeLessThan(400);
  for (const phrase of ['[continuity-save]: <{"memories":[],"handoff":null}>', 'no tool calls', 'left empty']) expect(SAVE_REQUEST).toContain(phrase);
  expect(parseSaveReply('I learned that the parser rejects tabs.')).toBeUndefined();
  expect(parseSaveReply('Done.\n\n[continuity-save]: <{not json>')).toBeUndefined();
  expect(parseSaveReply('Done.\r\n\r\n[continuity-save]: <{"memories":[],"handoff":null}>\r\n')).toEqual({ memories: [], handoff: null });
  // Escaped and unescaped angle brackets inside strings both parse; only the rendering differs.
  expect(parseSaveReply('x\n\n[continuity-save]: <{"memories":[{"key":"a.b","kind":"memory","text":"Use \\u003cT\\u003e generics."}]}>')?.memories).toEqual([{ key: 'a.b', kind: 'memory', text: 'Use <T> generics.' }]);
  expect(parseSaveReply('x\n\n   [continuity-save]: <{"memories":[{"key":"a.b","kind":"memory","text":"a > b"}]}>')?.memories).toHaveLength(1);
  // CommonMark labels are case-insensitive; U+2028 inside a JSON string stays on the line.
  expect(parseSaveReply('x\n\n[Continuity-Save]: <{"memories":[]}>')).toEqual({ memories: [], handoff: null });
  expect(parseSaveReply('x\n\n[continuity-save]: <{"memories":[{"key":"a.b","kind":"memory","text":"one two"}]}>')?.memories).toHaveLength(1);
  // Indented code (four spaces) and fenced code are quoted content, never the model's own save.
  expect(parseSaveReply('x\n\n    [continuity-save]: <{"memories":[]}>')).toBeUndefined();
  const fenced = '[continuity-save]: <{"memories":[{"key":"doc.example","kind":"memory","text":"An example from the docs."}],"close_handoff":true}>';
  expect(parseSaveReply(`Here is the format:\n\n\`\`\`text\n${fenced}\n\`\`\`\n`)).toBeUndefined();
  expect(parseSaveReply(`~~~~\n${fenced}\n~~~\nstill fenced\n~~~~\n`)).toBeUndefined();
  expect(parseSaveReply(`\`\`\`\n${fenced}\n\`\`\`\n\n[continuity-save]: <{"memories":[]}>`)).toEqual({ memories: [], handoff: null });
  // The earlier tagged block is no longer read.
  expect(parseSaveReply('<continuity-save>{"memories":[]}</continuity-save>')).toBeUndefined();
  // The last line wins.
  expect(parseSaveReply('[continuity-save]: <{"memories":[{"key":"old"}]}>\n\n[continuity-save]: <{"memories":[]}>')).toEqual({ memories: [], handoff: null });
});

test('completed task: one attributed lesson, no handoff, no extra turn, silent success, exit 0 throughout', () => {
  const { id, edit: changed, answer } = session('claude', a, save({ memories: [{ key: 'locale.blank-lines', kind: 'experience', text: 'Locale files must not contain blank lines; the loader rejects them.' }], handoff: null }));
  for (const step of [changed, answer]) { expect(step.status).toBe(0); expect(step.stderr).toBe(''); }
  expect(JSON.parse(changed.stdout)).toEqual(offer());
  expect(answer.stdout).toBe('');
  const [memory] = active();
  expect(active()).toHaveLength(1);
  expect(memory).toMatchObject({ key: 'locale.blank-lines', status: 'persist', from: { agent: 'Claude Code', session: id }, provenance: { trust: 'agent_observation', origin: 'agent:Claude Code', source_version: id } });
  expect(host.project(a).latestHandoff()).toBeNull();
  // Answered: the next stop in the same session is silent until new edits.
  expect(run('claude', 'stop', { session_id: id, cwd: a, stop_hook_active: false }).stdout).toBe('');
  expect(renderBootstrap(host.bootstrap(a)!)).toContain('agent observation');
});

test.each(['claude', 'codex'] as const)('%s matrix: completed, unfinished, trivial and read-only turns add no visible output', provider => {
  const env = provider === 'claude' ? { CONTINUITY_AUTOSAVE: undefined, CLAUDE_CODE_SESSION_ATTENDED: '1', CLAUDE_CODE_ENTRYPOINT: 'cli' } : CODEX_TUI;
  const turn = (id: string, message: string, edited = true) => {
    const changed = edited ? edit(provider, id, a, env) : undefined;
    const stop = run(provider, 'stop', { session_id: id, cwd: a, stop_hook_active: false, last_assistant_message: message }, env);
    for (const step of [changed, stop]) if (step) { expect(step.status).toBe(0); expect(step.stderr).toBe(''); }
    return { offered: changed?.stdout ?? '', stop: stop.stdout };
  };
  // Meaningful completed work: one lesson, silent.
  expect(turn(`${provider}-done`, save({ memories: [{ key: `${provider}.lesson`, kind: 'experience', text: 'The loader caches parsed locale files per process.' }], handoff: null }))).toMatchObject({ stop: '' });
  // Unfinished work: a handoff, silent.
  expect(turn(`${provider}-open`, save({ memories: [], handoff: { goal: `${provider} migration`, status: 'in_progress', remaining: ['fr_FR'], next: 'Convert fr_FR.' } })).stop).toBe('');
  // Trivial edit (a rename): the model saves nothing, and nothing is shown.
  expect(turn(`${provider}-trivial`, save({ memories: [], handoff: null }))).toMatchObject({ stop: '' });
  // Read-only turn: no edit, no offer, nothing read from the answer even if it contains a save line.
  expect(turn(`${provider}-read`, save({ memories: [{ key: 'unsolicited.fact', kind: 'experience', text: 'Unsolicited save lines are never applied.' }] }), false)).toEqual({ offered: '', stop: '' });
  expect(active().map(m => m.key)).toEqual([`${provider}.lesson`]);
  expect(host.project(a).latestHandoff()?.task.goal).toBe(`${provider} migration`);
  // Each edited turn gets its own offer; an answered turn leaves no request behind.
  expect(turn(`${provider}-done`, save({ memories: [], handoff: null }))).toMatchObject({ stop: '' });
  expect(run(provider, 'stop', { session_id: `${provider}-done`, cwd: a, stop_hook_active: false, last_assistant_message: 'Anything else?' }, env).stdout).toBe('');
});

test.each(['claude', 'codex'] as const)('%s fallback: a missing save line gets one short request; the continuation is applied and never blocked', provider => {
  const env = provider === 'claude' ? { CONTINUITY_AUTOSAVE: undefined, CLAUDE_CODE_SESSION_ATTENDED: '1' } : CODEX_TUI;
  expect(edit(provider, 'late', a, env).stdout).toContain('additionalContext');
  const request = run(provider, 'stop', { session_id: 'late', cwd: a, stop_hook_active: false, last_assistant_message: 'Fixed the loader.' }, env);
  // Claude Code shows Stop additionalContext as hook feedback, not as a hook error; Codex only has decision:block.
  expect(JSON.parse(request.stdout)).toEqual(provider === 'claude' ? { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: SAVE_REQUEST } } : { decision: 'block', reason: SAVE_REQUEST });
  const answer = run(provider, 'stop', { session_id: 'late', cwd: a, stop_hook_active: true, last_assistant_message: `[continuity-save]: <${JSON.stringify({ memories: [{ key: 'loader.late', kind: 'experience', text: 'The loader resolves locales lazily on first use.' }] })}>` }, env);
  expect(answer).toMatchObject({ status: 0, stdout: '' });
  expect(active().map(m => m.key)).toEqual(['loader.late']);
  // Rate limited: a second unanswered turn within the interval gets no second request and never loops.
  edit(provider, 'late', a, env);
  expect(run(provider, 'stop', { session_id: 'late', cwd: a, stop_hook_active: false, last_assistant_message: 'Done again.' }, env).stdout).toBe('');
  // A request whose continuation does not answer expires without another block.
  edit(provider, 'late2', a, env);
  expect(run(provider, 'stop', { session_id: 'late2', cwd: a, stop_hook_active: false }, env).stdout).not.toBe('');
  expect(run(provider, 'stop', { session_id: 'late2', cwd: a, stop_hook_active: true, last_assistant_message: 'I have nothing to add.' }, env).stdout).toBe('');
  expect(run(provider, 'stop', { session_id: 'late2', cwd: a, stop_hook_active: false }, env).stdout).toBe('');
  // The answer arriving on a stop without stop_hook_active is still the answer to the request.
  edit(provider, 'late3', a, env);
  expect(run(provider, 'stop', { session_id: 'late3', cwd: a, stop_hook_active: false }, env).stdout).not.toBe('');
  expect(run(provider, 'stop', { session_id: 'late3', cwd: a, stop_hook_active: false, last_assistant_message: `[continuity-save]: <${JSON.stringify({ memories: [{ key: 'loader.late3', kind: 'experience', text: 'Locale fallbacks resolve to en_US.' }] })}>` }, env).stdout).toBe('');
  expect(active().map(m => m.key).sort()).toEqual(['loader.late', 'loader.late3']);
});

test.each(['claude', 'codex'] as const)('%s interrupted turn: the next read-only turn stays silent, the next edited turn is offered again', provider => {
  const env = provider === 'claude' ? { CONTINUITY_AUTOSAVE: undefined, CLAUDE_CODE_SESSION_ATTENDED: '1' } : CODEX_TUI;
  const id = `${provider}-interrupted`, turnField = provider === 'claude' ? 'prompt_id' : 'turn_id';
  const editIn = (turn: string) => run(provider, 'tool-use', { session_id: id, cwd: a, [turnField]: turn }, env);
  expect(editIn('turn-1').stdout).toContain('additionalContext');
  // Turn 1 is interrupted: its Stop never runs. Turn 2 only reads.
  expect(run(provider, 'stop', { session_id: id, cwd: a, stop_hook_active: false, [turnField]: 'turn-2', last_assistant_message: 'The loader lives in src/locale.' }, env).stdout).toBe('');
  // Turn 3 edits again and gets the contract again; its save covers the earlier edits too.
  expect(editIn('turn-3').stdout).toContain('additionalContext');
  expect(run(provider, 'stop', { session_id: id, cwd: a, stop_hook_active: false, [turnField]: 'turn-3', last_assistant_message: save({ memories: [{ key: 'loader.location', kind: 'memory', text: 'The locale loader lives in src/locale and owns file parsing.' }] }) }, env).stdout).toBe('');
  expect(active().map(m => m.key)).toEqual(['loader.location']);
  // Interrupted, then two read-only turns: never asked.
  const quiet = `${id}-quiet`;
  expect(run(provider, 'tool-use', { session_id: quiet, cwd: a, [turnField]: 'q1' }, env).stdout).toContain('additionalContext');
  for (const turn of ['q2', 'q3']) expect(run(provider, 'stop', { session_id: quiet, cwd: a, stop_hook_active: false, [turnField]: turn, last_assistant_message: 'Only a question.' }, env).stdout).toBe('');
  // Interrupted in Alpha, then an edit in Beta: Beta gets its own offer and its save is stored.
  const moved = `${id}-moved`;
  expect(run(provider, 'tool-use', { session_id: moved, cwd: a, [turnField]: 'm1' }, env).stdout).toContain('additionalContext');
  expect(run(provider, 'tool-use', { session_id: moved, cwd: b, [turnField]: 'm2' }, env).stdout).toContain('additionalContext');
  expect(run(provider, 'stop', { session_id: moved, cwd: b, stop_hook_active: false, [turnField]: 'm2', last_assistant_message: save({ memories: [{ key: 'beta.invoices', kind: 'decision', text: 'Beta stores invoice totals in integer cents.' }] }) }, env).stdout).toBe('');
  expect(active(b).map(m => m.key)).toEqual(['beta.invoices']); expect(active(a).map(m => m.key)).toEqual(['loader.location']);
});

test('model mistakes stay silent; a handoff without a next action uses its first remaining item', () => {
  const invalid = session('claude', a, save({ memories: [{ key: 'bad.kind', kind: 'opinion', text: 'Not a valid memory kind at all.' }], handoff: { goal: 'Half done', status: 'maybe', next: 'x' } }));
  expect(invalid.answer.stdout).toBe('');
  expect(applySave(host.session(a)!, 'claude', 's', { memories: [{ key: 'bad.kind', kind: 'opinion', text: 'Not a valid memory kind at all.' }], handoff: null })).toEqual([{ item: 'memory bad.kind', outcome: 'skipped: invalid memory' }]);
  session('codex', a, save({ handoff: { goal: 'Convert fr_FR', status: 'in_progress', remaining: ['Convert fr_FR plural rules.'] } }));
  expect(host.project(a).latestHandoff()).toMatchObject({ task: { goal: 'Convert fr_FR' }, recommended_next_action: 'Convert fr_FR plural rules.' });
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

test('secrets are neither saved nor shown; policy skips stay silent', () => {
  const { answer } = session('codex', a, save({ memories: [
    { key: 'deploy.token', kind: 'memory', text: 'Staging deploys use api_key = "sk-live-abcdefghijklmnopqrstuv".' },
    { key: 'locale.blank-lines', kind: 'experience', text: 'Locale files must not contain blank lines; the loader rejects them.' },
  ], handoff: { goal: 'Rotate deploy credentials', status: 'blocked', next: 'Set password = hunter2hunter2 in CI.' } }));
  expect(answer).toMatchObject({ status: 0, stdout: '', stderr: '' });
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
  // Policy outcomes are normal, never a user-facing message.
  expect(saveReport(outcomes)).toBeUndefined();
});

test('the report is one short line, only for failures, without item text', () => {
  expect(saveReport([{ item: 'memory a', outcome: 'persisted' }, { item: 'memory b', outcome: 'rejected' }, { item: 'handoff', outcome: 'skipped: looks like a secret' }])).toBeUndefined();
  expect(saveReport([{ item: 'memory a', outcome: 'persisted' }, { item: 'memory secret.key', outcome: 'failed: database is locked' }])).toBe('Continuity: save incomplete — 1 of 2 not saved (database busy).');
  const long = saveReport([{ item: 'memory x', outcome: `failed: ${'y'.repeat(500)}` }])!;
  expect(long.length).toBeLessThan(160); expect(long).not.toContain('\n'); expect(long).not.toContain('memory x');
});

test('a conflicting lesson is quarantined silently, never overrides a human-accepted memory, and shows at the next start', () => {
  const pending = host.project(a).propose({ key: 'release.branch', kind: 'decision', text: 'Releases are cut from the release branch.' });
  host.review(a, pending.id, 'accepted', 'Maintainer');
  const { answer } = session('claude', a, save({ memories: [{ key: 'release.branch', kind: 'decision', text: 'Releases are cut directly from main.' }] }));
  expect(answer.stdout).toBe('');
  const memories = host.project(a).memories();
  expect(memories.find(m => m.id === pending.id)).toMatchObject({ status: 'accepted', text: 'Releases are cut from the release branch.' });
  expect(memories.find(m => m.text.includes('directly from main'))).toMatchObject({ status: 'needs_attention' });
  expect(renderBootstrap(host.bootstrap(a)!)).toMatch(/1 unresolved memory conflict \(release\.branch\)/);
});

test('binding: unregistered, nested, cross-project and missing homes stay isolated and silent', () => {
  const outside = join(root, 'scratch'); mkdirSync(outside);
  const unbound = session('claude', outside, save({ memories: [{ key: 'x.y', kind: 'experience', text: 'Would leak into some other project.' }] }));
  expect([unbound.edit.stdout, unbound.answer.stdout]).toEqual(['', '']);
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
  // Only 1 enables; 0 and unrecognized values fail safe to off, even in an attended Claude session.
  for (const env of [{ CONTINUITY_AUTOSAVE: '0', CLAUDE_CODE_SESSION_ATTENDED: '1' }, { CONTINUITY_AUTOSAVE: 'off', CLAUDE_CODE_SESSION_ATTENDED: '1' }, { CONTINUITY_AUTOSAVE: 'true', CLAUDE_CODE_SESSION_ATTENDED: '1' }]) {
    run('claude', 'tool-use', { session_id: 'off2', cwd: a }, env);
    expect(run('claude', 'stop', { session_id: 'off2', cwd: a, stop_hook_active: false }, env).stdout).toBe('');
  }
  expect(off.edit.stdout).not.toBe('');
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
  expect([detached.edit.stdout, detached.answer.stdout]).toEqual(['', '']); expect(host.bootstrap(a)?.latest_handoff).toBeUndefined();
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
  for (const file of states) expect(readFileSync(join(home, 'hooks', 'autosave', file), 'utf8')).toMatch(/^\{"dirty":(true|false),"pending":(true|false)(,"offered":true)?(,"asked":true)?(,"turn":"[0-9a-f]{16}")?(,"prompted_at":\d+)?(,"scope":"([0-9a-f]{24}|mixed)")?\}$/);
});

/** Runs a hook while another connection holds the database's write lock. */
async function whileLocked(provider: Provider, event: 'tool-use' | 'stop', input: unknown) {
  const lock = new DatabaseSync(join(home, 'continuity.db')); lock.exec('BEGIN IMMEDIATE');
  try {
    const child = spawn(process.execPath, ['--no-warnings', cli, '--home', home, 'integrate', provider, event], { windowsHide: true, env: hookEnv() });
    let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.end(JSON.stringify(input));
    const started = Date.now(), code = await new Promise<number | null>(done => child.on('exit', done));
    return { code, stdout, stderr, ms: Date.now() - started };
  } finally { lock.exec('ROLLBACK'); lock.close(); }
}

test('a locked database never blocks the stop; a lost save is one short line, never a stack trace', async () => {
  const id = 'locked';
  expect(edit('claude', id, a).stdout).not.toBe('');
  const result = await whileLocked('claude', 'stop', { session_id: id, cwd: a, stop_hook_active: false, last_assistant_message: save({ memories: [{ key: 'k.lock', kind: 'experience', text: 'Written while the database was locked.' }] }) });
  expect(result.code).toBe(0); expect(result.ms).toBeLessThan(30_000); expect(result.stderr).toBe('');
  expect(JSON.parse(result.stdout)).toEqual({ systemMessage: 'Continuity: save skipped — database busy.' });
  // The answer was consumed: no retry loop, no second request.
  expect(run('claude', 'stop', { session_id: id, cwd: a, stop_hook_active: false }).stdout).toBe('');
  expect(active()).toEqual([]);
});

test('a locked database during an edit stays silent and offers nothing', async () => {
  const result = await whileLocked('codex', 'tool-use', { session_id: 'locked-edit', cwd: a, tool_name: 'apply_patch' });
  expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' });
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
  expect(JSON.parse(cmd('install').stdout)).toMatchObject({ state: 'installed', autosave: true, entries: 3, message: expect.stringContaining('interactive sessions (the shared app-server, not codex exec or --no-daemon)') });
  expect(cmd('status').status).toBe(0);
  expect(JSON.parse(cmd('remove').stdout)).toMatchObject({ state: 'missing', changed: true });
  expect(JSON.parse(readFileSync(join(env.CODEX_HOME, 'hooks.json'), 'utf8'))).toEqual({ hooks: {} });
});

test('secrets are caught per field, including quoted values that serialization would escape', () => {
  const { answer } = session('claude', a, save({ memories: [{ key: 'db.creds', kind: 'memory', text: 'Staging uses password: "hunter2hunter2" for the database.' }],
    handoff: { goal: 'Rotate creds', status: 'blocked', risks: ['Staging DB password: "hunter2hunter2"'], next: 'Use api_key="abcdefghijkl" in CI' } }));
  expect(answer.stdout).toBe('');
  expect(host.project(a).latestHandoff()).toBeNull(); expect(host.project(a).memories()).toHaveLength(0);
  expect(readFileSync(join(home, 'continuity.db')).toString('latin1')).not.toContain('hunter2hunter2');
});

test('a save cannot follow the agent into another project, workspace or nested checkout', () => {
  const reply = save({ memories: [{ key: 'alpha.design', kind: 'decision', text: 'Alpha keeps its design notes private to Alpha.' }] });
  // Edited Alpha, stopped in Beta without a save line: no request at all.
  edit('claude', 'moved', a);
  expect(run('claude', 'stop', { session_id: 'moved', cwd: b, stop_hook_active: false }).stdout).toBe('');
  // Offered in Alpha, answered from Beta: one line, nothing saved.
  expect(edit('claude', 'moved2', a).stdout).not.toBe('');
  const answer = run('claude', 'stop', { session_id: 'moved2', cwd: b, stop_hook_active: false, last_assistant_message: reply });
  expect(JSON.parse(answer.stdout)).toEqual({ systemMessage: 'Continuity: save skipped — the session moved to another project or workspace.' });
  // The same through the fallback request.
  edit('claude', 'moved3', a);
  expect(run('claude', 'stop', { session_id: 'moved3', cwd: a, stop_hook_active: false }).stdout).toContain('additionalContext');
  expect(JSON.parse(run('claude', 'stop', { session_id: 'moved3', cwd: b, stop_hook_active: true, last_assistant_message: reply }).stdout).systemMessage).toMatch(/save skipped/);
  // Edits in two projects: the answer is unusable and there is no request.
  edit('claude', 'mixed', a); edit('claude', 'mixed', b);
  expect(run('claude', 'stop', { session_id: 'mixed', cwd: a, stop_hook_active: false }).stdout).toBe('');
  // A Git checkout nested in the project (e.g. an unregistered .claude/worktrees entry) is a different tree.
  const nested = join(a, '.claude', 'worktrees', 'feat'); mkdirSync(nested, { recursive: true }); writeFileSync(join(nested, '.git'), 'gitdir: ../../../.git/worktrees/feat\n');
  const inWorktree = session('claude', nested, save({ handoff: { goal: 'Worktree task', status: 'in_progress', next: 'Continue in the worktree.' } }));
  expect([inWorktree.edit.stdout, inWorktree.answer.stdout]).toEqual(['', '']);
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
  const result = fallbackSession('claude', a, save({ memories: [] }));
  expect([result.edit.status, result.request.status, result.answer.status]).toEqual([0, 0, 0]);
  expect([result.edit.stdout, result.request.stdout, result.answer.stdout]).toEqual(['', '', '']);
  expect(readdirSync(elsewhere)).toEqual(['keep.json']);
});

test('an edit elsewhere during the save turn cannot redirect the outstanding offer or request', () => {
  const learned = save({ memories: [{ key: 'm2b.key', kind: 'experience', text: 'Learned in Alpha, must never land in Beta.' }] });
  edit('claude', 'redirect', a); edit('claude', 'redirect', b);
  expect(JSON.parse(run('claude', 'stop', { session_id: 'redirect', cwd: b, stop_hook_active: false, last_assistant_message: learned }).stdout)).toEqual({ systemMessage: 'Continuity: save skipped — this turn edited more than one project or workspace.' });
  edit('claude', 'redirect2', a);
  expect(run('claude', 'stop', { session_id: 'redirect2', cwd: a, stop_hook_active: false }).stdout).toContain('additionalContext');
  edit('claude', 'redirect2', b);
  expect(JSON.parse(run('claude', 'stop', { session_id: 'redirect2', cwd: b, stop_hook_active: true, last_assistant_message: learned }).stdout).systemMessage).toMatch(/save skipped/);
  expect(active(b)).toEqual([]); expect(active(a)).toEqual([]);
});

test('a secret straddling the list item length limit is still refused', () => {
  const item = `${'x'.repeat(495)} api_key = "abcdefghijklmnop"`;
  const { answer } = session('claude', a, save({ handoff: { goal: 'Long notes', status: 'in_progress', risks: [item], next: 'Continue.' } }));
  expect(answer.stdout).toBe('');
  expect(host.project(a).latestHandoff()).toBeNull();
  expect(readFileSync(join(home, 'continuity.db')).toString('latin1')).not.toContain('abcdefghijklmnop');
});

test('mode: interactive Claude and daemon-hosted Codex sessions save by default; print, SDK, exec and unknown sessions do not', () => {
  const cases: [Provider, Record<string, string | undefined>, boolean][] = [
    ['claude', { CONTINUITY_AUTOSAVE: undefined, CLAUDE_CODE_SESSION_ATTENDED: '1', CLAUDE_CODE_ENTRYPOINT: 'cli' }, true],
    ['claude', { CONTINUITY_AUTOSAVE: undefined, CLAUDE_CODE_ENTRYPOINT: 'cli' }, true],
    ['claude', { CONTINUITY_AUTOSAVE: undefined, CLAUDE_CODE_SESSION_ATTENDED: '0', CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }, false],
    ['claude', { CONTINUITY_AUTOSAVE: undefined, CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' }, false],
    ['claude', { CONTINUITY_AUTOSAVE: undefined }, false],
    ['claude', { CONTINUITY_AUTOSAVE: '0', CLAUDE_CODE_SESSION_ATTENDED: '1' }, false],
    ['claude', { CONTINUITY_AUTOSAVE: '1', CLAUDE_CODE_SESSION_ATTENDED: '0', CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }, true],
    // codex exec and --no-daemon: hooks run in-process, without the daemon marker.
    ['codex', { CONTINUITY_AUTOSAVE: undefined }, false],
    ['codex', { CONTINUITY_AUTOSAVE: undefined, CLAUDE_CODE_SESSION_ATTENDED: '1' }, false],
    ['codex', { CONTINUITY_AUTOSAVE: '1' }, true],
    // Interactive TUI: hooks run in the shared app-server daemon.
    ['codex', { CONTINUITY_AUTOSAVE: undefined, CODEX_DAEMON_SHUTDOWN_SOCKET: '1' }, true],
    ['codex', { CONTINUITY_AUTOSAVE: undefined, CODEX_DAEMON_SHUTDOWN_SOCKET: '' }, false],
    ['codex', { CONTINUITY_AUTOSAVE: '0', CODEX_DAEMON_SHUTDOWN_SOCKET: '1' }, false],
    // A codex exec that an agent started as a tool command inherits the daemon marker, but also Codex's tool markers.
    ['codex', { CONTINUITY_AUTOSAVE: undefined, CODEX_DAEMON_SHUTDOWN_SOCKET: '1', CODEX_CI: '1', CODEX_THREAD_ID: 'thr', CODEX_SESSION_ID: 'ses' }, false],
    ['codex', { CONTINUITY_AUTOSAVE: undefined, CODEX_DAEMON_SHUTDOWN_SOCKET: '1', CODEX_THREAD_ID: 'thr' }, false],
    ['codex', { CONTINUITY_AUTOSAVE: undefined, CODEX_DAEMON_SHUTDOWN_SOCKET: '1', CODEX_CI: '1' }, false],
    ['codex', { CONTINUITY_AUTOSAVE: undefined, CODEX_DAEMON_SHUTDOWN_SOCKET: '1', CODEX_SESSION_ID: 'ses' }, false],
    // An explicit force-on still wins, as documented for forced headless runs.
    ['codex', { CONTINUITY_AUTOSAVE: '1', CODEX_DAEMON_SHUTDOWN_SOCKET: '1', CODEX_CI: '1', CODEX_THREAD_ID: 'thr' }, true],
  ];
  cases.forEach(([provider, env, expected], i) => {
    const id = `mode-${i}`, label = `${provider} ${JSON.stringify(env)}`;
    const changed = run(provider, 'tool-use', { session_id: id, cwd: a }, env);
    const stop = run(provider, 'stop', { session_id: id, cwd: a, stop_hook_active: false, last_assistant_message: 'Final answer for the script.' }, env);
    expect([changed.status, stop.status], label).toEqual([0, 0]);
    expect(changed.stdout.includes('"additionalContext"'), label).toBe(expected);
    // Without a save line in the final answer, an interactive session gets the one fallback request.
    expect(stop.stdout.includes(provider === 'claude' ? '"hookEventName":"Stop"' : '"decision":"block"'), label).toBe(expected);
    // Headless runs (claude -p, codex exec) keep their exact output: nothing is added on any channel.
    if (!expected) expect([changed.stdout, stop.stdout, changed.stderr, stop.stderr], label).toEqual(['', '', '', '']);
  });
  // Disabled sessions leave no flag files: only the six enabled cases wrote state.
  expect(readdirSync(join(home, 'hooks', 'autosave'))).toHaveLength(6);
});

const CODEX_TUI = { CONTINUITY_AUTOSAVE: undefined, CODEX_DAEMON_SHUTDOWN_SOCKET: '1' };
/** Codex 0.157 PostToolUse input for an edit; code mode reports a nested `tools.apply_patch(...)` the same way. */
const codexEdit = (session_id: string, cwd: string) => ({ session_id, cwd, hook_event_name: 'PostToolUse', tool_name: 'apply_patch', tool_use_id: `call-${session_id}`, turn_id: 'turn-1',
  tool_input: { command: '*** Begin Patch\n*** Update File: README.md\n@@\n-# Alpha\n+# Alpha loader\n*** End Patch\n' }, tool_response: 'Success. Updated the following files:\nM README.md', permission_mode: 'bypassPermissions', model: 'gpt', transcript_path: null });
const flagCount = () => existsSync(join(home, 'hooks', 'autosave')) ? readdirSync(join(home, 'hooks', 'autosave')).length : 0;

test('Codex 0.157: an interactive session saves with no override; codex exec and a nested exec keep their answer and write nothing', () => {
  const changed = run('codex', 'tool-use', codexEdit('tui', a), CODEX_TUI);
  expect(changed).toMatchObject({ status: 0, stderr: '' }); expect(JSON.parse(changed.stdout)).toEqual(offer());
  const answer = run('codex', 'stop', { session_id: 'tui', cwd: a, hook_event_name: 'Stop', turn_id: 'turn-1', stop_hook_active: false, last_assistant_message: save({ memories: [{ key: 'readme.heading', kind: 'decision', text: 'The README heading names the loader, not the product.' }] }) }, CODEX_TUI);
  expect(answer).toMatchObject({ status: 0, stdout: '' });
  expect(active()).toMatchObject([{ key: 'readme.heading', from: { agent: 'Codex', session: 'tui' }, provenance: { trust: 'agent_observation' } }]);
  const flags = flagCount();
  // codex exec runs hooks in-process; an exec started by an agent's tool command inherits the daemon marker too.
  for (const [i, env] of [{ CONTINUITY_AUTOSAVE: undefined }, { ...CODEX_TUI, CODEX_CI: '1', CODEX_THREAD_ID: 'thr', CODEX_SESSION_ID: 'ses' }].entries()) {
    expect(run('codex', 'tool-use', codexEdit(`exec-${i}`, a), env)).toMatchObject({ status: 0, stdout: '' });
    expect(run('codex', 'stop', { session_id: `exec-${i}`, cwd: a, stop_hook_active: false, last_assistant_message: 'DONE' }, env)).toMatchObject({ status: 0, stdout: '', stderr: '' });
  }
  expect(flagCount()).toBe(flags);
  expect(active()).toHaveLength(1);
});

test('attribution: only the session whose own edit tool ran is asked, never another session, provider or an outside change', () => {
  expect(run('codex', 'tool-use', codexEdit('writer', a), CODEX_TUI).stdout).toContain('additionalContext');
  // A second Codex session in the same workspace only read.
  expect(run('codex', 'stop', { session_id: 'reader', cwd: a, stop_hook_active: false }, CODEX_TUI).stdout).toBe('');
  // A Claude session is a different session even if the provider ids collide.
  expect(run('claude', 'stop', { session_id: 'writer', cwd: a, stop_hook_active: false }, { CONTINUITY_AUTOSAVE: undefined, CLAUDE_CODE_SESSION_ATTENDED: '1' }).stdout).toBe('');
  // A file changed by an editor, a build or another agent is not an edit event of this session.
  writeFileSync(join(a, 'README.md'), '# Alpha\nChanged outside any agent.\n');
  expect(run('codex', 'stop', { session_id: 'reader', cwd: a, stop_hook_active: false }, CODEX_TUI).stdout).toBe('');
  expect(run('codex', 'stop', { session_id: 'writer', cwd: a, stop_hook_active: false }, CODEX_TUI).stdout).toContain('"decision":"block"');
  // Only edit tools reach the flag: Codex reports shell commands as Bash, which the installed matcher never routes.
  expect(codexHookTarget(process.execPath, cli, home).entries.find(e => e.event === 'PostToolUse')?.matcher).toBe('apply_patch');
});

test('sub-agents: their edits arrive under the parent session, get no offer, and only the parent is asked', () => {
  // Both providers report a sub-agent's edit with the parent's session_id plus agent_id/agent_type. A sub-agent ends with
  // SubagentStop, which Continuity does not install; an offer would reach the sub-agent, not the model ending the turn.
  expect(run('codex', 'tool-use', { ...codexEdit('parent', a), agent_id: 'agent-1', agent_type: 'default', turn_id: 'sub-turn' }, CODEX_TUI).stdout).toBe('');
  expect(codexHookTarget(process.execPath, cli, home).entries.map(e => e.event)).toEqual(['SessionStart', 'PostToolUse', 'Stop']);
  const request = run('codex', 'stop', { session_id: 'parent', cwd: a, turn_id: 'parent-turn', stop_hook_active: false, last_assistant_message: 'The sub-agent added the function.' }, CODEX_TUI);
  // The parent never saw the contract, so the request carries all of it.
  expect(JSON.parse(request.stdout)).toEqual({ decision: 'block', reason: SAVE_REQUEST });
  expect(run('claude', 'tool-use', { session_id: 'claude-parent', cwd: a, tool_name: 'Write', agent_id: 'a1b2', agent_type: 'general-purpose' }).stdout).toBe('');
  // Traced with Codex 0.157: a sub-agent runs its own turn_id inside the parent's turn. Its edits must not expire the
  // parent's outstanding offer, whose save line then arrives with the parent's Stop.
  expect(run('codex', 'tool-use', { ...codexEdit('parent2', a), turn_id: 'parent-turn' }, CODEX_TUI).stdout).toContain('additionalContext');
  expect(run('codex', 'tool-use', { ...codexEdit('parent2', a), agent_id: 'agent-2', agent_type: 'default', turn_id: 'sub-turn' }, CODEX_TUI).stdout).toBe('');
  expect(run('codex', 'stop', { session_id: 'parent2', cwd: a, turn_id: 'parent-turn', stop_hook_active: false, last_assistant_message: save({ memories: [{ key: 'sub.lesson', kind: 'experience', text: 'The sub-agent found that locale keys are case-sensitive.' }] }) }, CODEX_TUI).stdout).toBe('');
  expect(active().map(m => m.key)).toContain('sub.lesson');
});

test('session flags stay content-free and abandoned ones are removed after a week', () => {
  const dir = join(home, 'hooks', 'autosave'); mkdirSync(dir, { recursive: true });
  const stale = join(dir, `${'0'.repeat(40)}.json`); writeFileSync(stale, '{"dirty":true,"pending":false}');
  const eightDays = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000; utimesSync(stale, eightDays, eightDays);
  run('codex', 'tool-use', codexEdit('fresh', a), CODEX_TUI);
  const files = readdirSync(dir);
  expect(files).toHaveLength(1); expect(existsSync(stale)).toBe(false);
  const flag = readFileSync(join(dir, files[0]!), 'utf8');
  expect(flag).toMatch(/^\{"dirty":false,"pending":true,"offered":true,"turn":"[0-9a-f]{16}","scope":"[0-9a-f]{24}"\}$/);
  for (const content of ['README.md', 'Begin Patch', 'fresh', 'Alpha']) expect(flag).not.toContain(content);
});

test('handoff closure: offered in the request, closed by the answer, history kept, next start shows no stale work', () => {
  session('codex', a, save({ handoff: { goal: 'Migrate locale files to UTF-8', status: 'in_progress', remaining: ['de_DE', 'fr_FR'], next: 'Convert de_DE first.' } }));
  const h1 = host.project(a).latestHandoff()!;
  expect(renderBootstrap(host.bootstrap(a)!)).toContain('Migrate locale files to UTF-8');
  // A later session edits; its offer names the open handoff by goal, never by id.
  const offered = JSON.parse(edit('claude', 'finisher', a).stdout);
  expect(offered).toEqual(offer('Migrate locale files to UTF-8')); expect(JSON.stringify(offered)).not.toContain(h1.id);
  expect(offered.hookSpecificOutput.additionalContext).toContain('Open handoff in this project: "Migrate locale files to UTF-8"');
  const answer = run('claude', 'stop', { session_id: 'finisher', cwd: a, stop_hook_active: false, last_assistant_message: save({ memories: [{ key: 'locale.encoding', kind: 'decision', text: 'All locale files are stored as UTF-8 without BOM.' }], handoff: null, close_handoff: true }) });
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
  // Alpha has no open handoff: a close request is a quiet no-op, and nothing in Beta changes.
  const alpha = session('claude', a, save({ memories: [], close_handoff: true }));
  expect(alpha.answer.stdout).toBe('');
  expect(host.project(b).handoff(beta.id).closure).toBeUndefined();
  expect(applySave(host.session(a)!, 'claude', 's', { memories: [], handoff: null, close_handoff: true })).toEqual([{ item: 'handoff close', outcome: 'skipped: no open handoff was offered' }]);
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
  const offered = edit('claude', 'sens', a).stdout;
  expect(JSON.parse(offered)).toEqual(offer()); expect(offered).not.toContain('Open handoff'); expect(offered).not.toContain('abcd1234');
  // The full fallback request (after a sub-agent's edit) withholds it too.
  expect(run('claude', 'tool-use', { session_id: 'sens2', cwd: a, agent_id: 'sub-1' }).stdout).toBe('');
  const request = run('claude', 'stop', { session_id: 'sens2', cwd: a, stop_hook_active: false }).stdout;
  expect(JSON.parse(request)).toEqual({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: SAVE_REQUEST } }); expect(request).not.toContain('abcd1234');
  const start = renderBootstrap(host.bootstrap(a)!); expect(start).not.toContain('Older open work'); expect(start).not.toContain('Rotate keys');
});

test('a follow-up handoff that replaces the open one closes it with a link, so the old one never resurfaces', () => {
  session('codex', a, save({ handoff: { goal: 'Convert modules to ESM', status: 'in_progress', remaining: ['a', 'b'], next: 'Convert a.' } }));
  const h1 = host.project(a).latestHandoff()!;
  session('claude', a, save({ handoff: { goal: 'Convert modules to ESM', status: 'in_progress', remaining: ['b'], next: 'Convert b.' }, close_handoff: true }));
  const h2 = host.project(a).latestHandoff()!;
  expect(h2.id).not.toBe(h1.id);
  expect(host.project(a).handoff(h1.id).closure).toMatchObject({ status: 'done', replaced_by: h2.id, closed_by: { agent: 'Claude Code' } });
  expect(host.bootstrap(a)?.latest_handoff?.id).toBe(h2.id);
  host.project(a).closeHandoff({ id: h2.id, from: { agent: 'Codex', session: 'done' } });
  expect(host.bootstrap(a)?.latest_handoff).toBeUndefined();
  // A replacement must exist in the same workspace.
  const h3 = host.project(a).createHandoff({ from: { agent: 'Codex', session: 'z' }, task: { goal: 'Other', status: 'in_progress' }, completed: [], remaining: [], decisions: [], files_changed: [], risks: [], recommended_next_action: 'Go.' });
  expect(() => host.project(a).closeHandoff({ id: h3.id, from: { agent: 'Codex', session: 'z' }, replaced_by: 'handoff_missing' })).toThrow(/Replacement/);
  expect(() => host.project(a).closeHandoff({ id: h3.id, from: { agent: 'Codex', session: 'z' }, replaced_by: h3.id })).toThrow(/Replacement/);
});

test('a Git submodule checkout inside a project is a different tree and gets no save', () => {
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', '-c', 'protocol.file.allow=always', ...args], { cwd, stdio: 'pipe' });
  const lib = join(root, 'lib'); mkdirSync(lib); writeFileSync(join(lib, 'README.md'), '# Lib\n'); git(lib, 'init'); git(lib, 'add', '.'); git(lib, 'commit', '-m', 'lib');
  git(a, 'init'); git(a, 'add', '.'); git(a, 'commit', '-m', 'alpha'); git(a, 'submodule', 'add', lib, 'vendor/lib');
  const inside = session('claude', join(a, 'vendor', 'lib'), save({ memories: [{ key: 'lib.fact', kind: 'experience', text: 'Learned inside the vendored submodule checkout.' }] }));
  expect([inside.edit.stdout, inside.answer.stdout]).toEqual(['', '']);
  expect(active(a)).toEqual([]);
});

test('a dropped replacement never closes the offered handoff', () => {
  session('codex', a, save({ handoff: { goal: 'Feature X', status: 'in_progress', next: 'Build X.' } }));
  const x = host.project(a).latestHandoff()!;
  const secret = session('claude', a, save({ handoff: { goal: 'Feature X follow-up', status: 'in_progress', remaining: ['Use api_key = "abcd1234efgh5678"'], next: 'Continue.' }, close_handoff: true }));
  const invalid = session('claude', a, save({ handoff: { goal: 'Feature X follow-up', status: 'in_progress' }, close_handoff: true }));
  expect([secret.answer.stdout, invalid.answer.stdout]).toEqual(['', '']);
  expect(applySave(host.session(a)!, 'claude', 's', { memories: [], handoff: { goal: 'Feature X follow-up', status: 'in_progress' }, close_handoff: true }, x.id)).toContainEqual({ item: 'handoff close', outcome: 'skipped: the replacement handoff was not saved' });
  expect(host.project(a).handoff(x.id).closure).toBeUndefined(); expect(host.bootstrap(a)?.latest_handoff?.goal).toBe('Feature X');
});

test('a newest handoff created as done ends the open chain; closed ones are skipped', () => {
  const client = host.project(a), base = { completed: [], remaining: [], decisions: [], files_changed: [], risks: [], recommended_next_action: 'Go.' };
  client.createHandoff({ ...base, from: { agent: 'Codex', session: 'x' }, task: { goal: 'Old open work', status: 'in_progress' } });
  client.createHandoff({ ...base, from: { agent: 'Codex', session: 'y' }, task: { goal: 'Old work finished', status: 'done' } });
  expect(host.bootstrap(a)?.latest_handoff).toBeUndefined(); expect(client.activeHandoff()).toBeNull();
  expect(host.bootstrap(a)?.available).toMatchObject({ handoffs: 2, older_handoffs: 2 });
  const newer = client.createHandoff({ ...base, from: { agent: 'Codex', session: 'z' }, task: { goal: 'New open work', status: 'in_progress' } });
  expect(host.bootstrap(a)?.latest_handoff?.goal).toBe('New open work');
  client.closeHandoff({ id: newer.id, from: { agent: 'Codex', session: 'z' } });
  // Skipping the closed newest reaches the done handoff, which ends the chain: nothing older comes back.
  expect(host.bootstrap(a)?.latest_handoff).toBeUndefined();
});

test('dashboard handoff lists carry the closure', () => {
  session('codex', a, save({ handoff: { goal: 'Listed work', status: 'in_progress', next: 'Go.' } }));
  const h = host.project(a).latestHandoff()!;
  host.project(a).closeHandoff({ id: h.id, from: { agent: 'Codex', session: 'c' } });
  const projectId = host.project(a).status().project_id;
  const page = host.inspection.page(projectId, '', 'handoffs', 10, 0);
  expect(page.items[0]!.record).toMatchObject({ id: h.id, closure: { status: 'done', closed_by: { agent: 'Codex' } } });
});
