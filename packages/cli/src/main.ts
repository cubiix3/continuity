import { Command } from 'commander';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { BootstrapUnavailableError, openContinuity } from '../../sdk/src/index.js';
import type { ContextBundle, ContextRequest, RetrievalMode } from '../../core/src/index.js';
import { BOOTSTRAP_BUDGET, renderBootstrap } from '../../core/src/index.js';
import type { ProjectClient } from '../../core/src/index.js';
import { deniedPath } from '../../core/src/security/denied.js';
import { applySave, autosaveEnabled, editDecision, failureReason, offerableGoal, claudeHookTarget, codexHookTarget, hookIntegrationStatus, installHookIntegration, parseSaveReply, readSeen, readSessionState, recordEdit, editedByOthers, lastEdit, insideGit, DEFAULT_WINDOW_MS, MAX_CHANGED, WINDOW_MARGIN_MS, recordSeen, autosaveInstalled, removeHookIntegration, saveReport, sessionStartInput, sessionStartOutput, sessionStartUnavailable, mcpUsable, saveOffer, stopDecision, stopRequest, stopInput, scopeKey, stopMessage, toolUseInput, writeSessionState } from '../../adapter-hooks/src/index.js';
import { GenericAdapter } from '../../adapter-generic/src/index.js';
import type { ShellReport } from '../../adapter-hooks/src/index.js';
import { continuityHome } from '../../sdk/src/local-ipc.js';
import { readHookInput, TOOL_USE_LIMIT } from './quiet.js';

// Servers, the MCP SDK and the runtime load only for the commands that use them, so provider hooks start fast (#34).
const mcp = () => import('../../adapter-mcp/src/index.js');
const background = () => import('../../sdk/src/background.js');
/** The CLI entry the installed hooks and the runtime run (this module is loaded by it). */
const cliPath = fileURLToPath(new URL('./index.js', import.meta.url));

const program = new Command().name('continuity').description('Persistent context for interchangeable agents.').version('0.2.0')
  .option('--project <directory>', 'project directory', process.cwd())
  .option('--home <directory>', 'private local state directory (or CONTINUITY_HOME)')
  .option('--json', 'machine-readable JSON');
