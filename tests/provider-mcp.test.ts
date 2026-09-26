import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { openContinuity } from '../packages/sdk/src/index.js';
import { claudeHookTarget, codexHookTarget, hookIntegrationStatus, installHookIntegration, mcpState, mcpUsable, removeHookIntegration, writeMcpEntry } from '../packages/adapter-hooks/src/index.js';

// Real CLI processes and MCP stdio sessions; Windows CI runners need more than vitest's 5 s default.
vi.setConfig({ testTimeout: 60_000 });
const cli = resolve('dist/packages/cli/src/index.js');
let root: string, a: string, b: string, home: string, host: ReturnType<typeof openContinuity>;
beforeEach(async () => {
  // Spaces, quotes and non-ASCII characters in every path the provider configs carry.
  root = mkdtempSync(join(tmpdir(), "continuity mcp ü 'q' ")); a = join(root, 'alpha'); b = join(root, 'beta'); home = join(root, 'home');
  mkdirSync(a); mkdirSync(b);
  writeFileSync(join(a, 'README.md'), '# Alpha\n'); writeFileSync(join(b, 'README.md'), '# Beta\n');
  host = openContinuity(home); host.init(a, 'Alpha'); host.init(b, 'Beta'); await host.project(a).sync(); await host.project(b).sync();
  host.project(a).propose({ key: 'alpha.plurals', kind: 'experience', text: 'ALPHA plural forms are read from plural_pl.json.', from: { agent: 'Codex', session: 's' } });
  host.project(b).propose({ key: 'beta.secret-rule', kind: 'experience', text: 'BETA invoices are stored in integer cents.', from: { agent: 'Codex', session: 's' } });
});
afterEach(() => { host.close(); rmSync(root, { recursive: true, force: true }); });

const claudeTarget = (dir: string, options = {}) => claudeHookTarget(process.execPath, cli, home, { CLAUDE_CONFIG_DIR: dir }, options);
const codexTarget = (dir: string, options = {}) => codexHookTarget(process.execPath, cli, home, { CODEX_HOME: dir }, options);
const json = (file: string) => JSON.parse(readFileSync(file, 'utf8'));

test('Claude: the MCP entry is added next to foreign servers and settings, idempotently, and removed alone', () => {
  const dir = join(root, 'claude'); mkdirSync(dir);
  const file = join(dir, '.claude.json');
  const foreign = { type: 'stdio', command: 'npx', args: ['-y', '@example/server'], env: { TOKEN_NAME: 'x' } };
  writeFileSync(file, JSON.stringify({ numStartups: 7, projects: { 'C:\\p': { allowedTools: [] } }, mcpServers: { first: foreign, zeta: { type: 'http', url: 'http://127.0.0.1:1' } } }, null, 2));
  const t = claudeTarget(dir);
  expect(mcpState(t.mcp)).toBe('missing');
  expect(installHookIntegration(t)).toMatchObject({ state: 'installed', mcp: 'installed', changed: true });
  const installed = json(file);
  expect(Object.keys(installed.mcpServers)).toEqual(['first', 'zeta', 'continuity']);
  expect(installed.mcpServers.first).toEqual(foreign); expect(installed.numStartups).toBe(7); expect(installed.projects).toEqual({ 'C:\\p': { allowedTools: [] } });
  expect(installed.mcpServers.continuity).toEqual({ type: 'stdio', command: process.execPath, args: ['--no-warnings', cli, '--home', home, 'integrate', 'claude', 'mcp'], env: {} });
  expect(installHookIntegration(t)).toMatchObject({ changed: false });
  expect(hookIntegrationStatus(t)).toMatchObject({ state: 'installed', mcp: 'installed', detail: true, mcp_settings: file });
  removeHookIntegration(t);
  const removed = json(file);
  expect(removed.mcpServers).toEqual({ first: foreign, zeta: { type: 'http', url: 'http://127.0.0.1:1' } }); expect(removed.numStartups).toBe(7);
  expect(hookIntegrationStatus(t)).toMatchObject({ state: 'missing', mcp: 'missing' });
});

