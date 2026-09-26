import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HookProviderName } from './index.js';
import { assertWritable, writeFileAtomically } from './files.js';

/**
 * The provider-native MCP entry an integration owns next to its hooks: one stdio server named `continuity` that the
 * provider starts per session. The server binds to that session's directory through the host resolver (see
 * `integrate <provider> mcp`), so the entry itself carries no project. Only this entry is ever added, changed or removed.
 */
export const MCP_SERVER_NAME = 'continuity';
/**
 * installed: current; missing: wanted but absent; stale: ours but outdated or unwanted; disabled: ours, turned off by
 * the user (left as it is); foreign: the name belongs to someone else; invalid_config: unreadable, or a file this
 * editor does not change safely.
 */
export type McpEntryState = 'installed' | 'missing' | 'stale' | 'disabled' | 'foreign' | 'absent' | 'invalid_config';
export interface McpTarget { provider: HookProviderName; file: string; command: string; args: string[] }

/** Claude Code keeps user-scope MCP servers in `.claude.json`: `$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json`. */
export function claudeMcpTarget(executable: string, cli: string, home: string, env: NodeJS.ProcessEnv = process.env): McpTarget {
  return { provider: 'claude', file: env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, '.claude.json') : join(homedir(), '.claude.json'), command: executable, args: ['--no-warnings', cli, '--home', home, 'integrate', 'claude', 'mcp'] };
}
/** Codex keeps MCP servers in `config.toml` under CODEX_HOME (default `~/.codex`). */
export function codexMcpTarget(executable: string, cli: string, home: string, env: NodeJS.ProcessEnv = process.env): McpTarget {
  return { provider: 'codex', file: join(env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml'), command: executable, args: ['--no-warnings', cli, '--home', home, 'integrate', 'codex', 'mcp'] };
}

const BOM = 0xfeff;
const readText = (file: string) => { const raw = readFileSync(file, 'utf8'); return raw.charCodeAt(0) === BOM ? { text: raw.slice(1), bom: true } : { text: raw, bom: false }; };
const CLI_ENTRY = /[\\/]cli[\\/]src[\\/]index\.js$/;
const ours = (provider: HookProviderName, args: unknown) => Array.isArray(args) && args.slice(-3).join(' ') === `integrate ${provider} mcp` && args.some(a => typeof a === 'string' && CLI_ENTRY.test(a));

type ClaudeConfig = Record<string, unknown> & { mcpServers?: Record<string, unknown>; projects?: Record<string, { disabledMcpServers?: unknown }> };
function readClaude(file: string): { config: ClaudeConfig; exists: boolean } {
  if (!existsSync(file)) return { config: {}, exists: false };
  const { text } = readText(file);
  if (!text.trim()) return { config: {}, exists: true };
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Claude Code configuration must be a JSON object.');
  const config = parsed as ClaudeConfig;
  if (config.mcpServers !== undefined && (typeof config.mcpServers !== 'object' || config.mcpServers === null || Array.isArray(config.mcpServers))) throw new Error('"mcpServers" must be an object.');
  return { config, exists: true };
}
const claudeEntry = (t: McpTarget) => ({ type: 'stdio', command: t.command, args: t.args, env: {} });
function claudeState(t: McpTarget, wanted: boolean, config: ClaudeConfig): McpEntryState {
  const entry = config.mcpServers?.[MCP_SERVER_NAME] as Record<string, unknown> | undefined;
  if (!entry) return wanted ? 'missing' : 'absent';
  if (!ours('claude', entry.args)) return 'foreign';
  const current = (entry.type === undefined || entry.type === 'stdio') && entry.command === t.command && JSON.stringify(entry.args) === JSON.stringify(t.args)
    && (entry.env === undefined || (typeof entry.env === 'object' && entry.env !== null && !Object.keys(entry.env).length));
  return wanted && current ? 'installed' : 'stale';
}

/** TOML basic string: backslashes, quotes and control characters escaped; everything else literal UTF-8. */
const tomlString = (value: string) => `"${Array.from(value, c => c === '\\' ? '\\\\' : c === '"' ? '\\"' : c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f ? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}` : c).join('')}"`;
const commandLine = (t: McpTarget) => `command = ${tomlString(t.command)}`;
const argsLine = (t: McpTarget) => `args = [${t.args.map(tomlString).join(', ')}]`;
const codexBlock = (t: McpTarget) => [`[mcp_servers.${MCP_SERVER_NAME}]`, commandLine(t), argsLine(t)];

