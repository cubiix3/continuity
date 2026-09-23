import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, symlinkSync, lstatSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { openContinuity } from '../packages/sdk/src/index.js';
import { SqliteStorage } from '../packages/storage-sqlite/src/index.js';
import { renderBootstrap } from '../packages/core/src/index.js';
import { claudeHookTarget, codexHookTarget, hookIntegrationStatus, installHookIntegration, removeHookIntegration } from '../packages/adapter-hooks/src/index.js';

// Fixtures propose many memories (each refreshes sources); Windows CI runners need more than vitest's 5 s default.
vi.setConfig({ testTimeout: 60_000 });
let root: string, a: string, b: string, home: string, host: ReturnType<typeof openContinuity>;
const agent = (session = 'fixture') => ({ agent: 'Claude Code', session });
const handoff = (goal: string, status: 'in_progress' | 'blocked' | 'done' = 'in_progress') => ({ from: agent(), task: { goal, status }, completed: [], remaining: ['Compare the two renders.'], decisions: [], files_changed: [], risks: [], recommended_next_action: `Continue ${goal}.` });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'continuity bootstrap ü ')); a = join(root, 'alpha'); b = join(root, 'beta'); home = join(root, 'home');
  mkdirSync(a); mkdirSync(b); writeFileSync(join(a, 'README.md'), '# Alpha\nThe renderer uses cascaded shadow maps without a TAA dependency.\n'); writeFileSync(join(b, 'README.md'), '# Beta\nBETA_ONLY source.\n');
  host = openContinuity(home); host.init(a, 'Alpha'); host.init(b, 'Beta');
});
afterEach(() => { vi.restoreAllMocks(); host.close(); rmSync(root, { recursive: true, force: true }); });
const bundle = (path = a, budget?: number) => host.bootstrap(path, budget === undefined ? {} : { budget })!;
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

test('empty registered project: compact empty state, healthy after sync, degraded before', async () => {
  expect(bundle()).toMatchObject({ health: { status: 'degraded' }, memories: [], available: { memories: 0, handoffs: 0 } });
  expect(renderBootstrap(bundle())).toContain('Sources have not been synced');
  await host.project(a).sync();
  const empty = bundle(); expect(empty.health).toEqual({ status: 'healthy', warnings: [] });
  const text = renderBootstrap(empty);
  expect(text).toContain('Continuity · Alpha'); expect(text).toContain('No durable memories or handoffs yet.');
  expect(text).not.toContain('Needs attention'); expect(text).not.toContain(root); expect(text).not.toContain('prj_');
});

test('stale sync is reported as degraded without syncing', async () => {
  await host.project(a).sync();
  const later = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  const client = host.project(a), result = client.bootstrap({ now: later });
  expect(result.health.status).toBe('degraded'); expect(renderBootstrap(result, later)).toMatch(/Source index is stale/);
});

test('trust order, labels, diversity, rule demotion and handoff priority', async () => {
  const client = host.project(a); await client.sync();
  const human = client.propose({ key: 'release.tags', kind: 'decision', text: 'Release tags are immutable and are never moved.' }); host.review(a, human.id, 'accepted', 'Maintainer');
  client.propose({ key: 'renderer.csm', kind: 'decision', text: 'The renderer uses cascaded shadow maps without a TAA dependency.', source_path: 'README.md' });
  for (let i = 0; i < 6; i++) client.propose({ key: `locale.rule-${i}`, kind: i === 0 ? 'rule' : 'experience', text: `Locale loader lesson ${i} rejects blank lines in locale files.`, from: agent(`s${i}`) });
  client.createHandoff(handoff('Older work', 'done')); client.createHandoff(handoff('Character distance clarity'));
  const result = bundle();
  expect(result.memories.map(m => m.origin)).toEqual(['human', 'source', 'agent', 'agent', 'agent', 'agent', 'agent', 'agent']);
  expect(result.memories[0]).toMatchObject({ key: 'release.tags', trust: expect.any(String), selection_reason: 'human_recent' });
  expect(result.memories[1]).toMatchObject({ origin: 'source', trust: 'derived', source_path: 'README.md', selection_reason: 'source_backed_recent' });
  expect(result.memories.filter(m => m.origin === 'agent').every(m => m.trust === 'agent_observation' && m.selection_reason === 'agent_observation_recent')).toBe(true);
  // An agent-authored "rule" is never presented as a project rule.
  expect(result.memories.some(m => (m.kind as string) === 'rule')).toBe(false);
  expect(result.latest_handoff).toMatchObject({ goal: 'Character distance clarity', status: 'in_progress', next_action: 'Continue Character distance clarity.', selection_reason: 'latest_handoff' });
  expect(result.available).toEqual({ memories: 8, more_memories: 0, handoffs: 2, older_handoffs: 1 });
  const text = renderBootstrap(result);
  expect(text).toContain('release.tags · decision · human-reviewed'); expect(text).toContain('renderer.csm · decision · source-backed (README.md)');
  expect(text).toContain('agent observation'); expect(text).toContain('Next: Continue Character distance clarity.'); expect(text).toContain('More available: 1 older handoff.');
  // Deterministic for an unchanged snapshot.
  expect(bundle()).toEqual(result);
});