let host: ReturnType<typeof openContinuity> | undefined;
const runtime = () => host ??= openContinuity(program.opts<{ home?: string }>().home);
const client = () => runtime().project(program.opts<{ project: string }>().project);
const json = () => Boolean(program.opts<{ json?: boolean }>().json);
function output(value: unknown): void {
  if (json()) { console.log(JSON.stringify(value, null, 2)); return; }
  if (value === null) { console.log('No handoff recorded.'); return; }
  if (Array.isArray(value)) {
    if (!value.length) console.log('No entries.');
    else for (const entry of value) output(entry);
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, entry] of Object.entries(value)) console.log(`${key}: ${typeof entry === 'object' ? JSON.stringify(entry) : String(entry)}`);
    console.log(); return;
  }
  console.log(String(value));
}
function contextOutput(bundle: ContextBundle): void {
  if (json()) { output(bundle); return; }
  console.log(`${bundle.context_id}\n${bundle.budget.used}/${bundle.budget.requested} UTF-8 bytes · ${bundle.items.length} items\n`);
  for (const item of bundle.items) console.log(`${item.kind} · ${item.provenance.origin}\n${item.content}\n`);
  if (!bundle.items.length) console.log('No matching items fit the budget. Try a broader query or a larger --budget.');
}
program.command('init').description('Register this canonical project directory locally').option('--name <name>').action((options: { name?: string }) => output(runtime().init(program.opts<{ project: string }>().project, options.name)));
program.command('status').description('Show project identity and last sync').action(() => output(client().status()));
program.command('doctor').description('Check storage, registrations, runtime and installed provider integrations').action(async () => {
  const health = await runtime().doctor();
  let retrieval: { status: string; reason: string };
  try { retrieval = await client().retrievalHealth(); }
  catch (error) { retrieval = { status: 'unavailable', reason: error instanceof Error ? error.message : 'Project binding cannot be inspected' }; }
  const provider_integrations = (['claude', 'codex'] as const)
    .map(provider => hookIntegrationStatus(integrationTarget(provider)))
    .filter(status => status.installed || ['installed', 'stale', 'disabled'].includes(status.mcp))
    .map(status => {
      const { provider, state } = status;
      let message = status.message;
      if (state === 'stale') message = `An installed entry is stale. Check continuity integrate ${provider} status with the original --no-autosave or --no-mcp choices, then run continuity integrate ${provider} install with those choices to repair.`;
      if (state === 'partial') message = `Startup context is present, but optional components differ from the default profile. Check continuity integrate ${provider} status with the original --no-autosave or --no-mcp choices before changing settings.`;
      return { provider, state, message };
    });
  output({ ...health, retrieval, provider_integrations, fallback: health.fts5 ? 'FTS5 active' : 'FTS5 unavailable' });
  if (health.integrity !== 'ok' || !health.fts5 || health.problems.length) process.exitCode = 1;
});
const project = program.command('project').description('Manage local project identities');
project.command('status').action(() => output(client().status()));
project.command('list').action(() => output(runtime().projects()));
project.command('rebind <id>').requiredOption('--from <path>', 'previous canonical root').requiredOption('--to <path>', 'verified destination directory').action((id: string, options: { from: string; to: string }) => output(runtime().rebind(id, options.from, options.to)));
program.command('retention').command('status').action(() => output(runtime().retention(program.opts<{ project: string }>().project)));
program.command('prune').requiredOption('--dry-run', 'preview only; deletion is not implemented').action(() => output(runtime().retention(program.opts<{ project: string }>().project)));
program.command('sync').description('Refresh source hashes and optional semantic index').action(async () => output(await client().sync()));
const sources = program.command('sources').description('Manage local project source scope without changing project identity');
sources.command('show').action(() => output(runtime().sourceScope(client().status().project_id)));
for (const action of ['preview', 'set'] as const) {
  sources.command(action).description(action === 'preview' ? 'Read-only source selection and limit check' : 'Atomically replace this project filter')
    .option('--include <patterns...>', 'project-relative allowlist patterns')
    .option('--exclude <patterns...>', 'project-relative denylist patterns')
    .action((options: { include?: string[]; exclude?: string[] }) => {
      const path = program.opts<{ project: string }>().project;
      const candidate = options.include || options.exclude ? options : undefined;
      if (action === 'set') output(runtime().setSourceScope(path, candidate));
      else { const result = runtime().previewSourceScope(path, candidate); output(result); if (result.limit_exceeded) process.exitCode = 1; }
    });
}
sources.command('clear').action(() => output(runtime().clearSourceScope(program.opts<{ project: string }>().project)));
program.command('search <query>').description('Search current project sources').option('--mode <mode>', 'lexical, semantic, hybrid').action(async (query: string, options: { mode?: RetrievalMode }) => output(await client().search(query, options.mode)));
program.command('context <task>').description('Build a bounded context bundle').option('--mode <mode>', 'lexical, semantic, hybrid').option('--role <role>', 'implementation, reviewer, planning', 'implementation').option('--budget <bytes>', 'maximum serialized UTF-8 bytes', '6000').action(async (task: string, options: { role: string; budget: string; mode?: RetrievalMode }) => contextOutput(await client().context({ task, role: options.role as ContextRequest['role'], budget: Number(options.budget), ...(options.mode ? { mode: options.mode } : {}) })));
program.command('inspect <id>').description('Read a saved historical context bundle').action((id: string) => output(client().inspect(id)));
program.command('explain <id>').description('Explain selection in a saved context bundle').option('--verbose', 'include bounded duplicate and budget exclusion records').action((id: string, options: { verbose?: boolean }) => output(client().explain(id, options.verbose)));
const memory = program.command('memory').description('Record and inspect durable source-backed or agent-learned knowledge');
memory.command('list').action(() => output(client().memories()));
memory.command('pending').action(() => output(client().memories().filter(m => ['proposed', 'needs_attention'].includes(m.status))));
for (const [command, decision] of [['approve', 'accepted'], ['reject', 'rejected']] as const) {
  memory.command(`${command} <id>`).requiredOption('--by <reviewer>', 'local human reviewer label').action((id: string, options: { by: string }) => output(runtime().review(program.opts<{ project: string }>().project, id, decision, options.by)));
}
memory.command('show <id>').action((id: string) => output(client().memory(id)));
memory.command('remember <text>').requiredOption('--key <key>', 'stable claim key').option('--source <path>', 'project-relative path proving an exact excerpt').option('--agent <name>', 'originating agent for an automatic learned memory').option('--session <id>', 'originating session; requires --agent').option('--kind <kind>', 'rule, decision, memory, experience', 'memory').action((text: string, options: { key: string; source?: string; kind: string; agent?: string; session?: string }) => output(client().propose({ text, key: options.key, ...(options.source ? { source_path: options.source } : {}), ...(options.agent || options.session ? { from: { agent: options.agent, session: options.session } } : {}), kind: options.kind })));
memory.command('forget <id>').description('Deactivate a memory while preserving revision history').action((id: string) => output(client().forget(id)));
const handoff = program.command('handoff').description('Transfer structured work between agents');
handoff.command('create').description('Read a structured handoff JSON file or stdin (-)').requiredOption('--file <path>').action((options: { file: string }) => output(client().createHandoff(JSON.parse(readFileSync(options.file === '-' ? 0 : options.file, 'utf8')) as unknown)));
handoff.command('latest').action(() => output(client().latestHandoff()));
handoff.command('show <id>').action((id: string) => output(client().handoff(id)));
handoff.command('close <id>').description('Mark a handoff finished; the handoff itself stays unchanged history')
  .requiredOption('--agent <name>', 'who confirms the work is finished').requiredOption('--session <id>', 'session or reference for the record')
  .action((id: string, options: { agent: string; session: string }) => output(client().closeHandoff({ id, from: { agent: options.agent, session: options.session } })));
