import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BootstrapBundle } from '../../core/src/index.js';
import { renderBootstrap } from '../../core/src/index.js';
import { assertWritable, writeFileAtomically } from './files.js';
import { claudeMcpTarget, codexMcpTarget, mcpConfigRefusal, mcpState, writeMcpEntry } from './mcp.js';
import type { McpEntryState, McpTarget } from './mcp.js';

export * from './autosave.js';
export * from './mcp.js';
export { assertWritable } from './files.js';

/**
 * Thin provider hook adapters. They resolve nothing: the host binds the hook's cwd, and this module only shapes
 * provider input/output and edits the user's provider hook file on an explicit install/remove.
 */
export type HookProviderName = 'claude' | 'codex';
export type HookEvent = 'SessionStart' | 'PostToolUse' | 'Stop';
/** Every event Continuity may own; status, repair and removal always consider all of them. */
const EVENTS: readonly HookEvent[] = ['SessionStart', 'PostToolUse', 'Stop'];
const SUBCOMMAND: Record<HookEvent, string> = { SessionStart: 'session-start', PostToolUse: 'tool-use', Stop: 'stop' };
const TIMEOUT_SECONDS: Record<HookEvent, number> = { SessionStart: 15, PostToolUse: 10, Stop: 60 };
/** Stop has no matcher. PostToolUse marks a session as edited: Claude's edit tools; Codex reports edits as apply_patch. */
const MATCHERS: Record<HookProviderName, Partial<Record<HookEvent, string>>> = {
  claude: { SessionStart: 'startup|resume|clear|compact', PostToolUse: 'Edit|Write|MultiEdit|NotebookEdit' },
  codex: { SessionStart: 'startup|resume|clear|compact', PostToolUse: 'apply_patch' },
};
const MAX_STDIN = 64 * 1024;
const marker = (provider: HookProviderName, event: HookEvent) => ['integrate', provider, SUBCOMMAND[event]] as const;

/** Official SessionStart input (Claude Code and Codex) carries `cwd`; anything unusable stays silent. */
export function sessionStartCwd(stdin: string): string | undefined {
  if (!stdin || stdin.length > MAX_STDIN) return undefined;
  try {
    const input = JSON.parse(stdin) as { cwd?: unknown };
    return typeof input.cwd === 'string' && input.cwd.length > 0 && input.cwd.length < 4096 ? input.cwd : undefined;
  } catch { return undefined; }
}
/**
 * Claude Code: hookSpecificOutput.additionalContext. Codex: plain stdout, which it adds as developer context. `detail`:
 * this integration's MCP detail tool is installed for the session, so the index may say how to fetch more.
 */
export function sessionStartOutput(provider: HookProviderName, bundle: BootstrapBundle, now = new Date(), detail = false) {
  const text = renderBootstrap(bundle, now, detail ? { tools: ['continuity_context'] } : {});
  return provider === 'claude' ? JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } }) : text;
}
export function sessionStartUnavailable(provider: HookProviderName, reason: string) {
  const text = `Continuity startup context is unavailable for this registered project (${reason.replace(/\s+/g, ' ').slice(0, 160)}). Run continuity doctor if project memory is needed.\n`;
  return provider === 'claude' ? JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } }) : text;
}

export type HookCommand = Record<string, unknown>;
export interface HookEntry { event: HookEvent; matcher?: string; hook: HookCommand }
/**
 * `expected` is the SessionStart hook; `entries` are all hooks this install owns (without autosave: SessionStart only).
 * `mcp` is the provider MCP entry for the detail tools; `detail` says whether this install wants it.
 */
export interface HookTarget { provider: HookProviderName; file: string; expected: HookCommand; entries: HookEntry[]; autosave: boolean; detail: boolean; mcp: McpTarget; executable: string; cli: string }
/** Per event: current, missing, stale (outdated or duplicated), unexpected (present but not wanted), absent (neither). */
export type HookEventState = 'installed' | 'missing' | 'stale' | 'unexpected' | 'absent';
export interface HookIntegrationStatus {
  provider: HookProviderName; settings: string; state: 'installed' | 'partial' | 'missing' | 'stale' | 'invalid_config';
  installed: boolean; current: boolean; autosave: boolean; entries: number; events: Partial<Record<HookEvent, HookEventState>>;
  detail: boolean; mcp: McpEntryState; mcp_settings: string;
  executable_available: boolean; cli_available: boolean; expected: HookCommand; message: string;
}
export interface HookTargetOptions { autosave?: boolean; detail?: boolean }
const posixQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
/** PowerShell single-quoted literals: no `$`/backtick expansion; `&` invokes a quoted executable path. */
const POWERSHELL_QUOTES = new Set(["'", String.fromCharCode(0x2018), String.fromCharCode(0x2019), String.fromCharCode(0x201a), String.fromCharCode(0x201b)]);
const powershellQuote = (value: string) => `'${Array.from(value, c => POWERSHELL_QUOTES.has(c) ? c + c : c).join('')}'`;

