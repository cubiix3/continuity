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
  let parsed: unknown;
  // JSON.parse quotes part of the input in its message; this file can hold credentials, so the reason stays generic.
  try { parsed = JSON.parse(text); } catch { throw new Error('invalid JSON'); }
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
  // Any other key (a working directory, say) could change where the server starts: only the exact entry is current.
  const current = Object.keys(entry).every(k => ['type', 'command', 'args', 'env'].includes(k)) && (entry.type === undefined || entry.type === 'stdio')
    && entry.command === t.command && JSON.stringify(entry.args) === JSON.stringify(t.args)
    && (entry.env === undefined || (typeof entry.env === 'object' && entry.env !== null && !Object.keys(entry.env).length));
  return wanted && current ? 'installed' : 'stale';
}

/** TOML basic string: backslashes, quotes and control characters escaped; everything else literal UTF-8. */
const tomlString = (value: string) => `"${Array.from(value, c => c === '\\' ? '\\\\' : c === '"' ? '\\"' : c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f ? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}` : c).join('')}"`;
const commandLine = (t: McpTarget) => `command = ${tomlString(t.command)}`;
const argsLine = (t: McpTarget) => `args = [${t.args.map(tomlString).join(', ')}]`;
const codexBlock = (t: McpTarget) => [`[mcp_servers.${MCP_SERVER_NAME}]`, commandLine(t), argsLine(t)];
/**
 * How and where Codex starts a server. Under our table these keys are ours: `command` and `args` as written, and none
 * of the others, since a working directory or an environment would bind every session to one place. Every other key
 * (enabled, timeouts, tool lists, approvals) is the user's and is kept.
 */
const TRANSPORT = new Set(['command', 'args', 'cwd', 'env', 'env_vars', 'url', 'bearer_token_env_var', 'http_headers', 'env_http_headers']);

// A TOML key: bare, basic-quoted or literal-quoted segments joined by dots.
const SEGMENT = String.raw`(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')`;
const KEY_PATH = String.raw`${SEGMENT}(?:\s*\.\s*${SEGMENT})*`;
const HEADER = new RegExp(String.raw`^\s*(\[\[?)\s*(${KEY_PATH})\s*(\]\]?)\s*(?:#.*)?$`);
const KEY = new RegExp(String.raw`^\s*(${KEY_PATH})\s*=`);
const STRING = String.raw`"(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*'`;
const ESCAPES: Record<string, number> = { b: 8, t: 9, n: 10, f: 12, r: 13, e: 27, '"': 34, '\\': 92 };
/** A basic string's value, or undefined for an escape TOML rejects. */
function unescape(body: string): string | undefined {
  let out = '';
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') { out += body[i]; continue; }
    const c = body[++i] ?? '', size = c === 'u' ? 4 : c === 'U' ? 8 : c === 'x' ? 2 : 0;
    if (ESCAPES[c] !== undefined) { out += String.fromCharCode(ESCAPES[c]); continue; }
    const digits = body.slice(i + 1, i + 1 + size), code = parseInt(digits, 16);
    if (!size || digits.length !== size || !/^[0-9A-Fa-f]+$/.test(digits) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return undefined;
    out += String.fromCodePoint(code); i += size;
  }
  return out;
}
const stringValue = (s: string) => s.startsWith('"') ? unescape(s.slice(1, -1)) : s.startsWith("'") ? s.slice(1, -1) : s;
/** A key's decoded parts, or undefined when a part is not valid TOML. */
function keyPath(path: string): string[] | undefined {
  const parts = [...path.matchAll(new RegExp(SEGMENT, 'g'))].map(([s]) => stringValue(s));
  return parts.every(p => p !== undefined) ? parts as string[] : undefined;
}
const brackets = (code: string) => (code.match(/[[{]/g) ?? []).length - (code.match(/[\]}]/g) ?? []).length;