let persistent = false;
/** runtime start ends within this, below the sign-in task's one-minute limit (#44). */
const START_DEADLINE_MS = 45_000;
const backgroundHome = () => continuityHome(program.opts<{ home?: string }>().home);
const runtimeCommands = program.command('runtime').description('Control the optional local background runtime');
for (const command of ['start', 'run'] as const) runtimeCommands.command(command).description(command === 'run' ? 'Run in the foreground (diagnostics)' : 'Start a hidden background process')
  .option('--port <port>', 'loopback dashboard port', '4783').option('--no-auto-sync', 'serve the dashboard without automatic source sync')
  .action(async (options: { port: string; autoSync: boolean }) => {
    if (command === 'start') {
      // Every start leaves an outcome record: Windows starts this from the sign-in task through a headless console
      // host, whose exit code cannot show a failure (#44).
      const home = backgroundHome(), { recordStart, startCategory } = await import('../../sdk/src/start-record.js');
      // The task's one-minute limit ends only the console host, so the start ends itself well before that.
      const watchdog = setTimeout(() => { recordStart(home, 'failed', 'start_timeout'); process.exit(1); }, START_DEADLINE_MS);
      watchdog.unref();
      try {
        const port = Number(options.port); if (!Number.isInteger(port) || port < 0 || port > 65535) throw Object.assign(new Error('Port must be 0–65535.'), { category: 'invalid_arguments' });
        const result = await (await background()).startBackground(home, cliPath, port, options.autoSync);
        recordStart(home, 'message' in result ? 'already_running' : 'started');
        output(result);
      } catch (error) { recordStart(home, 'failed', startCategory(error)); throw error; }
      finally { clearTimeout(watchdog); }
      return;
    }
    const port = Number(options.port); if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be 0–65535.');
    await (await background()).runBackground(backgroundHome(), port, options.autoSync); persistent = true;
  });