function target(provider: HookProviderName, file: string, executable: string, cli: string, hook: (event: HookEvent) => HookCommand, mcp: McpTarget, options: HookTargetOptions): HookTarget {
  const autosave = options.autosave ?? true, detail = options.detail ?? true;
  const entries = (autosave ? EVENTS : ['SessionStart' as const]).map(event => ({ event, ...(MATCHERS[provider][event] ? { matcher: MATCHERS[provider][event] } : {}), hook: hook(event) }));
  return { provider, file, executable, cli, autosave, detail, mcp, entries, expected: entries[0]!.hook };
}
/** Claude Code honors CLAUDE_CONFIG_DIR. Exec form (`args`) spawns directly: no Git Bash/PowerShell dependency. */
export function claudeHookTarget(executable: string, cli: string, home: string, env: NodeJS.ProcessEnv = process.env, options: HookTargetOptions = {}): HookTarget {
  return target('claude', join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json'), executable, cli,
    event => ({ type: 'command', command: executable, args: ['--no-warnings', cli, '--home', home, ...marker('claude', event)], timeout: TIMEOUT_SECONDS[event] }), claudeMcpTarget(executable, cli, home, env), options);
}
/** Codex honors CODEX_HOME and runs hook command strings through a shell (PowerShell on Windows). */
export function codexHookTarget(executable: string, cli: string, home: string, env: NodeJS.ProcessEnv = process.env, options: HookTargetOptions = {}): HookTarget {
  // Only the paths are quoted; the fixed marker words stay bare so the entry can be recognized for repair/removal.
  const line = (event: HookEvent, quote: (value: string) => string) => `${quote(executable)} --no-warnings ${quote(cli)} --home ${quote(home)} ${marker('codex', event).join(' ')}`;
  return target('codex', join(env.CODEX_HOME || join(homedir(), '.codex'), 'hooks.json'), executable, cli,
    event => ({ type: 'command', command: line(event, posixQuote), commandWindows: `& ${line(event, powershellQuote)}`, timeout: TIMEOUT_SECONDS[event] }), codexMcpTarget(executable, cli, home, env), options);
}
const CLI_ENTRY = /[\\/]cli[\\/]src[\\/]index\.js'?$/;
function isContinuity(provider: HookProviderName, event: HookEvent, hook: HookCommand) {
  const tail = marker(provider, event).join(' ');
  if (Array.isArray(hook.args)) return hook.args.slice(-3).join(' ') === tail && hook.args.some(a => typeof a === 'string' && CLI_ENTRY.test(a));
  return typeof hook.command === 'string' && hook.command.endsWith(` ${tail}`) && hook.command.split(' --home ')[0]!.split(/\s+/).some(part => CLI_ENTRY.test(part));
}
const same = (hook: HookCommand, expected: HookCommand) => JSON.stringify(Object.keys(expected).sort().map(k => [k, hook[k]])) === JSON.stringify(Object.keys(expected).sort().map(k => [k, expected[k]])) && Object.keys(hook).length === Object.keys(expected).length;

type Settings = Record<string, unknown> & { hooks?: Record<string, unknown> };
type Group = { hooks?: unknown; matcher?: unknown } & Record<string, unknown>;
function readSettings(path: string): { settings: Settings; exists: boolean } {
  if (!existsSync(path)) return { settings: {}, exists: false };
  const raw = readFileSync(path, 'utf8'), text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  if (!text.trim()) return { settings: {}, exists: true };
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Settings must be a JSON object.');
  const settings = parsed as Settings;
  if (settings.hooks !== undefined && (typeof settings.hooks !== 'object' || settings.hooks === null || Array.isArray(settings.hooks))) throw new Error('"hooks" must be an object.');
  for (const event of EVENTS) if (settings.hooks?.[event] !== undefined && !Array.isArray(settings.hooks[event])) throw new Error(`"hooks.${event}" must be an array.`);
  return { settings, exists: true };
}
const groupsOf = (settings: Settings, event: HookEvent) => (settings.hooks?.[event] as Group[] | undefined) ?? [];
const oursIn = (provider: HookProviderName, settings: Settings, event: HookEvent) => groupsOf(settings, event).flatMap(g => Array.isArray(g?.hooks)
  ? (g.hooks as HookCommand[]).filter(h => h && typeof h === 'object' && isContinuity(provider, event, h)).map(hook => ({ hook, matcher: g.matcher })) : []);