test('Claude: a clean config dir gets both files; --no-mcp keeps hooks and drops only the MCP entry', () => {
  const dir = join(root, 'claude-clean');
  const t = claudeTarget(dir);
  expect(installHookIntegration(t)).toMatchObject({ state: 'installed', changed: true });
  expect(existsSync(join(dir, 'settings.json'))).toBe(true); expect(json(join(dir, '.claude.json')).mcpServers.continuity.args.slice(-3)).toEqual(['integrate', 'claude', 'mcp']);
  const noMcp = claudeTarget(dir, { detail: false });
  expect(hookIntegrationStatus(noMcp)).toMatchObject({ state: 'stale', mcp: 'stale' });
  expect(installHookIntegration(noMcp)).toMatchObject({ state: 'installed', mcp: 'absent', detail: false });
  expect(json(join(dir, '.claude.json')).mcpServers).toEqual({});
  expect(hookIntegrationStatus(t)).toMatchObject({ state: 'partial', mcp: 'missing', message: expect.stringContaining('project detail tools are missing') });
});

test('Claude: a foreign server named continuity is never overwritten or removed; malformed config changes nothing', () => {
  const dir = join(root, 'claude-foreign'); mkdirSync(dir);
  const file = join(dir, '.claude.json');
  // A hand-configured project server from the MCP documentation.
  const manual = { type: 'stdio', command: 'node', args: [cli, '--home', home, '--project', a, 'mcp'], env: {} };
  writeFileSync(file, JSON.stringify({ mcpServers: { continuity: manual } }));
  const t = claudeTarget(dir);
  expect(installHookIntegration(t)).toMatchObject({ state: 'partial', mcp: 'foreign', message: expect.stringContaining("is not Continuity's") });
  expect(json(file).mcpServers.continuity).toEqual(manual);
  removeHookIntegration(t); expect(json(file).mcpServers.continuity).toEqual(manual);
  writeFileSync(file, '{ "mcpServers": [ broken');
  const settingsBefore = readFileSync(join(dir, 'settings.json'), 'utf8');
  expect(hookIntegrationStatus(t)).toMatchObject({ mcp: 'invalid_config' });
  expect(() => installHookIntegration(t)).toThrow(/could not be read/);
  expect(readFileSync(file, 'utf8')).toBe('{ "mcpServers": [ broken'); expect(readFileSync(join(dir, 'settings.json'), 'utf8')).toBe(settingsBefore);
});

test('Claude: a moved CLI makes the entry stale until install repairs it; a symlinked config stays a symlink', (context) => {
  const dir = join(root, 'claude-stale');
  installHookIntegration(claudeTarget(dir));
  const moved = claudeHookTarget(process.execPath, join(root, 'moved', 'dist', 'packages', 'cli', 'src', 'index.js'), home, { CLAUDE_CONFIG_DIR: dir });
  expect(mcpState(moved.mcp)).toBe('stale');
  expect(writeMcpEntry(moved.mcp, true)).toMatchObject({ changed: true, state: 'installed' });
  const real = join(root, 'real-claude.json'); writeFileSync(real, JSON.stringify({ keep: true }));
  const linked = join(root, 'claude-link'); mkdirSync(linked);
  try { symlinkSync(real, join(linked, '.claude.json'), 'file'); } catch { context.skip(); return; }
  writeMcpEntry(claudeTarget(linked).mcp, true);
  expect(lstatSync(join(linked, '.claude.json')).isSymbolicLink()).toBe(true);
  expect(json(real)).toMatchObject({ keep: true, mcpServers: { continuity: { type: 'stdio' } } });
});

test('Codex: the MCP table is appended and removed as a whole block; comments, CRLF and other tables are untouched', () => {
  const dir = join(root, 'codex'); mkdirSync(dir);
  const file = join(dir, 'config.toml');
  const original = ['# user settings', 'model = "gpt-6-sol"', '', '[mcp_servers.node_repl]', 'command = "node"', 'args = ["repl.js"]', '', '[projects.\'C:\\work.dir\']', 'trust_level = "trusted"', ''].join('\r\n');
  writeFileSync(file, original);
  const t = codexTarget(dir);
  expect(installHookIntegration(t)).toMatchObject({ state: 'installed', mcp: 'installed', changed: true });
  const installed = readFileSync(file, 'utf8');
  expect(installed.startsWith(original.trimEnd())).toBe(true); expect(installed).not.toMatch(/[^\r]\n/);
  const block = installed.slice(original.trimEnd().length).trim().split('\r\n');
  expect(block[0]).toBe('[mcp_servers.continuity]');
  expect(installHookIntegration(t)).toMatchObject({ changed: false });
  removeHookIntegration(t);
  expect(readFileSync(file, 'utf8')).toBe(original);
});

