import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HookProviderName } from './index.js';
import { writeFileAtomically } from './files.js';

/**
 * The provider-native MCP entry an integration owns next to its hooks: one stdio server named `continuity` that the
 * provider starts per session. The server binds to that session's directory through the host resolver (see
 * `integrate <provider> mcp`), so the entry itself carries no project. Only this entry is ever added, changed or removed.
 */
export const MCP_SERVER_NAME = 'continuity';
/** installed: current; missing: wanted but absent; stale: ours but outdated or unwanted; foreign: the name belongs to someone else. */
export type McpEntryState = 'installed' | 'missing' | 'stale' | 'foreign' | 'absent' | 'invalid_config';
export interface McpTarget { provider: HookProviderName; file: string; command: string; args: string[] }

/** Claude Code keeps user-scope MCP servers in `.claude.json`: `$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json`. */
export function claudeMcpTarget(executable: string, cli: string, home: string, env: NodeJS.ProcessEnv = process.env): McpTarget {
  return { provider: 'claude', file: env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, '.claude.json') : join(homedir(), '.claude.json'), command: executable, args: ['--no-warnings', cli, '--home', home, 'integrate', 'claude', 'mcp'] };
}
/** Codex keeps MCP servers in `config.toml` under CODEX_HOME (default `~/.codex`). */
export function codexMcpTarget(executable: string, cli: string, home: string, env: NodeJS.ProcessEnv = process.env): McpTarget {
  return { provider: 'codex', file: join(env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml'), command: executable, args: ['--no-warnings', cli, '--home', home, 'integrate', 'codex', 'mcp'] };
}

const stripBom = (text: string) => text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
const CLI_ENTRY = /[\\/]cli[\\/]src[\\/]index\.js$/;
const ours = (provider: HookProviderName, args: unknown) => Array.isArray(args) && args.slice(-3).join(' ') === `integrate ${provider} mcp` && args.some(a => typeof a === 'string' && CLI_ENTRY.test(a));

type ClaudeConfig = Record<string, unknown> & { mcpServers?: Record<string, unknown> };
function readClaude(file: string): { config: ClaudeConfig; exists: boolean } {
  if (!existsSync(file)) return { config: {}, exists: false };
  const raw = readFileSync(file, 'utf8'), text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
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
const codexBlock = (t: McpTarget) => [`[mcp_servers.${MCP_SERVER_NAME}]`, `command = ${tomlString(t.command)}`, `args = [${t.args.map(tomlString).join(', ')}]`];
const NAME = `(?:${MCP_SERVER_NAME}|"${MCP_SERVER_NAME}"|'${MCP_SERVER_NAME}')`;
/** A table header for this server or one of its sub-tables (`[mcp_servers.continuity]`, `[mcp_servers.continuity.env]`). */
const OWN_HEADER = new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*${NAME}\\s*(?:\\.[^\\]]*)?\\]\\s*(?:#.*)?$`);
const HEADER = /^\s*\[/;
interface TomlLayout { lines: string[]; eol: string; blocks: [number, number][]; inline: boolean }
/** Line-based view: the blocks that define this server, and whether it is also defined inline or with dotted keys. */
function tomlLayout(text: string): TomlLayout {
  const eol = text.includes('\r\n') ? '\r\n' : '\n', lines = text.split(/\r?\n/);
  const blocks: [number, number][] = [];
  let table = '', inline = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (HEADER.test(line)) {
      table = line.trim();
      if (OWN_HEADER.test(line)) { let end = i + 1; while (end < lines.length && !HEADER.test(lines[end]!)) end++; blocks.push([i, end]); }
      continue;
    }
    if (!table && new RegExp(`^\\s*mcp_servers\\s*\\.\\s*${NAME}\\s*[.=]`).test(line)) inline = true;
    if (/^\[\s*mcp_servers\s*\]/.test(table) && new RegExp(`^\\s*${NAME}\\s*[.=]`).test(line)) inline = true;
  }
  return { lines, eol, blocks, inline };
}
const meaningful = (lines: string[]) => lines.map(l => l.trim()).filter(l => l && !l.startsWith('#'));
function codexState(t: McpTarget, wanted: boolean, layout: TomlLayout): McpEntryState {
  if (layout.inline) return 'foreign';
  if (!layout.blocks.length) return wanted ? 'missing' : 'absent';
  const text = layout.blocks.map(([a, b]) => layout.lines.slice(a, b).join('\n')).join('\n');
  if (!new RegExp(`["']integrate["']\\s*,\\s*["']codex["']\\s*,\\s*["']mcp["']\\s*\\]`).test(text) || !/cli[\\/]{1,2}src[\\/]{1,2}index\.js/.test(text)) return 'foreign';
  const current = layout.blocks.length === 1 && JSON.stringify(meaningful(layout.lines.slice(...layout.blocks[0]!))) === JSON.stringify(codexBlock(t));
  return wanted && current ? 'installed' : 'stale';
}

/** Reads the provider's MCP configuration only; a missing file means absent, an unreadable one invalid_config. */
export function mcpState(t: McpTarget, wanted = true): McpEntryState {
  try {
    if (t.provider === 'claude') return claudeState(t, wanted, readClaude(t.file).config);
    return codexState(t, wanted, tomlLayout(existsSync(t.file) ? stripBom(readFileSync(t.file, 'utf8')) : ''));
  } catch { return 'invalid_config'; }
}

/** Adds or repairs this integration's entry, or removes it (`wanted` false). A foreign `continuity` server is never touched. */
export function writeMcpEntry(t: McpTarget, wanted: boolean): { changed: boolean; state: McpEntryState; backup?: string } {
  const state = mcpState(t, wanted);
  if (state === 'invalid_config') throw new Error(`${t.file} could not be read. Nothing was changed.`);
  if (state === 'foreign' || state === 'installed' || state === 'absent') return { changed: false, state };
  if (t.provider === 'claude') {
    const { config, exists } = readClaude(t.file);
    const servers: Record<string, unknown> = { ...(config.mcpServers ?? {}) };
    if (wanted) servers[MCP_SERVER_NAME] = claudeEntry(t); else delete servers[MCP_SERVER_NAME];
    const next: ClaudeConfig = { ...config, mcpServers: servers };
    if (!Object.keys(servers).length && config.mcpServers === undefined) delete next.mcpServers;
    const backup = writeFileAtomically(t.file, JSON.stringify(next, null, 2) + '\n', exists);
    return { changed: true, state: mcpState(t, wanted), ...(backup ? { backup } : {}) };
  }
  const exists = existsSync(t.file), text = exists ? stripBom(readFileSync(t.file, 'utf8')) : '';
  const layout = tomlLayout(text);
  const kept = layout.lines.filter((_, i) => !layout.blocks.some(([a, b]) => i >= a && i < b));
  while (kept.length && !kept.at(-1)!.trim()) kept.pop();
  if (wanted) kept.push(...(kept.length ? [''] : []), ...codexBlock(t));
  const backup = writeFileAtomically(t.file, kept.join(layout.eol) + layout.eol, exists);
  return { changed: true, state: mcpState(t, wanted), ...(backup ? { backup } : {}) };
}
