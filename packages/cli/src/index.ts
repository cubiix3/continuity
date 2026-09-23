#!/usr/bin/env node
import { Command } from 'commander';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { BootstrapUnavailableError, openContinuity } from '../../sdk/src/index.js';
import type { ContextBundle, ContextRequest, RetrievalMode } from '../../core/src/index.js';
import { BOOTSTRAP_BUDGET, renderBootstrap } from '../../core/src/index.js';
import { applySave, autosaveEnabled, offerableGoal, claudeHookTarget, codexHookTarget, hookIntegrationStatus, installHookIntegration, parseSaveReply, readSessionState, removeHookIntegration, saveReport, sessionStartCwd, sessionStartOutput, sessionStartUnavailable, stopBlock, stopDecision, stopInput, scopeKey, stopMessage, toolUseInput, writeSessionState } from '../../adapter-hooks/src/index.js';
import { GenericAdapter } from '../../adapter-generic/src/index.js';
import { serveMcp } from '../../adapter-mcp/src/index.js';
import { createLocalServer } from '../../server/src/index.js';
import { createDashboardServer } from '../../server/src/dashboard.js';
import { continuityHome } from '../../sdk/src/local-ipc.js';
import { runBackground, runtimeRequest, startBackground, stopBackground } from '../../sdk/src/background.js';
import { startupRegistration } from '../../sdk/src/startup-windows.js';