test('conflicts are summarized, never presented as memory', async () => {
  const client = host.project(a); await client.sync();
  client.propose({ key: 'shadow.mode', kind: 'decision', text: 'Shadow rendering requires temporal antialiasing.', from: agent('x') });
  client.propose({ key: 'shadow.mode', kind: 'decision', text: 'Shadow rendering does not require temporal antialiasing.', from: agent('y') });
  const result = bundle();
  expect(result.attention).toMatchObject({ conflicts: 2, conflict_keys: ['shadow.mode'] });
  expect(result.memories.some(m => m.key === 'shadow.mode')).toBe(false);
  expect(renderBootstrap(result)).toContain('2 unresolved memory conflicts (shadow.mode); no side is current truth.');
});

test('source-backed memory whose source changed is withheld, using the broker freshness rule', async () => {
  const client = host.project(a); await client.sync();
  const m = client.propose({ key: 'renderer.csm', kind: 'decision', text: 'The renderer uses cascaded shadow maps without a TAA dependency.', source_path: 'README.md' });
  expect(bundle().memories.map(x => x.id)).toContain(m.id);
  writeFileSync(join(a, 'README.md'), '# Alpha\nThe renderer now uses a different shadow technique.\n'); await client.sync();
  const result = bundle();
  expect(result.memories.map(x => x.id)).not.toContain(m.id); expect(result.attention.stale_source_backed).toBe(1);
  expect(renderBootstrap(result)).toContain('1 source-backed memory withheld: supporting source changed since capture.');
  expect((await client.context({ task: 'renderer cascaded shadow maps' })).items.some(i => i.id === m.id)).toBe(false);
});

test('byte budget bounds the index with 100 available memories', async () => {
  const client = host.project(a); await client.sync();
  for (let i = 0; i < 100; i++) client.propose({ key: `lesson.${String(i).padStart(3, '0')}`, kind: 'experience', text: `Durable renderer lesson number ${i}: ${'mip selection detail '.repeat(8)}`, from: agent(`s${i}`) });
  client.createHandoff(handoff('Character distance clarity'));
  const standard = bundle();
  expect(standard.memories.length).toBeLessThanOrEqual(8); expect(size(standard)).toBeLessThanOrEqual(6000); expect(standard.budget.used).toBe(size(standard));
  expect(standard.available.memories).toBe(100); expect(standard.available.more_memories).toBe(100 - standard.memories.length);
  const tight = bundle(a, 1500);
  expect(size(tight)).toBeLessThanOrEqual(1500); expect(tight.latest_handoff).toBeDefined(); expect(tight.memories.length).toBeLessThan(standard.memories.length);
  expect(tight.available.more_memories).toBe(100 - tight.memories.length);
  expect(() => bundle(a, 100)).toThrow(/budget/);
  expect(renderBootstrap(standard)).toMatch(/More available: \d+ more memories\./);
});

test('project isolation: a bootstrap bound to Alpha never contains Beta records', async () => {
  await host.project(a).sync(); await host.project(b).sync();
  host.project(a).propose({ key: 'alpha.fact', kind: 'decision', text: 'Alpha keeps its renderer settings local.', from: agent() });
  const newer = host.project(b); newer.propose({ key: 'beta.fact', kind: 'decision', text: 'BETA_ONLY newest and most relevant observation.', from: agent() });
  newer.createHandoff(handoff('BETA_ONLY work'));
  const alpha = bundle(a), text = renderBootstrap(alpha);
  expect(JSON.stringify(alpha)).not.toContain('BETA_ONLY'); expect(text).not.toContain('BETA_ONLY'); expect(alpha.latest_handoff).toBeUndefined();
  expect(alpha.project.name).toBe('Alpha');
  expect(JSON.stringify(bundle(b))).not.toContain('Alpha keeps');
});