test('Codex: TOML strings keep hostile path characters literal and round-trip through the entry check', () => {
  const dir = join(root, 'codex-escape');
  const odd = join(root, 'we"ird\\ü \'dir');
  const t = codexHookTarget(process.execPath, cli, odd, { CODEX_HOME: dir });
  writeMcpEntry(t.mcp, true);
  const text = readFileSync(join(dir, 'config.toml'), 'utf8');
  expect(text).toContain('we\\"ird\\\\ü \'dir');
  expect(mcpState(t.mcp)).toBe('installed');
});

test('Codex: a foreign or dotted-key continuity server is never touched; our stale sub-tables are replaced', () => {
  const dir = join(root, 'codex-foreign'); mkdirSync(dir);
  const file = join(dir, 'config.toml');
  const manual = '[mcp_servers.continuity]\ncommand = "node"\nargs = ["G:/tools/continuity/dist/packages/cli/src/index.js", "--project", "G:/p", "mcp"]\n';
  writeFileSync(file, manual);
  const t = codexTarget(dir);
  expect(installHookIntegration(t)).toMatchObject({ state: 'partial', mcp: 'foreign' }); expect(readFileSync(file, 'utf8')).toBe(manual);
  writeFileSync(file, 'mcp_servers.continuity.command = "node"\n');
  expect(mcpState(t.mcp)).toBe('foreign');
  writeFileSync(file, '[mcp_servers]\ncontinuity = { command = "node" }\n');
  expect(mcpState(t.mcp)).toBe('foreign');
  // Codex's own settings under our table (an approval sub-table, a timeout) belong to the user and survive a repair.
  writeFileSync(file, '');
  writeMcpEntry(t.mcp, true);
  writeFileSync(file, readFileSync(file, 'utf8') + 'startup_timeout_sec = 20\n\n[mcp_servers.continuity.tools.continuity_context]\napproval_mode = "approve"\n\n# the next table\n[after]\nkeep = true\n');
  expect(mcpState(t.mcp)).toBe('installed');
  const moved = codexHookTarget(process.execPath, join(root, 'moved', 'dist', 'packages', 'cli', 'src', 'index.js'), home, { CODEX_HOME: dir });
  expect(mcpState(moved.mcp)).toBe('stale');
  writeMcpEntry(moved.mcp, true);
  const repaired = readFileSync(file, 'utf8');
  expect(mcpState(moved.mcp)).toBe('installed');
  for (const kept of ['startup_timeout_sec = 20', '[mcp_servers.continuity.tools.continuity_context]\napproval_mode = "approve"', '# the next table\n[after]\nkeep = true']) expect(repaired).toContain(kept);
  // A server the user turned off stays off, and no tool is promised.
  writeFileSync(file, repaired.replace('startup_timeout_sec = 20', 'enabled = false'));
  expect(mcpState(t.mcp)).toBe('disabled');
  const before = readFileSync(file, 'utf8');
  expect(installHookIntegration(t)).toMatchObject({ state: 'partial', mcp: 'disabled', message: expect.stringContaining('turned off') });
  expect(readFileSync(file, 'utf8')).toBe(before);
  // Removing takes our table and its sub-tables, and keeps the comment that belongs to the next table.
  removeHookIntegration(t);
  expect(readFileSync(file, 'utf8')).toBe('# the next table\n[after]\nkeep = true\n');
});

