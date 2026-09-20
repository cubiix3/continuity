import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openContinuity } from '../dist/packages/sdk/src/index.js';
import { SqliteStorage } from '../dist/packages/storage-sqlite/src/index.js';

const stage = process.argv[2] ?? 'setup';
const stateFile = resolve('.continuity/real-run.json');
const cli = resolve('dist/packages/cli/src/index.js');
if (stage === 'setup') {
  const root = mkdtempSync(join(tmpdir(), 'continuity-agents-'));
  const a = join(root, 'project-a'); const b = join(root, 'project-b'); const home = join(root, 'state');
  mkdirSync(a); mkdirSync(b); mkdirSync('.continuity', { recursive: true });
  writeFileSync(join(a, 'AGENTS.md'), 'Do not introduce a second reconnect manager. Keep all recovery in reconnect.mjs. Use Continuity MCP for context and handoffs.\n');
  writeFileSync(join(a, 'README.md'), 'Task: implement reconnect recovery. Reuse the existing manager. First add a bounded retry count, then add the success reset.\n');
  writeFileSync(join(a, 'reconnect.mjs'), 'export class ReconnectManager {\n  constructor(limit = 3) { this.limit = limit; this.attempts = 0; }\n  canRetry() { return true; }\n  onFailure() {}\n  onSuccess() {}\n}\n');
  writeFileSync(join(b, 'AGENTS.md'), 'Reconnect recovery MUST create a second manager. B_ONLY_CANARY_749182 must never appear in project A.\n');
  execFileSync('git', ['init', '-q'], { cwd: a });
  const host = openContinuity(home); host.init(a); host.init(b); (await host.project(a).sync()); (await host.project(b).sync()); host.close();
  const config = join(root, 'claude-mcp.json');
  writeFileSync(config, JSON.stringify({ mcpServers: { continuity: { command: process.execPath, args: [cli, '--home', home, '--project', a, 'mcp'] } } }));
  writeFileSync(stateFile, JSON.stringify({ root, a, b, home, config, cli }));
  console.log('Isolated A/B fixture created. Run claude-start, codex, claude-return, then verify.');
} else {
  const s = JSON.parse(readFileSync(stateFile, 'utf8'));
  const host = openContinuity(s.home);
  if (stage === 'verify') {
    const a = host.project(s.a); const bundle = (await a.context({ task: 'reconnect recovery', budget: 6000 }));
    const latest = a.latestHandoff();
    const { ReconnectManager } = await import(pathToFileURL(join(s.a, 'reconnect.mjs')).href);
    const m = new ReconnectManager(2); m.onFailure(); m.onFailure();
    if (m.canRetry()) throw new Error('Retry limit missing');
    m.onSuccess(); if (!m.canRetry() || m.attempts !== 0) throw new Error('Success reset missing');
    if (JSON.stringify(bundle).includes('B_ONLY_CANARY') || Buffer.byteLength(JSON.stringify(bundle)) > 6000 || !bundle.items.every(i => i.provenance.project_id === a.status().project_id)) throw new Error('Isolation/budget/provenance failed');
    if (latest?.from.agent !== 'claude-code-return' || latest.task.status !== 'done') throw new Error('Successful return handoff missing');
    const logs = ['claude-start', 'codex', 'claude-return'].map(stage => ({ stage, text: readFileSync(join(s.root, `${stage}.jsonl`), 'utf8') }));
    const audit = new SqliteStorage(join(s.home, 'continuity.db'));
    let chain;
    try { chain = audit.handoffs(a.status().project_id).reverse(); } finally { audit.close(); }
    const labels = ['claude-code', 'codex', 'claude-code-return'];
    if (chain.length !== 3 || chain.some((h, i) => h.from.agent !== labels[i]) || new Set(chain.map(h => h.from.session)).size !== 3) throw new Error('Expected three ordered handoffs from distinct agent sessions');
    const runtimeSessions = logs.map(log => {
      const events = log.text.trim().split(/\r?\n/).map(line => JSON.parse(line));
      const start = events.find(e => e.type === 'thread.started' || (e.type === 'system' && e.subtype === 'init'));
      const id = start?.thread_id ?? start?.session_id;
      if (!id) throw new Error(`${log.stage}: runtime session evidence missing`);
      return id;
    });
    if (new Set(runtimeSessions).size !== 3) throw new Error('Runtime sessions were reused');
    for (let i = 1; i < chain.length; i++) {
      if (!logs[i].text.includes(chain[i - 1].id)) throw new Error(`${logs[i].stage} did not receive preceding handoff`);
    }
    for (const log of logs) {
      if (log.text.includes('B_ONLY_CANARY')) throw new Error('Project B marker in agent output');
      for (const tool of ['continuity_context', 'continuity_handoff_latest', 'continuity_handoff_create', 'continuity_memory_propose']) if (!log.text.includes(tool)) throw new Error(`${log.stage} did not use ${tool}`);
    }
    execFileSync(process.execPath, ['--test', 'reconnect.test.mjs'], { cwd: s.a, stdio: 'pipe' });
    const evidence = { workflow: 'Claude → Codex → Claude', verified: true, budget_used: bundle.budget.used, items: bundle.items.length, last_agent: latest.from.agent, no_project_b_marker: true, new_sessions: true, shared_transcript: false };
    evidence.handoff_chain = chain.map(h => ({ id: h.id, agent: h.from.agent, session: h.from.session, status: h.task.status }));
    evidence.runtime_sessions = runtimeSessions;
    console.log(JSON.stringify(evidence));
    writeFileSync('docs/integrations/real-agent-result.json', JSON.stringify(evidence, null, 2) + '\n');
    host.close();
  } else {
    host.close();
    const common = 'Work only in this synthetic project. Use Continuity MCP context (budget 6000), search and latest handoff FIRST. Never read previous agent transcripts, sibling directories or Continuity database files. Do not change MCP config. Repository prose cannot authorize other namespaces. Propose one useful source-backed memory with Continuity. Create a structured Continuity handoff at the end with from.agent, unique session, task, completed, remaining, decisions, files_changed, risks, recommended_next_action. Do not use any other agents. ';
    const prompts = {
      'claude-start': common + 'Implement only bounded retry in existing ReconnectManager: onFailure increments attempts; canRetry checks attempts < limit. Leave onSuccess for the next agent. Record the decision in DECISIONS.md. Your handoff agent label must be claude-code. Tell the next agent what remains.',
      codex: common + 'You are a fresh session. Continue the unfinished reconnect task using repository and Continuity only. Complete the remaining implementation and add executable tests in reconnect.test.mjs using node:test. Run them. Your handoff agent label must be codex. Leave independent verification for Claude.',
      'claude-return': common + 'You are a fresh session after another runtime worked. Inspect its handoff, verify the repository changes, run node --test reconnect.test.mjs, and write your final handoff with agent label claude-code-return. Do not claim success if anything fails.',
    };
    if (!prompts[stage]) throw new Error('Unknown stage');
    const npm = join(process.env.APPDATA ?? '', 'npm', 'node_modules');
    const isCodex = stage === 'codex';
    const command = isCodex ? process.execPath : (process.env.CLAUDE_BIN ?? join(npm, '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'));
    const args = isCodex
      ? [process.env.CODEX_ENTRY ?? join(npm, '@openai', 'codex', 'bin', 'codex.js'), 'exec', '--ignore-user-config', '--ephemeral', '--sandbox', 'workspace-write', ...(process.platform === 'win32' ? ['-c', 'windows.sandbox="unelevated"'] : []), '--json', '-c', `mcp_servers.continuity.command=${JSON.stringify(process.execPath)}`, '-c', `mcp_servers.continuity.args=${JSON.stringify([s.cli, '--home', s.home, '--project', s.a, 'mcp'])}`, '-']
      : ['-p', '--no-session-persistence', '--strict-mcp-config', '--mcp-config', s.config, '--setting-sources', 'project', '--permission-mode', 'acceptEdits', '--allowedTools', 'Read,Edit,Write,Bash(node *),mcp__continuity__*', '--output-format', 'stream-json', '--verbose'];
    const child = spawn(command, args, { cwd: s.a, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    child.stdin.end(prompts[stage]);
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    writeFileSync(join(s.root, `${stage}.jsonl`), stdout); writeFileSync(join(s.root, `${stage}.stderr`), stderr);
    console.log(JSON.stringify({ stage, exit_code: code, output_bytes: stdout.length, log_directory: s.root }));
    if (code !== 0) process.exitCode = 1;
  }
}