test('nested registered project and subdirectories resolve to the nearest registration; unregistered is undefined', async () => {
  const child = join(a, 'packages', 'child'); mkdirSync(child, { recursive: true }); writeFileSync(join(child, 'README.md'), 'child');
  host.init(child, 'Child'); host.project(a).propose({ key: 'parent.only', kind: 'decision', text: 'Parent-only decision for Alpha.', from: agent() });
  const deep = join(child, 'src'); mkdirSync(deep);
  expect(host.bootstrap(deep)!.project.name).toBe('Child'); expect(JSON.stringify(host.bootstrap(deep))).not.toContain('Parent-only');
  const sub = join(a, 'docs'); mkdirSync(sub); expect(host.bootstrap(sub)!.project.name).toBe('Alpha');
  const outside = join(root, 'unregistered'); mkdirSync(outside); expect(host.bootstrap(outside)).toBeUndefined();
});

test('workspace binding: worktree handoffs and source freshness stay with their checkout', async () => {
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  git(a, 'init'); git(a, 'add', '.'); git(a, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-m', 'fixture');
  const feature = join(root, 'alpha-feature'); git(a, 'worktree', 'add', '-b', 'feature', feature);
  const primary = host.project(a); await primary.sync();
  const worktree = host.workspace(a, feature); await worktree.sync();
  const m = primary.propose({ key: 'renderer.csm', kind: 'decision', text: 'The renderer uses cascaded shadow maps without a TAA dependency.', source_path: 'README.md' });
  worktree.createHandoff(handoff('Feature-only work'));
  writeFileSync(join(feature, 'README.md'), '# Alpha feature\nChanged in the worktree only.\n'); await worktree.sync();
  const main = bundle(a), feat = bundle(join(feature));
  expect(main.project.project_id).toBe(feat.project.project_id);
  expect(main.workspace).toEqual({ label: 'Primary workspace' }); expect(feat.workspace).toMatchObject({ label: 'alpha-feature', workspace_id: expect.stringMatching(/^ws_/) });
  expect(main.memories.map(x => x.id)).toContain(m.id); expect(main.latest_handoff).toBeUndefined();
  expect(feat.memories.map(x => x.id)).not.toContain(m.id); expect(feat.attention.stale_source_backed).toBe(1); expect(feat.latest_handoff?.goal).toBe('Feature-only work');
});

test('bootstrap is read-only and never runs doctor or a source scan', async () => {
  const client = host.project(a); await client.sync(); client.propose({ key: 'k.one', kind: 'decision', text: 'A durable read-only check.', from: agent() });
  const diagnose = vi.spyOn(SqliteStorage.prototype, 'diagnose'), save = vi.spyOn(SqliteStorage.prototype, 'saveContext'), replace = vi.spyOn(SqliteStorage.prototype, 'replaceResources');
  const before = host.inspection.stats(host.projects().find(p => p.name === 'Alpha')!.project_id, ''), sync = client.status().sync;
  writeFileSync(join(a, 'NEW.md'), 'A file created after the last sync.');
  bundle();
  expect(diagnose).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled(); expect(replace).not.toHaveBeenCalled();
  expect(host.inspection.stats(host.projects().find(p => p.name === 'Alpha')!.project_id, '')).toEqual(before); expect(client.status().sync).toEqual(sync);
});

test('secret-looking memory content is withheld from startup context', async () => {
  const client = host.project(a); await client.sync();
  client.propose({ key: 'deploy.token', kind: 'memory', text: 'The deploy api_key = "abcd1234efgh5678" lives here.', from: agent() });
  const result = bundle();
  expect(JSON.stringify(result)).not.toContain('abcd1234efgh5678'); expect(result.attention.withheld).toBe(1);
  expect(renderBootstrap(result)).toContain('1 record withheld from startup context');
});

test('Claude settings install is additive, idempotent, repairable and removes only Continuity', () => {
  const env = { CLAUDE_CONFIG_DIR: join(root, 'claude') }; mkdirSync(env.CLAUDE_CONFIG_DIR);
  const target = claudeHookTarget(process.execPath, resolve('dist/packages/cli/src/index.js'), home, env), settings = target.file;
  const foreign = { type: 'command', command: 'node', args: ['other-hook.js'] };
  writeFileSync(settings, JSON.stringify({ model: 'opus', hooks: { SessionStart: [{ matcher: 'startup', hooks: [foreign] }, { matcher: 'resume', hooks: [] }], PreToolUse: [{ matcher: 'Bash', hooks: [foreign] }] } }, null, 2));
  expect(hookIntegrationStatus(target).state).toBe('missing');
  const installed = installHookIntegration(target);
  expect(installed).toMatchObject({ state: 'installed', changed: true, current: true }); expect(existsSync(installed.backup!)).toBe(true);
  const after = JSON.parse(readFileSync(settings, 'utf8'));
  expect(after.model).toBe('opus'); expect(after.hooks.PreToolUse).toEqual([{ matcher: 'Bash', hooks: [foreign] }]);
  expect(after.hooks.SessionStart).toEqual([{ matcher: 'startup', hooks: [foreign] }, { matcher: 'resume', hooks: [] }, { matcher: 'startup|resume|clear|compact', hooks: [target.expected] }]);
  expect(target.expected).toMatchObject({ command: process.execPath, args: ['--no-warnings', resolve('dist/packages/cli/src/index.js'), '--home', home, 'integrate', 'claude', 'session-start'] });
  // A foreign hook that merely ends with the same words is not Continuity's and is never touched.
  const lookalike = { type: 'command', command: 'node', args: ['tools/other.js', 'integrate', 'claude', 'session-start'] };
  const withLookalike = JSON.parse(readFileSync(settings, 'utf8')); withLookalike.hooks.SessionStart[0].hooks.push(lookalike); writeFileSync(settings, JSON.stringify(withLookalike));
  expect(hookIntegrationStatus(target)).toMatchObject({ state: 'installed', entries: 1 });
  expect(installHookIntegration(target)).toMatchObject({ changed: false, entries: 1 });
  const moved = claudeHookTarget(process.execPath, join(root, 'moved', 'cli', 'src', 'index.js'), home, env);
  expect(hookIntegrationStatus(moved)).toMatchObject({ state: 'stale', cli_available: false });
  installHookIntegration(target); expect(hookIntegrationStatus(target)).toMatchObject({ state: 'installed', entries: 1 });
  removeHookIntegration(target);
  const removed = JSON.parse(readFileSync(settings, 'utf8'));
  expect(removed.hooks.SessionStart).toEqual([{ matcher: 'startup', hooks: [foreign, lookalike] }, { matcher: 'resume', hooks: [] }]); expect(removed.model).toBe('opus');
  expect(removeHookIntegration(target)).toMatchObject({ changed: false, state: 'missing' });
  writeFileSync(settings, '{ not json'); expect(hookIntegrationStatus(target).state).toBe('invalid_config');
  expect(() => installHookIntegration(target)).toThrow(); expect(readFileSync(settings, 'utf8')).toBe('{ not json');
});

test('Codex hooks.json install quotes paths literally and restores the original file on remove', () => {
  const env = { CODEX_HOME: join(root, 'codex') }; mkdirSync(env.CODEX_HOME);
  const odd = join(root, "it's $HOME ü", 'cli', 'src', 'index.js'), target = codexHookTarget(process.execPath, odd, home, env);
  writeFileSync(target.file, JSON.stringify({ hooks: {} }));
  installHookIntegration(target);
  const hook = JSON.parse(readFileSync(target.file, 'utf8')).hooks.SessionStart[0].hooks[0];
  expect(hook.commandWindows).toBe(`& '${process.execPath}' --no-warnings '${odd.replace(/'/g, "''")}' --home '${home}' integrate codex session-start`);
  expect(hook.command).toBe(`'${process.execPath}' --no-warnings '${odd.replace(/'/g, "'\\''")}' --home '${home}' integrate codex session-start`);
  expect(installHookIntegration(target)).toMatchObject({ entries: 1 }); expect(JSON.parse(readFileSync(target.file, 'utf8')).hooks.SessionStart).toHaveLength(1);
  expect(hookIntegrationStatus(target)).toMatchObject({ state: 'stale', current: true, cli_available: false });
  removeHookIntegration(target); expect(JSON.parse(readFileSync(target.file, 'utf8'))).toEqual({ hooks: {} });
});

test('Claude SessionStart hook: registered emits context, anything else stays silent, never exit 2', async () => {
  await host.project(a).sync(); host.project(a).createHandoff(handoff('Character distance clarity'));
  const cli = resolve('dist/packages/cli/src/index.js');
  const hook = (input: string, useHome = home) => spawnSync(process.execPath, [cli, '--home', useHome, 'integrate', 'claude', 'session-start'], { input, encoding: 'utf8', windowsHide: true });
  const registered = hook(JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', cwd: a, session_id: 's' }));
  expect(registered.status).toBe(0);
  const output = JSON.parse(registered.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
  expect(output.hookSpecificOutput.hookEventName).toBe('SessionStart'); expect(output.hookSpecificOutput.additionalContext).toContain('Continuity · Alpha');
  expect(output.hookSpecificOutput.additionalContext).toContain('Character distance clarity'); expect(output.hookSpecificOutput.additionalContext).not.toContain(root);
  const outside = join(root, 'elsewhere'); mkdirSync(outside);
  for (const input of [JSON.stringify({ cwd: outside, source: 'startup' }), JSON.stringify({ cwd: join(root, 'missing-dir') }), '{not json', '', JSON.stringify({ source: 'startup' })]) {
    const silent = hook(input); expect(silent.status, input).toBe(0); expect(silent.stdout, input).toBe('');
  }
  const codex = spawnSync(process.execPath, [cli, '--home', home, 'integrate', 'codex', 'session-start'], { input: JSON.stringify({ cwd: a, source: 'startup' }), encoding: 'utf8', windowsHide: true });
  expect(codex.status).toBe(0); expect(codex.stdout.startsWith('Continuity · Alpha')).toBe(true);
  const codexOutside = spawnSync(process.execPath, [cli, '--home', home, 'integrate', 'codex', 'session-start'], { input: JSON.stringify({ cwd: outside }), encoding: 'utf8', windowsHide: true });
  expect(codexOutside.status).toBe(0); expect(codexOutside.stdout).toBe('');
  const noHome = hook(JSON.stringify({ cwd: a }), join(root, 'no-home')); expect(noHome.status).toBe(0); expect(noHome.stdout).toBe(''); expect(existsSync(join(root, 'no-home'))).toBe(false);
});

test('a human-accepted source-backed memory is withheld once its source changes, like the broker', async () => {
  const client = host.project(a); await client.sync();
  const quarantined = client.propose({ key: 'deploy.branch', kind: 'memory', text: 'Deploys come from the release branch.', source_path: 'README.md' });
  host.review(a, quarantined.id, 'accepted', 'Maintainer');
  writeFileSync(join(a, 'README.md'), '# Alpha\nDeploys come from the release branch.\n'); await client.sync();
  // Accepted while unproven, then the source changed again: the exact version is not current.
  writeFileSync(join(a, 'README.md'), '# Alpha\nSomething else entirely.\n'); await client.sync();
  const result = bundle();
  expect(result.memories.map(m => m.id)).not.toContain(quarantined.id); expect(result.attention.stale_source_backed).toBeGreaterThanOrEqual(1);
  expect((await client.context({ task: 'deploy release branch' })).items.some(i => i.id === quarantined.id)).toBe(false);
});

test('a sensitive newest handoff is withheld, never replaced by an older one', async () => {
  const client = host.project(a); await client.sync();
  client.createHandoff(handoff('Older harmless work'));
  client.createHandoff({ ...handoff('Rotate credentials'), recommended_next_action: 'Use api_key = "abcd1234efgh5678" for the deploy.' });
  const result = bundle();
  expect(result.latest_handoff).toBeUndefined(); expect(result.attention.withheld).toBe(1); expect(JSON.stringify(result)).not.toContain('abcd1234efgh5678');
  expect(renderBootstrap(result)).not.toContain('Older harmless work');
});

test('a reused path of a removed worktree does not inherit the project', async () => {
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  git(a, 'init'); git(a, 'add', '.'); git(a, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-m', 'fixture');
  const feature = join(root, 'alpha-feature'); git(a, 'worktree', 'add', '-b', 'feature', feature);
  host.workspace(a, feature); host.project(a).propose({ key: 'alpha.private', kind: 'decision', text: 'Alpha private decision.', from: agent() });
  expect(host.bootstrap(feature)?.project.name).toBe('Alpha');
  git(a, 'worktree', 'remove', '--force', feature);
  mkdirSync(feature); git(feature, 'init');
  expect(host.bootstrap(feature)).toBeUndefined();
});

test('hook commands keep hostile-looking paths literal in the real shell', { timeout: 60_000 }, () => {
  const quote = String.fromCharCode(0x2019);
  const dir = join(root, `O${quote}Brien's $HOME ${quote}; Write-Output INJECTED; #`, 'cli', 'src'); mkdirSync(dir, { recursive: true });
  const cli = join(dir, 'index.js'); writeFileSync(cli, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
  const weirdHome = join(root, `home ${quote}; Write-Output INJECTED; # 'x' $env:USERNAME`);
  const hook = codexHookTarget(process.execPath, cli, weirdHome).expected;
  const run = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', hook.commandWindows as string], { encoding: 'utf8', windowsHide: true })
    : spawnSync('sh', ['-c', hook.command as string], { encoding: 'utf8' });
  // Injection would print a separate INJECTED line; literal quoting yields exactly the argv JSON.
  expect(run.stdout.trim().includes(String.fromCharCode(10))).toBe(false);
  expect(JSON.parse(run.stdout)).toEqual(['--home', weirdHome, 'integrate', 'codex', 'session-start']);
});

test('a symlinked provider settings file stays a symlink and its target is updated', (context) => {
  const dotfiles = join(root, 'dotfiles'), config = join(root, 'claude-linked'); mkdirSync(dotfiles); mkdirSync(config);
  const real = join(dotfiles, 'settings.json'); writeFileSync(real, JSON.stringify({ theme: 'dark' }));
  try { symlinkSync(real, join(config, 'settings.json'), 'file'); } catch { context.skip(); return; }
  const target = claudeHookTarget(process.execPath, resolve('dist/packages/cli/src/index.js'), home, { CLAUDE_CONFIG_DIR: config });
  installHookIntegration(target);
  expect(lstatSync(join(config, 'settings.json')).isSymbolicLink()).toBe(true);
  expect(JSON.parse(readFileSync(real, 'utf8'))).toMatchObject({ theme: 'dark', hooks: { SessionStart: [{ hooks: [target.expected] }] } });
});

test('worktrees of a repository with a separate git dir are recognized; an unattached registered root gets no context', async () => {
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  const sep = join(root, 'sep'), store = join(root, 'sep-git'); mkdirSync(sep); writeFileSync(join(sep, 'README.md'), 'sep');
  git(sep, 'init', `--separate-git-dir=${store}`); git(sep, 'add', '.'); git(sep, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-m', 'fixture');
  host.init(sep, 'Separate'); const nested = join(sep, '.worktrees', 'feat'); git(sep, 'worktree', 'add', '-b', 'feat', nested);
  const worktree = host.workspace(sep, nested); host.project(sep).createHandoff(handoff('PRIMARY goal')); worktree.createHandoff(handoff('FEATURE goal'));
  expect(host.bootstrap(nested)).toMatchObject({ workspace: { label: 'feat' }, latest_handoff: { goal: 'FEATURE goal' } });
  // Break the link: the registered worktree root must not fall back to the primary checkout's context.
  renameSync(join(store, 'worktrees', 'feat'), join(root, 'pruned-worktree-metadata'));
  expect(host.bootstrap(nested)).toBeUndefined(); expect(host.bootstrap(sep)?.latest_handoff?.goal).toBe('PRIMARY goal');
});

test('older handoff count excludes a withheld newest handoff; dangling settings symlinks are refused', async (context) => {
  const client = host.project(a); await client.sync();
  client.createHandoff({ ...handoff('Rotate credentials'), recommended_next_action: 'Use api_key = "abcd1234efgh5678".' });
  expect(bundle().available).toMatchObject({ handoffs: 1, older_handoffs: 0 }); expect(renderBootstrap(bundle())).not.toContain('older handoff');
  const config = join(root, 'dangling'); mkdirSync(config);
  try { symlinkSync(join(root, 'missing-target.json'), join(config, 'settings.json'), 'file'); } catch { context.skip(); return; }
  const target = claudeHookTarget(process.execPath, resolve('dist/packages/cli/src/index.js'), home, { CLAUDE_CONFIG_DIR: config });
  expect(() => installHookIntegration(target)).toThrow(/dangling/); expect(lstatSync(join(config, 'settings.json')).isSymbolicLink()).toBe(true);
});