test('Codex: files this editor could misread are refused and never written (the review cases)', () => {
  const dir = join(root, 'codex-unsafe'); mkdirSync(dir);
  const file = join(dir, 'config.toml'), t = codexTarget(dir);
  const cases = {
    'a root inline mcp_servers table': 'mcp_servers = { other = { command = "node" } }\n',
    'an array table': '[[mcp_servers.continuity]]\ncommand = "node"\n',
    'an unclosed array': 'x = [\n  1,\n',
    'an unterminated string': 'x = "open\n',
    'an unterminated multi-line string': 'x = """\n[mcp_servers.continuity]\n',
    'an invalid escape in a key': `[projects."G:${'\\'}q"]\ntrust_level = "trusted"\n`,
    'a line that is no key': '[tui]\njust words\n',
  };
  for (const [i, [name, text]] of Object.entries(cases).entries()) {
    const own = join(root, `codex-unsafe-${i}`); mkdirSync(own);
    const target = codexTarget(own), config = join(own, 'config.toml');
    writeFileSync(config, text);
    expect(mcpState(target.mcp), name).toBe('invalid_config');
    // The refusal names the file, the reason and the way out.
    expect(() => installHookIntegration(target), name).toThrow(/does not edit \(.+\)\. Nothing was changed\..*--no-mcp/);
    expect(readFileSync(config, 'utf8'), name).toBe(text);
    expect(existsSync(join(own, 'hooks.json')), name).toBe(false);
    // Hooks only (--no-mcp) do not need the file at all.
    expect(installHookIntegration(codexTarget(own, { detail: false })), name).toMatchObject({ state: 'installed', mcp: 'invalid_config' });
    expect(readFileSync(config, 'utf8'), name).toBe(text);
    // Removing cannot see an entry there, and says so instead of reporting a clean removal.
    expect(removeHookIntegration(target), name).toMatchObject({ state: 'invalid_config', message: expect.stringContaining(config) });
    expect(readFileSync(config, 'utf8'), name).toBe(text);
  }
  // Lines inside a multi-line array that look like headers are values, not tables.
  writeFileSync(file, '');
  writeMcpEntry(t.mcp, true);
  writeFileSync(file, readFileSync(file, 'utf8') + 'enabled_tools = [\n  ["A", "B"],\n  ["C"]\n]\n\n[after]\nkeep = true\n');
  expect(mcpState(t.mcp)).toBe('installed');
  removeHookIntegration(t);
  expect(readFileSync(file, 'utf8')).toBe('[after]\nkeep = true\n');
  // A byte order mark survives.
  writeFileSync(file, String.fromCharCode(0xfeff) + 'model = "m"\n');
  writeMcpEntry(t.mcp, true);
  expect(readFileSync(file, 'utf8').charCodeAt(0)).toBe(0xfeff); expect(mcpState(t.mcp)).toBe('installed');
});

test('Codex: strings, multi-line strings and quoted keys are read as TOML reads them', () => {
  const ourArgs = `args = ["--no-warnings", "${cli.replace(/\\/g, '\\\\')}", "--home", "${home.replace(/\\/g, '\\\\')}", "integrate", "codex", "mcp"]`;
  const u = '\\' + 'u0075';
  // A header inside a multi-line string is text: the file is edited, and the string survives install and remove.
  const texts = {
    'a table inside a multi-line string': `notes = """\n[mcp_servers.continuity]\ncommand = "evil"\n"""\nshort = '"""'\nraw = '''\n[x]\n'''\n\n[projects."G:\\\\Continuity"]\ntrust_level = "trusted"\n`,
    'escaped quotes before a closing delimiter': 'a = """ends with ""quotes"" \\""""\nb = 1\n',
  };
  for (const [i, [name, text]] of Object.entries(texts).entries()) {
    const dir = join(root, `codex-strings-${i}`); mkdirSync(dir);
    const t = codexTarget(dir), file = join(dir, 'config.toml');
    writeFileSync(file, text);
    expect(mcpState(t.mcp), name).toBe('missing');
    expect(installHookIntegration(t), name).toMatchObject({ state: 'installed', mcp: 'installed' });
    expect(readFileSync(file, 'utf8').startsWith(text.trimEnd()), name).toBe(true);
    removeHookIntegration(t);
    expect(readFileSync(file, 'utf8'), name).toBe(text);
  }
  const dir = join(root, 'codex-keys'); mkdirSync(dir);
  const t = codexTarget(dir), file = join(dir, 'config.toml');
  // Quoted and escaped names are decoded: they are the same keys TOML sees.
  for (const text of [`[mcp_servers]\n"contin${u}ity" = { command = "node" }\n`, `[mcp_servers."contin${u}ity"]\ncommand = "node"\nargs = ["x"]\n`]) {
    writeFileSync(file, text);
    expect(mcpState(t.mcp), text).toBe('foreign');
    expect(installHookIntegration(t), text).toMatchObject({ state: 'partial', mcp: 'foreign' }); expect(readFileSync(file, 'utf8')).toBe(text);
  }
  const quoted = `["mcp_servers"."contin${u}ity"]\ncommand = ${JSON.stringify(process.execPath)}\n${ourArgs}\n`;
  writeFileSync(file, quoted);
  expect(mcpState(t.mcp)).toBe('installed');
  removeHookIntegration(t); expect(readFileSync(file, 'utf8')).toBe('');
  // Our entry with a trailing comma and comments in its args is still ours: current, and removed on request.
  writeFileSync(file, `[mcp_servers.continuity]\ncommand = ${JSON.stringify(process.execPath)} # node\n${ourArgs.replace(' "mcp"]', '\n  "mcp", # the server\n] # end')}\n`);
  expect(mcpState(t.mcp)).toBe('installed');
  removeHookIntegration(t); expect(readFileSync(file, 'utf8')).toBe('');
});