// One TOML key segment: bare, basic-quoted or literal-quoted.
const SEGMENT = String.raw`(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')`;
const HEADER = new RegExp(String.raw`^\s*(\[\[?)\s*(${SEGMENT}(?:\s*\.\s*${SEGMENT})*)\s*(\]\]?)\s*(?:#.*)?$`);
const segments = (path: string) => [...path.matchAll(new RegExp(SEGMENT, 'g'))].map(([s]) => ({ name: s.startsWith('"') || s.startsWith("'") ? s.slice(1, -1) : s, quoted: s.startsWith('"') || s.startsWith("'") }));
/** The line without its strings and comment, for bracket counting and key detection (strings are single-line here). */
const bare = (line: string) => line.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""').replace(/#.*$/, '');
const KEY_LINE = (key: string) => new RegExp(String.raw`^\s*(?:${key}|"${key}"|'${key}')\s*=`);
interface Table { start: number; end: number; path: string[] }
interface TomlLayout { lines: string[]; eol: string; bom: boolean; main?: Table; subs: Table[]; foreign: boolean; unsafe?: string }
/**
 * A deliberately small view of config.toml: table headers are recognised only outside arrays and inline tables, with a
 * strict header grammar. Anything this editor could misread (multi-line strings, quoted or inline `mcp_servers`, array
 * tables) is `unsafe`, and then nothing is written.
 */