const program = new Command().name('continuity').description('Persistent context for interchangeable agents.').version('0.1.0')
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
program.command('doctor').description('Check storage, registrations and runtime').action(async () => {
  const health = runtime().doctor();
  let retrieval: { status: string; reason: string };
  try { retrieval = await client().retrievalHealth(); }
  catch (error) { retrieval = { status: 'unavailable', reason: error instanceof Error ? error.message : 'Project binding cannot be inspected' }; }
  output({ ...health, retrieval, fallback: health.fts5 ? 'FTS5 active' : 'FTS5 unavailable' });
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
const backgroundHome = () => continuityHome(program.opts<{ home?: string }>().home);
const cliPath = fileURLToPath(import.meta.url);
const runtimeCommands = program.command('runtime').description('Control the optional local background runtime');
for (const command of ['start', 'run'] as const) runtimeCommands.command(command).description(command === 'run' ? 'Run in the foreground (diagnostics)' : 'Start a hidden background process')
  .option('--port <port>', 'loopback dashboard port', '4783').option('--no-auto-sync', 'serve the dashboard without automatic source sync')
  .action(async (options: { port: string; autoSync: boolean }) => {
    const port = Number(options.port); if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be 0–65535.');
    if (command === 'start') output(await startBackground(backgroundHome(), cliPath, port, options.autoSync));
    else { await runBackground(backgroundHome(), port, options.autoSync); persistent = true; }
  });
runtimeCommands.command('status').action(async () => output(await runtimeRequest(backgroundHome())));
runtimeCommands.command('stop').action(async () => output(await stopBackground(backgroundHome())));
const startup = program.command('startup').description('Manage optional Windows sign-in startup for this home');
for (const command of ['install', 'status', 'remove'] as const) startup.command(command).option('--port <port>', 'loopback dashboard port', '4783').option('--no-auto-sync', 'disable automatic source sync')
  .action(async (options: { port: string; autoSync: boolean }) => {
    const port = Number(options.port); if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be 1–65535.');
    output({ ...startupRegistration(command, backgroundHome(), cliPath, port, options.autoSync), runtime: await runtimeRequest(backgroundHome()) });
  });
program.command('dashboard').description('Open the local project continuity dashboard (no browser auto-open)').option('--port <port>', 'loopback port; 0 selects an available port', '4783').action(async (options: { port: string }) => {
  const port = Number(options.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be 0–65535.');
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
  return existsSync(home) ? continuityHome(home) : home;
};
/** Bounded provider hook input; oversized input is ignored rather than truncated. */
async function hookStdin(limit: number) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of process.stdin) { size += (chunk as Buffer).length; if (size > limit) return undefined; chunks.push(chunk as Buffer); }
  return Buffer.concat(chunks).toString('utf8');
}
const scopeOf = (client: { status(): { project_id: string; workspace?: { workspace_id: string } } }) => { const s = client.status(); return scopeKey(s.project_id, s.workspace?.workspace_id); };
const hasStore = () => existsSync(join(continuityHomePath(), 'continuity.db'));
for (const provider of ['claude', 'codex'] as const) {
  const name = provider === 'claude' ? 'Claude Code' : 'Codex';
  const target = (autosave = true) => (provider === 'claude' ? claudeHookTarget : codexHookTarget)(process.execPath, realpathSync.native(fileURLToPath(import.meta.url)), continuityHomePath(), process.env, { autosave });
  const command = integrate.command(provider).description(`${name} startup context and session autosave hooks in the user hook settings (${provider === 'claude' ? 'CLAUDE_CONFIG_DIR or ~/.claude/settings.json' : 'CODEX_HOME or ~/.codex/hooks.json'})`);
  command.command('install').description('Add or repair the Continuity hooks; other hooks are preserved').option('--no-autosave', 'startup context only; removes Continuity autosave hooks')
    .action((options: { autosave: boolean }) => output(installHookIntegration(target(options.autosave))));
  command.command('status').option('--no-autosave', 'expect startup context only')
    .action((options: { autosave: boolean }) => { const status = hookIntegrationStatus(target(options.autosave)); output(status); if (status.state !== 'installed') process.exitCode = 1; });
  command.command('remove').description('Remove only the Continuity hooks').action(() => output(removeHookIntegration(target())));
  // Invoked by the provider. Never blocks the session: unregistered directories and unreadable state stay silent.
  command.command('session-start', { hidden: true }).action(async () => {
    process.exitCode = 0;
    try {
      const cwd = sessionStartCwd(await hookStdin(65536) ?? '');
      if (!cwd || !hasStore()) return;
      let bundle;
      try { bundle = runtime().bootstrap(cwd); }
      catch (error) { if (error instanceof BootstrapUnavailableError) process.stdout.write(sessionStartUnavailable(provider, error.message)); return; }
      if (bundle) process.stdout.write(sessionStartOutput(provider, bundle));
    } catch { /* Silent: Continuity must not disturb unrelated agent sessions. */ }
  });
  // PostToolUse on file edits: flags the session and its bound scope. Reads only session_id and cwd, never the tool payload.
  command.command('tool-use', { hidden: true }).action(async () => {
    process.exitCode = 0;
    try {
      const input = toolUseInput(await hookStdin(1024 * 1024) ?? '');
      if (!input || !autosaveEnabled(provider) || !hasStore()) return;
      const client = runtime().session(input.cwd);
      if (!client) return;
      // The project/workspace the edits belong to; `mixed` when a session edits several.
      const home = continuityHomePath(), state = readSessionState(home, provider, input.session), key = scopeOf(client);
      // While a request is outstanding its scope is fixed: an edit elsewhere makes the answer unusable, never redirects it.
      const scope = (state.dirty || state.pending) && state.scope && state.scope !== key ? 'mixed' : key;
      if (!state.dirty || state.scope !== scope) writeSessionState(home, provider, input.session, { ...state, dirty: true, scope });
    } catch { /* Silent. */ }
  });
  // Stop: after edits, asks the same model once for a deliberate save; on the answering stop, applies it via Core.
  command.command('stop', { hidden: true }).action(async () => {
    process.exitCode = 0;
    let applying = false;
    try {
      const input = stopInput(await hookStdin(1024 * 1024) ?? '');
      if (!input || !autosaveEnabled(provider) || !hasStore()) return;
      const home = continuityHomePath(), state = readSessionState(home, provider, input.session);
      const decision = stopDecision(state, input.active);
      const write = (next: typeof state) => { if (JSON.stringify(next) !== JSON.stringify(state)) writeSessionState(home, provider, input.session, next); };
      if (decision.action === 'none') { write(decision.state); return; }
      if (decision.action === 'prompt') {
        // Ask only where the edits happened: this stop must bind to the same project/workspace as the edits.
        const client = runtime().session(input.cwd);
        if (!client || scopeOf(client) !== state.scope) { write({ dirty: false, pending: false, ...(state.prompted_at !== undefined ? { prompted_at: state.prompted_at } : {}) }); return; }
        // The latest open handoff in this scope may be closed by the answer; only its id is kept, never text.
        const open = client.activeHandoff(), goal = open ? offerableGoal(open) : undefined;
        write({ ...decision.state, scope: state.scope, ...(open && goal ? { close: open.id } : {}) });
        process.stdout.write(stopBlock(goal)); return;
      }
      // Persist first: a crash or timeout below can never cause a second request or a loop.
      write(decision.state);
      // Only the tagged answer to Continuity's own request is read; without it nothing is saved.
      const reply = parseSaveReply(input.message);
      if (!reply) return;
      applying = true;
      const client = runtime().session(input.cwd);
      if (!client || scopeOf(client) !== state.scope) { process.stdout.write(stopMessage('Continuity autosave: nothing saved; the session left the project or workspace where the save was requested.')); return; }
      const report = saveReport(applySave(client, provider, input.session, reply, state.close));
      if (report) process.stdout.write(stopMessage(report));
    } catch (error) {
      // Honest partial-failure report once a save was attempted; otherwise silent.
      if (applying) process.stdout.write(stopMessage(`Continuity autosave did not complete (${error instanceof Error ? error.message.replace(/\s+/g, ' ').slice(0, 160) : 'error'}); earlier items may have been saved.`));
    }
  });
}
program.command('mcp').description('Serve seven project-bound MCP tools over stdio').action(async () => {
  await serveMcp(new GenericAdapter(client())); persistent = true;
});
program.command('serve').description('Start the project-bound HTTP API on 127.0.0.1').option('--port <port>', 'local port', '4783').action(async (options: { port: string }) => {
  const port = Number(options.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be 1–65535.');
  const token = process.env.CONTINUITY_API_TOKEN ?? randomBytes(32).toString('hex');
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