test('Codex: any startup key under our table (working directory, environment, execution environment, unknown) is stale, and a repair drops only those', () => {
  const dir = join(root, 'codex-transport');
  const t = codexTarget(dir), file = join(dir, 'config.toml');
  writeMcpEntry(t.mcp, true);
  const clean = readFileSync(file, 'utf8');
  const extras = {
    'a working directory': `cwd = ${JSON.stringify(a)}\n`,
    'an inline environment': 'env = { CONTINUITY_PROJECT = "x" }\n',
    'a dotted environment key': 'env.CLAUDE_PROJECT_DIR = "x"\n',
    'passed-through variables': 'env_vars = [\n  "CLAUDE_PROJECT_DIR",\n]\n',
    'an environment sub-table': '\n[mcp_servers.continuity.env]\nCLAUDE_PROJECT_DIR = "x"\n',
    'an execution environment': 'environment_id = "remote"\n',
    'credentials': 'bearer_token = "x"\n',
    'a key Codex may add later': 'launch_directory = "G:/elsewhere"\n',
  };
  // The user's settings: whether and how long it runs, which tools, and approvals.
  const kept = 'startup_timeout_sec = 20\nstartup_timeout_ms = 20000\nenabled_tools = ["continuity_context"]\nsupports_parallel_tool_calls = true\ntools.continuity_search.approval_mode = "approve"\n';
  for (const [name, extra] of Object.entries(extras)) {
    writeFileSync(file, `${clean}${kept}${extra}\n[after]\nkeep = true\n`);
    expect(mcpState(t.mcp), name).toBe('stale');
    expect(mcpUsable(t.mcp, a), name).toBe(false);
    expect(hookIntegrationStatus(t).state, name).toBe('stale');
    installHookIntegration(t);
    expect(readFileSync(file, 'utf8'), name).toBe(`${clean}${kept}\n[after]\nkeep = true\n`);
    expect(mcpState(t.mcp), name).toBe('installed');
  }
  // Claude Code: any key beyond the entry we write makes it stale, and the repair writes the exact entry.
  const claudeDir = join(root, 'claude-transport'), claude = claudeTarget(claudeDir);
  installHookIntegration(claude);
  const config = json(join(claudeDir, '.claude.json'));
  config.mcpServers.continuity.cwd = a;
  writeFileSync(join(claudeDir, '.claude.json'), JSON.stringify(config));
  expect(mcpState(claude.mcp)).toBe('stale'); expect(mcpUsable(claude.mcp, a)).toBe(false);
  installHookIntegration(claude);
  expect(json(join(claudeDir, '.claude.json')).mcpServers.continuity).not.toHaveProperty('cwd');
  expect(mcpState(claude.mcp)).toBe('installed');
});

