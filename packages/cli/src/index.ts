#!/usr/bin/env node
import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { openContinuity } from '../../sdk/src/index.js';
import type { ContextBundle, ContextRequest } from '../../core/src/index.js';
import { GenericAdapter } from '../../adapter-generic/src/index.js';
import { serveMcp } from '../../adapter-mcp/src/index.js';
import { createLocalServer } from '../../server/src/index.js';

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
program.command('doctor').description('Check storage, registrations and runtime').action(() => { const health = runtime().doctor(); output(health); if (health.integrity !== 'ok' || !health.fts5 || health.problems.length) process.exitCode = 1; });
const project = program.command('project').description('Manage local project identities');
project.command('status').action(() => output(client().status()));
project.command('list').action(() => output(runtime().projects()));
project.command('rebind <id>').requiredOption('--from <path>', 'previous canonical root').requiredOption('--to <path>', 'verified destination directory').action((id: string, options: { from: string; to: string }) => output(runtime().rebind(id, options.from, options.to)));
program.command('retention').command('status').action(() => output(runtime().retention(program.opts<{ project: string }>().project)));
program.command('prune').requiredOption('--dry-run', 'preview only; deletion is not implemented').action(() => output(runtime().retention(program.opts<{ project: string }>().project)));
program.command('sync').description('Refresh source hashes and search index').action(() => output(client().sync()));
program.command('search <query>').description('Search current project sources').action((query: string) => output(client().search(query)));
program.command('context <task>').description('Build a bounded context bundle').option('--role <role>', 'implementation, reviewer, planning', 'implementation').option('--budget <bytes>', 'maximum serialized UTF-8 bytes', '6000').action((task: string, options: { role: string; budget: string }) => contextOutput(client().context({ task, role: options.role as ContextRequest['role'], budget: Number(options.budget) })));
program.command('inspect <id>').description('Read a saved historical context bundle').action((id: string) => output(client().inspect(id)));
program.command('explain <id>').description('Explain selection in a saved context bundle').action((id: string) => {
  const bundle = client().inspect(id);
  output({ context_id: id, historical: true, items: bundle.items.map(i => ({ id: i.id, source: i.provenance.origin, reasons: i.reasons })) });
});
const memory = program.command('memory').description('Propose and inspect durable source-backed knowledge');
memory.command('list').action(() => output(client().memories()));
memory.command('pending').action(() => output(client().memories().filter(m => ['proposed', 'needs_attention'].includes(m.status))));
for (const [command, decision] of [['approve', 'accepted'], ['reject', 'rejected']] as const) {
  memory.command(`${command} <id>`).requiredOption('--by <reviewer>', 'local human reviewer label').action((id: string, options: { by: string }) => output(runtime().review(program.opts<{ project: string }>().project, id, decision, options.by)));
}
memory.command('show <id>').action((id: string) => output(client().memory(id)));
memory.command('remember <text>').requiredOption('--key <key>', 'stable claim key').option('--source <path>', 'project-relative source path; omit for human review').option('--kind <kind>', 'rule, decision, memory, experience', 'memory').action((text: string, options: { key: string; source?: string; kind: string }) => output(client().propose({ text, key: options.key, ...(options.source ? { source_path: options.source } : {}), kind: options.kind })));
memory.command('forget <id>').description('Deactivate a memory while preserving revision history').action((id: string) => output(client().forget(id)));
const handoff = program.command('handoff').description('Transfer structured work between agents');
handoff.command('create').description('Read a structured handoff JSON file or stdin (-)').requiredOption('--file <path>').action((options: { file: string }) => output(client().createHandoff(JSON.parse(readFileSync(options.file === '-' ? 0 : options.file, 'utf8')) as unknown)));
handoff.command('latest').action(() => output(client().latestHandoff()));
handoff.command('show <id>').action((id: string) => output(client().handoff(id)));
let persistent = false;
program.command('mcp').description('Serve six project-bound MCP tools over stdio').action(async () => {
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