runtimeCommands.command('status').action(async () => output(await (await background()).runtimeRequest(backgroundHome())));
runtimeCommands.command('stop').action(async () => output(await (await background()).stopBackground(backgroundHome())));
const startup = program.command('startup').description('Manage optional Windows sign-in startup for this home');
for (const command of ['install', 'status', 'remove'] as const) startup.command(command).option('--port <port>', 'loopback dashboard port', '4783').option('--no-auto-sync', 'disable automatic source sync')
  .action(async (options: { port: string; autoSync: boolean }) => {
    const port = Number(options.port); if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be 1–65535.');
    const { startupRegistration } = await import('../../sdk/src/startup-windows.js');
    output({ ...startupRegistration(command, backgroundHome(), cliPath, port, options.autoSync), runtime: await (await background()).runtimeRequest(backgroundHome()) });
  });
program.command('dashboard').description('Open the local project continuity dashboard (no browser auto-open)').option('--port <port>', 'loopback port; 0 selects an available port', '4783').action(async (options: { port: string }) => {
  const port = Number(options.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be 0–65535.');
  const { createDashboardServer } = await import('../../server/src/dashboard.js');
  const server = createDashboardServer(runtime());
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  persistent = true;
  const address = server.address();
  console.error(`Continuity dashboard listening on http://127.0.0.1:${typeof address === 'object' && address ? address.port : port}`);
});
program.command('bootstrap').description('Read-only startup index for an agent session in this project (no sync, no writes)')
  .option('--budget <bytes>', `UTF-8 byte budget for the JSON bundle (${BOOTSTRAP_BUDGET.min}–${BOOTSTRAP_BUDGET.max})`, String(BOOTSTRAP_BUDGET.default))
  .action((options: { budget: string }) => {
    const bundle = runtime().bootstrap(program.opts<{ project: string }>().project, { budget: Number(options.budget) });
    if (!bundle) {
      if (json()) output({ registered: false });
      console.error('Continuity: no project is registered for this directory.'); process.exitCode = 3; return;
    }
    if (json()) output(bundle); else process.stdout.write(renderBootstrap(bundle));
  });
const integrate = program.command('integrate').description('Explicit provider integrations for automatic agent startup context');
// Same canonical form as the runtime's continuityHome(), without creating a missing home (hooks must stay side-effect free).
const continuityHomePath = () => {
  const home = resolve(program.opts<{ home?: string }>().home ?? process.env.CONTINUITY_HOME ?? join(homedir(), '.continuity'));
  if (existsSync(home)) return continuityHome(home);
  // A home created later is canonicalized by continuityHome() (real path, lower-case on Windows); installed entries must
  // already match that form, so resolve the nearest existing ancestor (8.3 names, junctions) and append the rest.
  let existing = home; const rest: string[] = [];
  while (!existsSync(existing) && dirname(existing) !== existing) { rest.unshift(basename(existing)); existing = dirname(existing); }
  const canonical = join(existsSync(existing) ? realpathSync.native(existing) : existing, ...rest);
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
};
const integrationTarget = (provider: 'claude' | 'codex', autosave = true, detail = true) =>
  (provider === 'claude' ? claudeHookTarget : codexHookTarget)(process.execPath, realpathSync.native(cliPath), continuityHomePath(), process.env, { autosave, detail });
/** Bounded provider hook input; oversized input is ignored rather than truncated. */
async function hookStdin(limit: number) {
  const early = readHookInput();
  if (early.oversized) return undefined;
  if (early.text !== undefined) return Buffer.byteLength(early.text) > limit ? undefined : early.text;
  // Read to the end even when oversized, so the provider never writes into a closed pipe.
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of process.stdin) { size += (chunk as Buffer).length; if (size <= limit) chunks.push(chunk as Buffer); }
  return size > limit ? undefined : Buffer.concat(chunks).toString('utf8');
}
const scopeOf = (client: { status(): { project_id: string; workspace?: { workspace_id: string } } }) => { const s = client.status(); return scopeKey(s.project_id, s.workspace?.workspace_id); };
const hasStore = () => existsSync(join(continuityHomePath(), 'continuity.db'));
/** A deleted file's folder may be gone too: the nearest existing ancestor, at most 32 levels up. */
function existingAncestor(dir: string, known: Map<string, string | undefined>) {
  const visited: string[] = [];
  let found: string | undefined;
  for (let current = dir, level = 0; level < 32; level++) {
    if (known.has(current)) { found = known.get(current); break; }
    visited.push(current);
    if (existsSync(current)) { found = current; break; }
    if (dirname(current) === current) break;
    current = dirname(current);
  }
  for (const path of visited) known.set(path, found);
  return found;
}
/**
 * What a shell call edited (#34): the scope to offer in, and the scopes to journal for this session. The provider's
 * report (or, without one, the source adapter's bounded check) gives absolute paths. Each is bound by its real folder
 * like a session directory; outside every registered project, or a dependency, build output, VCS, Continuity or
 * secret-looking file, it does not count. A scope another session edited during the command is ambiguous and not
 * attributed. A call that edited another project or workspace than the session's own makes the turn `mixed`.
 */