test('a dangling Claude config link is refused before any file is written; MCP backups roll', (context) => {
  const dir = join(root, 'claude-dangling'); mkdirSync(dir);
  try { symlinkSync(join(root, 'missing.json'), join(dir, '.claude.json'), 'file'); } catch { context.skip(); return; }
  expect(() => installHookIntegration(claudeTarget(dir))).toThrow(/dangling/);
  expect(existsSync(join(dir, 'settings.json'))).toBe(false);
  const rolling = join(root, 'claude-rolling'); mkdirSync(rolling); writeFileSync(join(rolling, '.claude.json'), '{"keep":1}');
  installHookIntegration(claudeTarget(rolling)); removeHookIntegration(claudeTarget(rolling)); installHookIntegration(claudeTarget(rolling));
  expect(readdirSync(rolling).filter(f => f.startsWith('.claude.json.continuity-backup'))).toEqual(['.claude.json.continuity-backup']);
});

/** A real stdio MCP session with the provider-mode server, started the way the provider starts it. */
async function mcpSession(provider: 'claude' | 'codex', cwd: string, env: Record<string, string> = {}) {
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--no-warnings', cli, '--home', home, 'integrate', provider, 'mcp'], cwd, env: { ...Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !/^CLAUDE_PROJECT_DIR$/.test(k))) as Record<string, string>, ...env }, stderr: 'pipe' });
  const client = new Client({ name: 'test-provider', version: '1.0.0' });
  await client.connect(transport);
  return client;
}
const text = (r: Awaited<ReturnType<Client['callTool']>>) => JSON.stringify(r.structuredContent ?? r.content);

test('the provider server is bound by the session directory, never by tool input', async () => {
  const claude = await mcpSession('claude', b, { CLAUDE_PROJECT_DIR: a });
  try {
    const tools = await claude.listTools();
    expect(tools.tools.map(t => t.name).sort()).toEqual(['continuity_context', 'continuity_handoff_latest', 'continuity_search']);
    // Claude Code loads these tools without a search step.
    expect(tools.tools.every(t => t._meta?.['anthropic/alwaysLoad'] === true)).toBe(true);
    // Context and search refresh the source index and record an audit, so only the handoff read claims to be read-only.
    expect(Object.fromEntries(tools.tools.map(t => [t.name, t.annotations?.readOnlyHint ?? false]))).toEqual({ continuity_context: false, continuity_search: false, continuity_handoff_latest: true });
    // CLAUDE_PROJECT_DIR (the provider's project) wins over the process directory.
    const context = await claude.callTool({ name: 'continuity_context', arguments: { task: 'plural forms invoices' } });
    expect(text(context)).toContain('ALPHA plural forms'); expect(text(context)).not.toContain('BETA');
    for (const args of [{ task: 'invoices', project_id: 'beta' }, { task: 'invoices', root: b }, { task: 'invoices', workspace: b }, { task: 'invoices', database: join(home, 'continuity.db') }]) {
      expect((await claude.callTool({ name: 'continuity_context', arguments: args })).isError, JSON.stringify(args)).toBe(true);
    }
  } finally { await claude.close(); }
  const codex = await mcpSession('codex', b);
  try {
    const tools = await codex.listTools();
    expect(tools.tools.every(t => t._meta === undefined)).toBe(true);
    const context = await codex.callTool({ name: 'continuity_context', arguments: { task: 'plural forms invoices' } });
    expect(text(context)).toContain('BETA invoices'); expect(text(context)).not.toContain('ALPHA');
  } finally { await codex.close(); }
});

test('nested projects bind to themselves; unregistered directories and missing state get no tools', async () => {
  const nested = join(a, 'packages', 'inner'); mkdirSync(nested, { recursive: true }); host.init(nested, 'Inner');
  host.project(nested).propose({ key: 'inner.rule', kind: 'experience', text: 'INNER package keeps its own release notes.', from: { agent: 'Codex', session: 's' } });
  const inner = await mcpSession('codex', nested);
  try { expect(text(await inner.callTool({ name: 'continuity_context', arguments: { task: 'release notes plural forms' } }))).not.toContain('ALPHA'); } finally { await inner.close(); }
  const child = await mcpSession('codex', join(a, 'packages'));
  try { expect(text(await child.callTool({ name: 'continuity_context', arguments: { task: 'plural forms' } }))).toContain('ALPHA'); } finally { await child.close(); }
  const outside = join(root, 'outside'); mkdirSync(outside);
  for (const [provider, cwd, env] of [['codex', outside, {}], ['claude', outside, { CLAUDE_PROJECT_DIR: outside }]] as const) {
    const client = await mcpSession(provider, cwd, env);
    try { expect((await client.listTools().catch(() => ({ tools: [] }))).tools).toEqual([]); } finally { await client.close(); }
  }
  const noHome = spawnSync(process.execPath, ['--no-warnings', cli, '--home', join(root, 'no-home'), 'integrate', 'codex', 'mcp'], { cwd: a, input: '', encoding: 'utf8', windowsHide: true });
  expect(noHome.status).toBe(0); expect(existsSync(join(root, 'no-home'))).toBe(false);
});