/** Drops Continuity entries; a group is removed only if it became empty because of that. Foreign order is kept. */
function withoutContinuity(provider: HookProviderName, settings: Settings, event: HookEvent): Group[] {
  return groupsOf(settings, event).flatMap(group => {
    if (!Array.isArray(group?.hooks)) return [group];
    const kept = (group.hooks as HookCommand[]).filter(h => !(h && typeof h === 'object' && isContinuity(provider, event, h)));
    return kept.length === (group.hooks as unknown[]).length ? [group] : kept.length ? [{ ...group, hooks: kept }] : [];
  });
}
const writeSettings = (requested: string, settings: Settings, existed: boolean) => writeFileAtomically(requested, JSON.stringify(settings, null, 2) + '\n', existed);
function eventStates(target: HookTarget, settings: Settings) {
  const events: Partial<Record<HookEvent, HookEventState>> = {};
  let entries = 0;
  for (const event of EVENTS) {
    const found = oursIn(target.provider, settings, event), wanted = target.entries.find(e => e.event === event);
    entries += found.length;
    events[event] = !wanted ? (found.length ? 'unexpected' : 'absent')
      : !found.length ? 'missing'
      : found.length === 1 && same(found[0]!.hook, wanted.hook) && found[0]!.matcher === wanted.matcher ? 'installed' : 'stale';
  }
  return { events, entries };
}

export function hookIntegrationStatus(target: HookTarget): HookIntegrationStatus {
  const base = { provider: target.provider, settings: target.file, expected: target.expected, autosave: target.autosave, detail: target.detail, mcp: mcpState(target.mcp, target.detail), mcp_settings: target.mcp.file, executable_available: existsSync(target.executable), cli_available: existsSync(target.cli) };
  let settings: Settings;
  try { settings = readSettings(target.file).settings; }
  catch (error) { return { ...base, state: 'invalid_config', installed: false, current: false, entries: 0, events: {}, message: `Hook settings could not be read (${error instanceof Error ? error.message : 'invalid JSON'}). Nothing was changed.` }; }
  const { events, entries } = eventStates(target, settings), values = Object.values(events), mcp = base.mcp;
  const name = target.provider === 'claude' ? 'Claude Code' : 'Codex', trust = target.provider === 'codex' ? ' once the hooks are trusted in Codex (/hooks)' : '';
  // A foreign server named continuity is left alone: without the detail tools the integration is partial, not broken.
  const mcpCurrent = target.detail ? mcp === 'installed' : ['absent', 'foreign', 'invalid_config'].includes(mcp);
  const current = values.every(v => v === 'installed' || v === 'absent') && mcpCurrent;
  // An older install: startup context works; the autosave hooks or the detail tools were never added.
  const partial = events.SessionStart === 'installed' && values.every(v => v === 'installed' || v === 'absent' || v === 'missing') && ['installed', 'missing', 'disabled', 'foreign', 'absent', 'invalid_config'].includes(mcp);
  const exes = base.executable_available && base.cli_available;
  const state = !entries && !['installed', 'stale', 'disabled'].includes(mcp) ? 'missing' : current && exes ? 'installed' : partial && exes ? 'partial' : 'stale';
  const detailMessage = mcp === 'foreign' ? ` An MCP server named continuity in ${target.mcp.file} is not Continuity's; the project detail tools were not installed. Rename that server, or pass --no-mcp.`
    : mcp === 'disabled' ? ` The Continuity MCP server is turned off in ${target.mcp.file} (enabled = false); Continuity leaves it off and does not name its tools.`
    : mcp === 'invalid_config' && target.detail ? ` ${mcpConfigRefusal(target.mcp)} The project detail tools could not be checked or added; fix the file, or pass --no-mcp.`
    : target.detail && mcp === 'missing' ? ` The project detail tools are missing. Run continuity integrate ${target.provider} install to add them, or pass --no-mcp.` : '';
  return { ...base, state, installed: entries > 0 || ['installed', 'stale', 'disabled'].includes(mcp), current, entries, events,
    message: state === 'installed' ? `${name} sessions in registered projects receive Continuity startup context${target.detail ? ' and project detail tools' : ''}${!target.autosave ? '' : target.provider === 'claude' ? ', and, in interactive sessions, an automatic save after file edits' : ', and, in interactive sessions (the shared app-server, not codex exec or --no-daemon), an automatic save after file edits'}${trust}.`
      : state === 'missing' ? `Not installed. Run continuity integrate ${target.provider} install.${mcp === 'invalid_config' ? ` ${mcpConfigRefusal(target.mcp)} A Continuity MCP entry there could not be checked.` : ''}`
      : state === 'partial' ? `Startup context is installed.${values.includes('missing') ? ` The session autosave hooks are missing. Run continuity integrate ${target.provider} install to add them, or pass --no-autosave to keep startup context only.` : ''}${detailMessage}`
      : `An installed hook or MCP entry points to another Continuity command or home, is duplicated, or its executable is missing. Run continuity integrate ${target.provider} install${target.autosave ? '' : ' --no-autosave'}${target.detail ? '' : ' --no-mcp'} to repair.` };
}
/**
 * Additive and idempotent: only Continuity's own hook entries and its MCP entry are added, replaced or dropped;
 * everything else is kept. Both files are checked before either is written.
 */