/** A line of config.toml. `code` is the line outside strings and comments, each string as `""`; `inside` means it starts in a multi-line string. */
interface Line { text: string; code: string; inside: boolean }
function scan(texts: string[]): Line[] | string {
  const lines: Line[] = [], string = new RegExp(`^(?:${STRING})`);
  let open: string | undefined;
  for (const [n, text] of texts.entries()) {
    const inside = open !== undefined;
    let code = '';
    for (let i = 0; i < text.length;) {
      if (open) {
        if (open === '"""' && text[i] === '\\') { i += 2; continue; }
        if (!text.startsWith(open, i)) { i++; continue; }
        // Up to two quotes may stand right before the closing delimiter.
        let run = 0; while (text[i + run] === open[0]) run++;
        if (run > 5) return `a malformed multi-line string on line ${n + 1}`;
        i += run; open = undefined; code += '""'; continue;
      }
      const c = text[i]!;
      if (c === '#') break;
      if (c === '"' || c === "'") {
        if (text.startsWith(c.repeat(3), i)) { open = c.repeat(3); i += 3; continue; }
        const match = string.exec(text.slice(i));
        if (!match) return `an unterminated string on line ${n + 1}`;
        code += '""'; i += match[0].length; continue;
      }
      code += c; i++;
    }
    lines.push({ text, code, inside });
  }
  return open ? 'an unterminated multi-line string' : lines;
}

interface Range { start: number; end: number }
interface Table extends Range { path: string[] }
interface TomlLayout { lines: Line[]; eol: string; bom: boolean; main?: Table; subs: Table[]; foreign: boolean; unsafe?: string }
/**
 * A deliberately small view of config.toml. Strings (multi-line ones too) and comments are skipped, table headers are
 * recognised only outside arrays and inline tables, and keys are decoded. Anything this editor could misread (an
 * `mcp_servers` defined inline or as an array of tables, an unrecognised line) is `unsafe`, and then nothing is written.
 */