test('an attached worktree binds to its workspace; a detached one gets no tools', async () => {
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...args], { cwd, stdio: 'pipe' });
  git(a, 'init'); git(a, 'add', '.'); git(a, 'commit', '-m', 'fixture');
  const feature = join(root, 'alpha-feature'); git(a, 'worktree', 'add', '-b', 'feature', feature);
  await host.workspace(a, feature).sync();
  host.workspace(a, feature).createHandoff({ from: { agent: 'Codex', session: 'w' }, task: { goal: 'FEATURE branch work', status: 'in_progress' }, completed: [], remaining: [], decisions: [], files_changed: [], risks: [], recommended_next_action: 'Continue the feature.' });
  const attached = await mcpSession('codex', feature);
  try { expect(text(await attached.callTool({ name: 'continuity_handoff_latest', arguments: {} }))).toContain('FEATURE branch work'); } finally { await attached.close(); }
  renameSync(join(a, '.git', 'worktrees', 'alpha-feature'), join(root, 'pruned'));
  const detached = await mcpSession('codex', feature);
  try { expect((await detached.listTools().catch(() => ({ tools: [] }))).tools).toEqual([]); } finally { await detached.close(); }
});

test('the startup index names the detail tool only when the MCP entry is really installed', () => {
  for (let i = 0; i < 10; i++) host.project(a).propose({ key: `alpha.lesson-${i}`, kind: 'experience', text: `Alpha lesson number ${i} about locale files.`, from: { agent: 'Codex', session: `s${i}` } });
  const start = (env: Record<string, string>) => spawnSync(process.execPath, ['--no-warnings', cli, '--home', home, 'integrate', 'codex', 'session-start'], { input: JSON.stringify({ cwd: a, source: 'startup' }), encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env } }).stdout;
  // Installed through the real CLI, as a user would: the entry then carries the canonical home and CLI paths.
  const install = (env: Record<string, string>, provider: string) => spawnSync(process.execPath, ['--no-warnings', cli, '--home', home, 'integrate', provider, 'install'], { encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env } });
  const dir = join(root, 'codex-hint');
  expect(start({ CODEX_HOME: dir })).not.toContain('continuity_context');
  install({ CODEX_HOME: dir }, 'codex');
  expect(start({ CODEX_HOME: dir })).toContain('More available: 3 more memories (alpha.lesson-1, alpha.lesson-0, alpha.plurals) via continuity_context.');
  // A stale entry (for example after the CLI moved) is not promised.
  writeMcpEntry(codexHookTarget(process.execPath, join(root, 'old', 'dist', 'packages', 'cli', 'src', 'index.js'), home, { CODEX_HOME: dir }).mcp, true);
  expect(start({ CODEX_HOME: dir })).not.toContain('continuity_context');
  const claudeDir = join(root, 'claude-hint'); install({ CLAUDE_CONFIG_DIR: claudeDir }, 'claude');
  const claude = spawnSync(process.execPath, ['--no-warnings', cli, '--home', home, 'integrate', 'claude', 'session-start'], { input: JSON.stringify({ cwd: a, source: 'startup' }), encoding: 'utf8', windowsHide: true, env: { ...process.env, CLAUDE_CONFIG_DIR: claudeDir } }).stdout;
  expect(JSON.parse(claude).hookSpecificOutput.additionalContext).toContain('More available: 3 more memories (alpha.lesson-1, alpha.lesson-0, alpha.plurals) via continuity_context.');
});