export function installHookIntegration(target: HookTarget) {
  const { settings, exists } = readSettings(target.file);
  const status = hookIntegrationStatus(target);
  if (status.state === 'installed') return { ...status, changed: false };
  if (status.mcp === 'invalid_config' && target.detail) throw new Error(`${mcpConfigRefusal(target.mcp)} Nothing was changed. Fix the file, or run continuity integrate ${target.provider} install${target.autosave ? '' : ' --no-autosave'} --no-mcp to install the hooks without the project detail tools.`);
  const mcpWrite = target.detail ? ['missing', 'stale'].includes(status.mcp) : status.mcp === 'stale';
  // Both files are checked before either is written, so a refused MCP file never leaves hooks half-updated.
  if (mcpWrite) assertWritable(target.mcp.file);
  const backups: string[] = [];
  let changed = false;
  if (!Object.values(status.events).every(v => v === 'installed' || v === 'absent')) {
    const hooks: Record<string, unknown> = { ...(settings.hooks ?? {}) };
    for (const event of EVENTS) {
      const groups = withoutContinuity(target.provider, settings, event), wanted = target.entries.find(e => e.event === event);
      if (wanted) groups.push({ ...(wanted.matcher ? { matcher: wanted.matcher } : {}), hooks: [wanted.hook] });
      if (groups.length) hooks[event] = groups; else if (groupsOf(settings, event).length) delete hooks[event];
    }
    const backup = writeSettings(target.file, { ...settings, hooks }, exists);
    if (backup) backups.push(backup);
    changed = true;
  }
  if (mcpWrite) {
    const mcp = writeMcpEntry(target.mcp, target.detail);
    if (mcp.backup) backups.push(mcp.backup);
    changed ||= mcp.changed;
  }
  return { ...hookIntegrationStatus(target), changed, ...(backups.length ? { backup: backups[0], backups } : {}) };
}
/** Removes only Continuity's hook entries and its MCP entry; unrelated hooks, servers, groups and settings are preserved. */
export function removeHookIntegration(target: HookTarget) {
  const { settings, exists } = readSettings(target.file);
  const backups: string[] = [];
  if (exists && EVENTS.some(event => oursIn(target.provider, settings, event).length)) {
    const hooks: Record<string, unknown> = { ...(settings.hooks ?? {}) };
    for (const event of EVENTS) {
      if (!oursIn(target.provider, settings, event).length) continue;
      const groups = withoutContinuity(target.provider, settings, event);
      if (groups.length) hooks[event] = groups; else delete hooks[event];
    }
    const backup = writeSettings(target.file, { ...settings, hooks }, true);
    if (backup) backups.push(backup);
  }
  const left = mcpState(target.mcp, false);
  const mcp = left === 'stale' ? writeMcpEntry(target.mcp, false) : undefined;
  if (mcp?.backup) backups.push(mcp.backup);
  const result = { ...hookIntegrationStatus(target), changed: backups.length > 0 || !!mcp?.changed, ...(backups.length ? { backup: backups[0], backups } : {}) };
  // A file this editor does not change may still hold the entry: say so instead of reporting a clean removal.
  if (left !== 'invalid_config') return result;
  return { ...result, state: 'invalid_config' as const, message: `${backups.length ? 'The Continuity hooks were removed. ' : ''}${mcpConfigRefusal(target.mcp)} A Continuity MCP entry there, if any, is still in place; remove the ${target.provider === 'claude' ? 'mcpServers.continuity entry' : '[mcp_servers.continuity] table'} by hand.` };
}