function tomlLayout(text: string, bom = false): TomlLayout {
  const eol = text.includes('\r\n') ? '\r\n' : '\n', lines = text.split(/\r?\n/);
  const layout: TomlLayout = { lines, eol, bom, subs: [], foreign: false };
  if (/"""|'''/.test(text)) return { ...layout, unsafe: 'multi-line strings' };
  const tables: Table[] = [];
  let depth = 0, current: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (depth === 0 && /^\s*\[/.test(line)) {
      const header = HEADER.exec(line);
      if (!header || header[1]!.length !== header[3]!.length) return { ...layout, unsafe: `unrecognised table header on line ${i + 1}` };
      const path = segments(header[2]!);
      if (path[0]!.name === 'mcp_servers' && (path[0]!.quoted || header[1] === '[[')) return { ...layout, unsafe: `unusual mcp_servers table on line ${i + 1}` };
      if (tables.length) tables.at(-1)!.end = i;
      tables.push({ start: i, end: lines.length, path: path.map(s => s.name) });
      current = path.map(s => s.name);
      continue;
    }
    const content = bare(line);
    if (depth === 0) {
      if (!current.length && /^\s*(?:mcp_servers|"mcp_servers"|'mcp_servers')\s*[.=]/.test(content)) {
        if (/^\s*(?:mcp_servers|"mcp_servers"|'mcp_servers')\s*\.\s*(?:continuity|"continuity"|'continuity')\s*[.=]/.test(content)) layout.foreign = true;
        else return { ...layout, unsafe: `mcp_servers defined inline on line ${i + 1}` };
      }
      if (current.length === 1 && current[0] === 'mcp_servers' && /^\s*(?:continuity|"continuity"|'continuity')\s*[.=]/.test(content)) layout.foreign = true;
    }
    depth += (content.match(/[[{]/g) ?? []).length - (content.match(/[\]}]/g) ?? []).length;
    if (depth < 0) return { ...layout, unsafe: `unbalanced brackets on line ${i + 1}` };
  }
  if (depth !== 0) return { ...layout, unsafe: 'unclosed array or inline table' };
  // A table's trailing comments and blank lines belong to what follows it.
  for (const table of tables) while (table.end > table.start + 1 && /^\s*(#.*)?$/.test(lines[table.end - 1]!)) table.end--;
  for (const table of tables) {
    if (table.path[0] !== 'mcp_servers' || table.path[1] !== MCP_SERVER_NAME) continue;
    if (table.path.length === 2) { if (layout.main) return { ...layout, unsafe: 'duplicate continuity table' }; layout.main = table; } else layout.subs.push(table);
  }
  return layout;
}
function codexState(t: McpTarget, wanted: boolean, layout: TomlLayout): McpEntryState {
  if (layout.unsafe) return 'invalid_config';
  if (layout.foreign) return 'foreign';
  if (!layout.main) return layout.subs.length ? 'foreign' : wanted ? 'missing' : 'absent';
  const body = layout.lines.slice(layout.main.start + 1, layout.main.end);
  const text = body.join('\n');
  if (!/["']integrate["']\s*,\s*["']codex["']\s*,\s*["']mcp["']\s*\]/.test(text) || !/cli[\\/]{1,2}src[\\/]{1,2}index\.js/.test(text)) return 'foreign';
  if (!wanted) return 'stale';
  // Codex's own settings under this table (approvals, timeouts, tool lists) are the user's: only command and args are ours.
  if (body.some(l => /^\s*enabled\s*=\s*false\b/.test(l))) return 'disabled';
  const trimmed = body.map(l => l.trim());
  return trimmed.includes(commandLine(t)) && trimmed.includes(argsLine(t)) ? 'installed' : 'stale';
}

/** Reads the provider's MCP configuration only; a missing file means absent, an unreadable or unsafe one invalid_config. */
export function mcpState(t: McpTarget, wanted = true): McpEntryState {
  try {
    if (t.provider === 'claude') return claudeState(t, wanted, readClaude(t.file).config);
    if (!existsSync(t.file)) return wanted ? 'missing' : 'absent';
    const { text, bom } = readText(t.file);
    return codexState(t, wanted, tomlLayout(text, bom));
  } catch { return 'invalid_config'; }
}
const normalPath = (path: string) => { const p = path.replace(/\\/g, '/').replace(/\/+$/, ''); return process.platform === 'win32' ? p.toLowerCase() : p; };
/**
 * Whether a session in `directory` really has the detail tools: the entry is installed and not turned off for that
 * project (Claude Code keeps per-project `disabledMcpServers` in the same file).
 */
export function mcpUsable(t: McpTarget, directory: string): boolean {
  if (mcpState(t) !== 'installed') return false;
  if (t.provider !== 'claude') return true;
  try {
    const projects = readClaude(t.file).config.projects ?? {}, wanted = normalPath(directory);
    return !Object.entries(projects).some(([key, value]) => normalPath(key) === wanted && Array.isArray(value?.disabledMcpServers) && value.disabledMcpServers.includes(MCP_SERVER_NAME));
  } catch { return false; }
}

/**
 * Adds or repairs this integration's entry, or removes it (`wanted` false). A foreign `continuity` server, a disabled
 * one and anything this editor cannot change safely are left untouched. Backups roll: one per file, private.
 */
export function writeMcpEntry(t: McpTarget, wanted: boolean): { changed: boolean; state: McpEntryState; backup?: string } {
  const state = mcpState(t, wanted);
  if (state === 'invalid_config') throw new Error(`${t.file} could not be read, or has a form Continuity does not edit. Nothing was changed.`);
  if (['foreign', 'installed', 'absent', 'disabled'].includes(state)) return { changed: false, state };
  assertWritable(t.file);
  if (t.provider === 'claude') {
    const { config, exists } = readClaude(t.file);
    const servers: Record<string, unknown> = { ...(config.mcpServers ?? {}) };
    if (wanted) servers[MCP_SERVER_NAME] = claudeEntry(t); else delete servers[MCP_SERVER_NAME];
    const next: ClaudeConfig = { ...config, mcpServers: servers };
    if (!Object.keys(servers).length && config.mcpServers === undefined) delete next.mcpServers;
    const backup = writeFileAtomically(t.file, JSON.stringify(next, null, 2) + '\n', exists, { rolling: true });
    return { changed: true, state: mcpState(t, wanted), ...(backup ? { backup } : {}) };
  }
  const exists = existsSync(t.file), { text, bom } = exists ? readText(t.file) : { text: '', bom: false };
  const layout = tomlLayout(text, bom);
  let lines = [...layout.lines];
  if (!wanted) {
    const drop = new Set([layout.main!, ...layout.subs].flatMap(({ start, end }) => Array.from({ length: end - start }, (_, k) => start + k)));
    // A blank line that only separated a dropped table goes with it: never a blank run or a leading blank at the joint.
    for (const i of [...drop]) for (let j = i + 1; j < lines.length && !drop.has(j) && !lines[j]!.trim(); j++) {
      const previous = [...Array(i).keys()].reverse().find(k => !drop.has(k));
      if (previous === undefined || !lines[previous]!.trim()) drop.add(j); else break;
    }
    lines = lines.filter((_, i) => !drop.has(i));
  } else if (layout.main) {
    // Replace only our two keys (each possibly a multi-line value) and keep every other line of the table.
    const { start, end } = layout.main, body: string[] = [];
    for (let i = start + 1; i < end; i++) {
      const key = ['command', 'args'].find(k => KEY_LINE(k).test(lines[i]!));
      if (!key) { body.push(lines[i]!); continue; }
      let depth = 0, j = i;
      for (; j < end; j++) { depth += (bare(lines[j]!).match(/[[{]/g) ?? []).length - (bare(lines[j]!).match(/[\]}]/g) ?? []).length; if (depth <= 0) break; }
      body.push(key === 'command' ? commandLine(t) : argsLine(t)); i = j;
    }
    for (const line of [commandLine(t), argsLine(t)]) if (!body.includes(line)) body.unshift(line);
    lines = [...lines.slice(0, start + 1), ...body, ...lines.slice(end)];
  } else {
    while (lines.length && !lines.at(-1)!.trim()) lines.pop();
    lines.push(...(lines.length ? [''] : []), ...codexBlock(t));
  }
  while (lines.length > 1 && !lines.at(-1)!.trim() && !lines.at(-2)!.trim()) lines.pop();
  const out = lines.join(layout.eol).replace(new RegExp(`(?:${layout.eol})*$`), '') + layout.eol;
  const backup = writeFileAtomically(t.file, (layout.bom ? String.fromCharCode(BOM) : '') + (out.trim() ? out : ''), exists, { rolling: true });
  return { changed: true, state: mcpState(t, wanted), ...(backup ? { backup } : {}) };
}