function shellScope(provider: 'claude' | 'codex', session: string, client: ProjectClient, shell: ShellReport, cwd: string, now: number): { scope: string | undefined; touched: string[] } {
  const home = continuityHomePath(), own = scopeOf(client);
  const since = now - (shell.duration ?? DEFAULT_WINDOW_MS) - WINDOW_MARGIN_MS;
  let files = shell.changed;
  if (!files.length) {
    // A truncated report without paths cannot be bound; Bash in a Git tree reports every change it saw.
    if (shell.more > 0 || (shell.tool === 'Bash' && insideGit(cwd))) return { scope: undefined, touched: [] };
    // Files this session's earlier edits changed were already counted then.
    files = client.changedSources(Math.max(since, lastEdit(home, provider, session, own, now) + 1)).slice(0, MAX_CHANGED);
  }
  const scopes = new Set<string>(), ancestors = new Map<string, string | undefined>(), owners = new Map<string, { scope: string; root: string } | undefined>();
  for (const file of files) {
    try {
      const dir = existingAncestor(dirname(file), ancestors);
      if (!dir) continue;
      const real = realpathSync.native(dir);
      if (!owners.has(real)) { const status = runtime().session(real)?.status(); owners.set(real, status && { scope: scopeKey(status.project_id, status.workspace?.workspace_id), root: status.workspace?.root ?? status.root }); }
      const owner = owners.get(real);
      if (owner && !deniedPath(relative(owner.root, join(real, relative(dir, file))))) scopes.add(owner.scope);
    } catch { /* An unbindable path does not count. */ }
  }
  const touched = [...scopes].filter(scope => !editedByOthers(home, provider, session, scope, since, now));
  return { scope: touched.some(scope => scope !== own) ? 'mixed' : touched.includes(own) ? own : undefined, touched };
}
for (const provider of ['claude', 'codex'] as const) {
  const name = provider === 'claude' ? 'Claude Code' : 'Codex';
  const target = (autosave = true, detail = true) => integrationTarget(provider, autosave, detail);
  const command = integrate.command(provider).description(`${name} startup context, session autosave hooks and project detail tools in the user settings (${provider === 'claude' ? 'CLAUDE_CONFIG_DIR or ~/.claude/settings.json, and .claude.json for the MCP entry' : 'CODEX_HOME or ~/.codex: hooks.json and config.toml'})`);
  command.command('install').description('Add or repair the Continuity hooks and MCP entry; other hooks and servers are preserved')
    .option('--no-autosave', 'startup context only; removes Continuity autosave hooks').option('--no-mcp', 'no project detail tools; removes the Continuity MCP entry')
    .action((options: { autosave: boolean; mcp: boolean }) => output(installHookIntegration(target(options.autosave, options.mcp))));
  command.command('status').option('--no-autosave', 'expect startup context only').option('--no-mcp', 'expect no project detail tools')
    .action((options: { autosave: boolean; mcp: boolean }) => { const status = hookIntegrationStatus(target(options.autosave, options.mcp)); output(status); if (status.state !== 'installed') process.exitCode = 1; });
  command.command('remove').description('Remove only the Continuity hooks and MCP entry').action(() => { const result = removeHookIntegration(target()); output(result); if (result.state === 'invalid_config') process.exitCode = 1; });
  /**
   * Started by the provider for each session, with the session's directory: Claude Code passes CLAUDE_PROJECT_DIR (its
   * working directory is the project too), Codex starts the server in the session's cwd. The host resolver binds it like
   * the startup hook; the model never names a project. Outside every registered project the server has no tools.
   */
  command.command('mcp', { hidden: true }).action(async () => {
    const directory = provider === 'claude' && process.env.CLAUDE_PROJECT_DIR ? process.env.CLAUDE_PROJECT_DIR : process.cwd();
    let bound;
    try { bound = hasStore() ? runtime().session(directory) : undefined; } catch { bound = undefined; }
    const { DETAIL_TOOLS, serveMcp } = await mcp();
    await serveMcp(bound ? new GenericAdapter(bound) : undefined, { tools: DETAIL_TOOLS, ...(provider === 'claude' ? { meta: { 'anthropic/alwaysLoad': true } } : {}) });
    persistent = true;
  });
  // Invoked by the provider. Never blocks the session: unregistered directories and unreadable state stay silent.
  command.command('session-start', { hidden: true }).action(async () => {
    process.exitCode = 0;
    try {
      const start = sessionStartInput(await hookStdin(65536) ?? ''), cwd = start?.cwd;
      if (!start || !cwd || !hasStore()) return;
      let bundle;
      try { bundle = runtime().bootstrap(cwd); }
      catch (error) { if (error instanceof BootstrapUnavailableError) process.stdout.write(sessionStartUnavailable(provider, error.message)); return; }
      // The index names the detail tool only when this session really has it: this integration's MCP entry is installed and
      // on for the project, and the server binds this directory (a nested unregistered checkout shows the parent's index,
      // but its server has no tools).
      if (bundle) {
        let detail = false, client;
        try { client = runtime().session(cwd); detail = !!client && mcpUsable(target().mcp, cwd); } catch { detail = false; }
        process.stdout.write(sessionStartOutput(provider, bundle, new Date(), detail));
        // What this session was shown in full: the listed memories (a bare key in "more available" is not their text).
        // Only these may be replaced by an explicit correction in its saves. Recorded only where saves can happen.
        if (client && start.session && autosaveEnabled(provider) && autosaveInstalled(target())) recordSeen(continuityHomePath(), provider, start.session, bundle.memories.map(m => m.id));
      }
    } catch { /* Silent: Continuity must not disturb unrelated agent sessions. */ }
  });
  // PostToolUse on file edits: flags the session and its bound scope, and gives the first edit of a turn the save
  // contract as additional context. Reads only session_id, cwd, agent_id and the turn id, and for shell tools the
  // changed paths of the provider's report and the duration (#34); never the command, its output or file contents.
  command.command('tool-use', { hidden: true }).action(async () => {
    process.exitCode = 0;
    try {
      const input = toolUseInput(await hookStdin(TOOL_USE_LIMIT) ?? '');
      if (!input || !autosaveEnabled(provider) || !hasStore()) return;
      const client = runtime().session(input.cwd);
      if (!client) return;
      const home = continuityHomePath(), now = Date.now();
      const shell = input.shell ? shellScope(provider, input.session, client, input.shell, input.cwd, now) : undefined;
      const scope = shell ? shell.scope : scopeOf(client);
      for (const edited of shell ? shell.touched : [scope!]) recordEdit(home, provider, input.session, edited, now);
      if (!scope) return;
      const state = readSessionState(home, provider, input.session);
      const decision = editDecision(state, scope, input.subagent, input.turn);
      if (!decision.offer) { if (JSON.stringify(decision.state) !== JSON.stringify(state)) writeSessionState(home, provider, input.session, decision.state); return; }
      // The latest open handoff in this scope may be closed by the answer; only its id is kept, never text.
      const open = client.activeHandoff(), goal = open ? offerableGoal(open) : undefined;
      // Persisted before the offer is shown: an answer without its offer on record is never applied.
      writeSessionState(home, provider, input.session, { ...decision.state, ...(open && goal ? { close: open.id } : {}) });
      process.stdout.write(saveOffer(goal));
    } catch { /* Silent. */ }
  });
  // Stop: applies the save line of the final answer via Core; without one, asks the same model once through a continuation.
  command.command('stop', { hidden: true }).action(async () => {
    process.exitCode = 0;
    let applying = false;
    try {
      const input = stopInput(await hookStdin(1024 * 1024) ?? '');
      if (!input || !autosaveEnabled(provider) || !hasStore()) return;
      const home = continuityHomePath(), state = readSessionState(home, provider, input.session);
      // Only the final answer is read, and only a save in it; without an outstanding offer it is ignored.
      const reply = state.pending ? parseSaveReply(input.message) : undefined;
      const decision = stopDecision(state, input.active, reply !== undefined, input.turn);
      const write = (next: typeof state) => { if (JSON.stringify(next) !== JSON.stringify(state)) writeSessionState(home, provider, input.session, next); };
      if (decision.action === 'none') { write(decision.state); return; }
      if (decision.action === 'request') {
        // Ask only where the edits happened: this stop must bind to the same project/workspace as the edits.
        const client = runtime().session(input.cwd);
        if (!client || scopeOf(client) !== state.scope) { write({ dirty: false, pending: false, ...(state.prompted_at !== undefined ? { prompted_at: state.prompted_at } : {}) }); return; }
        write(decision.state);
        process.stdout.write(stopRequest(provider)); return;
      }
      // Persist first: a crash or timeout below can never cause a second request or a loop.
      write(decision.state);
      applying = true;
      const client = runtime().session(input.cwd);
      if (!client || scopeOf(client) !== state.scope) { process.stdout.write(stopMessage(state.scope === 'mixed' ? 'Continuity: save skipped — this turn edited more than one project or workspace.' : 'Continuity: save skipped — the session moved to another project or workspace.')); return; }
      const report = saveReport(applySave(client, provider, input.session, reply!, state.close, readSeen(home, provider, input.session)));
      if (report) process.stdout.write(stopMessage(report));
    } catch (error) {
      // One short line once a save was attempted; otherwise silent. Never a stack trace, never a blocking exit code.
      if (applying) process.stdout.write(stopMessage(`Continuity: save skipped — ${failureReason(error instanceof Error ? error.message : 'error')}.`));
    }
  });
}
program.command('mcp').description('Serve seven project-bound MCP tools over stdio').action(async () => {
  await (await mcp()).serveMcp(new GenericAdapter(client())); persistent = true;
});
program.command('serve').description('Start the project-bound HTTP API on 127.0.0.1').option('--port <port>', 'local port', '4783').action(async (options: { port: string }) => {
  const port = Number(options.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be 1–65535.');
  const token = process.env.CONTINUITY_API_TOKEN ?? randomBytes(32).toString('hex');
  const { createLocalServer } = await import('../../server/src/index.js');
  const server = createLocalServer(client(), token);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  persistent = true;
  console.error(`Continuity API: http://127.0.0.1:${port}`);
  if (!process.env.CONTINUITY_API_TOKEN) console.error(`Session bearer token: ${token}`);
});
try { await program.parseAsync(); }
catch (error) { console.error(`Continuity: ${error instanceof Error ? error.message : 'Operation failed.'}`); process.exitCode = 1; }
finally { if (!persistent) host?.close(); }
process.once('exit', () => host?.close());