function tomlLayout(text: string, bom = false): TomlLayout {
  const eol = text.includes('\r\n') ? '\r\n' : '\n', scanned = scan(text.split(/\r?\n/));
  if (typeof scanned === 'string') return { lines: [], eol, bom, subs: [], foreign: false, unsafe: scanned };
  const layout: TomlLayout = { lines: scanned, eol, bom, subs: [], foreign: false };
  const unsafe = (reason: string) => ({ ...layout, unsafe: reason });
  const tables: Table[] = [];
  let depth = 0, current: string[] = [];
  for (const [i, line] of scanned.entries()) {
    const top = depth === 0 && !line.inside;
    if (top && /^\s*\[/.test(line.code)) {
      const header = HEADER.exec(line.text), path = header ? keyPath(header[2]!) : undefined;
      if (!header || !path || header[1]!.length !== header[3]!.length) return unsafe(`an unrecognised table header on line ${i + 1}`);
      if (path[0] === 'mcp_servers' && header[1] === '[[') return unsafe(`an array of mcp_servers tables on line ${i + 1}`);
      if (tables.length) tables.at(-1)!.end = i;
      tables.push({ start: i, end: scanned.length, path });
      current = path;
      continue;
    }
    if (top && line.code.trim()) {
      const key = KEY.exec(line.text), path = key ? keyPath(key[1]!) : undefined;
      if (!path) return unsafe(`an unrecognised line ${i + 1}`);
      const full = [...current, ...path];
      // Our server defined by a dotted key or an inline table is someone else's; the root forms are not edited.
      if (full[0] === 'mcp_servers' && current.length < 2) {
        if (full[1] === MCP_SERVER_NAME) layout.foreign = true;
        else if (!current.length) return unsafe(`mcp_servers defined inline on line ${i + 1}`);
      }
    }
    depth += brackets(line.code);
    if (depth < 0) return unsafe(`unbalanced brackets on line ${i + 1}`);
  }
  if (depth !== 0) return unsafe('an unclosed array or inline table');
  // A table's trailing comments and blank lines belong to what follows it.
  for (const table of tables) while (table.end > table.start + 1 && !scanned[table.end - 1]!.inside && !scanned[table.end - 1]!.code.trim()) table.end--;
  for (const table of tables) {
    if (table.path[0] !== 'mcp_servers' || table.path[1] !== MCP_SERVER_NAME) continue;
    if (table.path.length === 2) { if (layout.main) return unsafe('a duplicate continuity table'); layout.main = table; } else layout.subs.push(table);
  }
  return layout;
}
type Key = Range & { path: string[]; value: string };
/** The keys directly in a table, each with its decoded path, its lines and its value's text. */
function tableKeys(lines: Line[], table: Table): Key[] {
  const keys: Key[] = [];
  for (let i = table.start + 1; i < table.end; i++) {
    if (lines[i]!.inside || !lines[i]!.code.trim()) continue;
    const key = KEY.exec(lines[i]!.text)!;
    let j = i, depth = brackets(lines[i]!.code);
    while (j + 1 < table.end && (depth > 0 || lines[j + 1]!.inside)) depth += brackets(lines[++j]!.code);
    keys.push({ path: keyPath(key[1]!)!, start: i, end: j + 1, value: [lines[i]!.text.slice(key[0].length), ...lines.slice(i + 1, j + 1).map(l => l.text)].join('\n') });
    i = j;
  }
  return keys;
}
const GAP = /^(?:\s|#[^\n]*)*/;
/** A value that is a single-line string, or an array of them (across lines, with comments and a trailing comma). */
function tomlStrings(value: string | undefined): string | string[] | undefined {
  if (value === undefined) return undefined;
  const single = new RegExp(`^\\s*(${STRING})\\s*(?:#.*)?$`).exec(value);
  if (single) return stringValue(single[1]!);
  let rest = value.replace(GAP, '');
  if (!rest.startsWith('[')) return undefined;
  const items: string[] = [], item = new RegExp(`^(?:${STRING})`);
  for (rest = rest.slice(1).replace(GAP, ''); !rest.startsWith(']');) {
    const match = item.exec(rest), decoded = match ? stringValue(match[0]) : undefined;
    if (decoded === undefined) return undefined;
    items.push(decoded); rest = rest.slice(match![0].length).replace(GAP, '');
    if (rest.startsWith(',')) rest = rest.slice(1).replace(GAP, ''); else if (!rest.startsWith(']')) return undefined;
  }
  return /^\][ \t]*(?:#.*)?$/.test(rest) ? items : undefined;
}
function codexState(t: McpTarget, wanted: boolean, layout: TomlLayout): McpEntryState {
  if (layout.unsafe) return 'invalid_config';
  if (layout.foreign) return 'foreign';
  if (!layout.main) return layout.subs.length ? 'foreign' : wanted ? 'missing' : 'absent';
  const keys = tableKeys(layout.lines, layout.main), value = (name: string) => keys.find(k => k.path.length === 1 && k.path[0] === name)?.value;
  const args = tomlStrings(value('args'));
  if (!ours('codex', args)) return 'foreign';
  if (!wanted) return 'stale';
  if (/^\s*false\s*(?:#.*)?$/.test(value('enabled') ?? '')) return 'disabled';
  const transport = keys.filter(k => TRANSPORT.has(k.path[0]!)).map(k => k.path.join('.')).sort().join(' ');
  const current = transport === 'args command' && tomlStrings(value('command')) === t.command && JSON.stringify(args) === JSON.stringify(t.args)
    && !layout.subs.some(s => TRANSPORT.has(s.path[2]!));
  return current ? 'installed' : 'stale';
}

function inspect(t: McpTarget, wanted: boolean): { state: McpEntryState; problem?: string } {
  try {
    if (t.provider === 'claude') return { state: claudeState(t, wanted, readClaude(t.file).config) };
    if (!existsSync(t.file)) return { state: wanted ? 'missing' : 'absent' };
    const { text, bom } = readText(t.file), layout = tomlLayout(text, bom);
    return { state: codexState(t, wanted, layout), ...(layout.unsafe ? { problem: layout.unsafe } : {}) };
  } catch (error) { return { state: 'invalid_config', problem: error instanceof Error ? error.message : 'unreadable' }; }
}
/** Reads the provider's MCP configuration only; a missing file means absent, an unreadable or unsafe one invalid_config. */
export function mcpState(t: McpTarget, wanted = true): McpEntryState { return inspect(t, wanted).state; }
/** Names the provider file Continuity does not edit, and why. */
export function mcpConfigRefusal(t: McpTarget): string {
  const { problem } = inspect(t, true);
  return `${t.file} could not be read, or has a form Continuity does not edit${problem ? ` (${problem})` : ''}.`;
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
  if (state === 'invalid_config') throw new Error(`${mcpConfigRefusal(t)} Nothing was changed.`);
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
  const layout = tomlLayout(text, bom), texts = layout.lines.map(l => l.text);
  let lines: string[];
  if (layout.main) {
    const indexes = (r: Range) => Array.from({ length: r.end - r.start }, (_, k) => r.start + k);
    // Removing drops our table and its sub-tables. Repairing keeps the user's settings and writes command and args in
    // place, dropping any other transport key or sub-table.
    const drop = new Set((wanted ? layout.subs.filter(s => TRANSPORT.has(s.path[2]!)) : [layout.main, ...layout.subs]).flatMap(indexes));
    const put = new Map<number, string[]>();
    if (wanted) {
      const written = new Set<string>();
      for (const key of tableKeys(layout.lines, layout.main).filter(k => TRANSPORT.has(k.path[0]!))) {
        indexes(key).forEach(i => drop.add(i));
        const line = key.path.join('.') === 'command' ? commandLine(t) : key.path.join('.') === 'args' ? argsLine(t) : undefined;
        if (line && !written.has(line)) { put.set(key.start, [line]); written.add(line); }
      }
      put.set(layout.main.start, [texts[layout.main.start]!, ...[commandLine(t), argsLine(t)].filter(l => !written.has(l))]);
    }
    const kept = (i: number) => put.has(i) || !drop.has(i);
    // A blank line that only separated a dropped table goes with it: never a blank run or a leading blank at the joint.
    for (const i of [...drop].filter(i => !put.has(i))) for (let j = i + 1; j < texts.length && !drop.has(j) && !texts[j]!.trim(); j++) {
      const previous = [...Array(i).keys()].reverse().find(kept);
      if (previous === undefined || !texts[previous]!.trim()) drop.add(j); else break;
    }
    lines = texts.flatMap((line, i) => put.get(i) ?? (drop.has(i) ? [] : [line]));
  } else {
    lines = [...texts];
    while (lines.length && !lines.at(-1)!.trim()) lines.pop();
    lines.push(...(lines.length ? [''] : []), ...codexBlock(t));
  }
  while (lines.length > 1 && !lines.at(-1)!.trim() && !lines.at(-2)!.trim()) lines.pop();
  const out = lines.join(layout.eol).replace(new RegExp(`(?:${layout.eol})*$`), '') + layout.eol, result = out.trim() ? out : '';
  // The edit is read back before it is written: the new file must show exactly the intended entry.
  if (codexState(t, wanted, tomlLayout(result)) !== (wanted ? 'installed' : 'absent')) throw new Error(`${t.file}: Continuity could not update its entry safely. Nothing was changed.`);
  const backup = writeFileAtomically(t.file, (layout.bom ? String.fromCharCode(BOM) : '') + result, exists, { rolling: true });
  return { changed: true, state: mcpState(t, wanted), ...(backup ? { backup } : {}) };
}