test('no tool is promised where the session has none: a nested unregistered checkout, or a server turned off for the project', () => {
  for (let i = 0; i < 10; i++) host.project(a).propose({ key: `alpha.lesson-${i}`, kind: 'experience', text: `Alpha lesson number ${i} about locale files.`, from: { agent: 'Codex', session: `s${i}` } });
  const env = { ...process.env, CODEX_HOME: join(root, 'cx'), CLAUDE_CONFIG_DIR: join(root, 'cc') };
  for (const provider of ['codex', 'claude']) spawnSync(process.execPath, ['--no-warnings', cli, '--home', home, 'integrate', provider, 'install'], { encoding: 'utf8', windowsHide: true, env });
  const start = (provider: string, cwd: string) => { const out = spawnSync(process.execPath, ['--no-warnings', cli, '--home', home, 'integrate', provider, 'session-start'], { input: JSON.stringify({ cwd, source: 'startup' }), encoding: 'utf8', windowsHide: true, env }).stdout; return provider === 'claude' && out ? JSON.parse(out).hookSpecificOutput.additionalContext as string : out; };
  expect(start('codex', a)).toContain('via continuity_context');
  // A Git checkout nested in the project shows the parent's index, but its MCP server binds nothing.
  const nested = join(a, '.claude', 'worktrees', 'feat'); mkdirSync(nested, { recursive: true }); writeFileSync(join(nested, '.git'), 'gitdir: ../../../.git/worktrees/feat\n');
  expect(start('codex', nested)).toContain('Continuity · Alpha'); expect(start('codex', nested)).not.toContain('continuity_context');
  // Claude Code keeps per-project server toggles in the same file.
  expect(start('claude', a)).toContain('via continuity_context');
  const file = join(root, 'cc', '.claude.json'), config = json(file);
  writeFileSync(file, JSON.stringify({ ...config, projects: { [a.replace(/\\/g, '/')]: { disabledMcpServers: ['continuity'] } } }));
  expect(start('claude', a)).toContain('Continuity · Alpha'); expect(start('claude', a)).not.toContain('continuity_context');
});

test('an install made before the home exists stays current once the home is created (casing, junctions, 8.3 names)', (context) => {
  // A junction makes the real path differ from the given one, as an 8.3 short name in a CI temp path does.
  const real = join(root, 'Real Parent'); mkdirSync(real);
  const linked = join(root, 'Linked Parent');
  try { symlinkSync(real, linked, 'junction'); } catch { context.skip(); return; }
  for (const later of [join(root, 'Later Home'), join(linked, 'Later Home')]) {
    const env = { ...process.env, CODEX_HOME: join(root, `cx-${basename(dirname(later)).replace(/\W/g, '')}`) };
    const run = (...args: string[]) => spawnSync(process.execPath, ['--no-warnings', cli, '--home', later, '--json', ...args], { encoding: 'utf8', windowsHide: true, env });
    expect(JSON.parse(run('integrate', 'codex', 'install').stdout), later).toMatchObject({ state: 'installed' });
    expect(existsSync(later)).toBe(false);
    run('--project', a, 'init');
    expect(JSON.parse(run('integrate', 'codex', 'status').stdout), later).toMatchObject({ state: 'installed', mcp: 'installed' });
  }
});

test('real CLI: install, status and remove report hooks and MCP together for both providers', () => {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: join(root, 'cc'), CODEX_HOME: join(root, 'cx') };
  const cmd = (provider: string, ...args: string[]) => spawnSync(process.execPath, ['--no-warnings', cli, '--home', home, '--json', 'integrate', provider, ...args], { encoding: 'utf8', env, windowsHide: true });
  for (const provider of ['claude', 'codex']) {
    expect(JSON.parse(cmd(provider, 'install').stdout)).toMatchObject({ state: 'installed', mcp: 'installed', entries: 3 });
    expect(cmd(provider, 'status').status).toBe(0);
    expect(cmd(provider, 'status', '--no-mcp').status).toBe(1);
    expect(JSON.parse(cmd(provider, 'install', '--no-mcp').stdout)).toMatchObject({ state: 'installed', mcp: 'absent' });
    expect(JSON.parse(cmd(provider, 'install').stdout)).toMatchObject({ state: 'installed', mcp: 'installed' });
    expect(JSON.parse(cmd(provider, 'remove').stdout)).toMatchObject({ state: 'missing', changed: true });
  }
});
