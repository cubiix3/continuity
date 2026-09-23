import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BootstrapBundle } from '../../core/src/index.js';
import { renderBootstrap } from '../../core/src/index.js';

/**
 * Thin provider hook adapters. They resolve nothing: the host bootstraps the hook's cwd, and this module only shapes
 * provider input/output and edits the user's provider hook file on an explicit install/remove.
 */
export type HookProviderName = 'claude' | 'codex';
const MATCHER = 'startup|resume|clear|compact';
const TIMEOUT_SECONDS = 15;
const MAX_STDIN = 64 * 1024;
const marker = (provider: HookProviderName) => ['integrate', provider, 'session-start'] as const;

/** Official SessionStart input (Claude Code and Codex) carries `cwd`; anything unusable stays silent. */
export function sessionStartCwd(stdin: string): string | undefined {
  if (!stdin || stdin.length > MAX_STDIN) return undefined;
  try {
    const input = JSON.parse(stdin) as { cwd?: unknown };
    return typeof input.cwd === 'string' && input.cwd.length > 0 && input.cwd.length < 4096 ? input.cwd : undefined;
  } catch { return undefined; }
}
/** Claude Code: hookSpecificOutput.additionalContext. Codex: plain stdout, which it adds as developer context. */
export function sessionStartOutput(provider: HookProviderName, bundle: BootstrapBundle, now = new Date()) {
  const text = renderBootstrap(bundle, now);
  return provider === 'claude' ? JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } }) : text;
}
export function sessionStartUnavailable(provider: HookProviderName, reason: string) {
  const text = `Continuity startup context is unavailable for this registered project (${reason.replace(/\s+/g, ' ').slice(0, 160)}). Run continuity doctor if project memory is needed.\n`;
  return provider === 'claude' ? JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } }) : text;
}

export type HookCommand = Record<string, unknown>;
export interface HookTarget { provider: HookProviderName; file: string; expected: HookCommand; executable: string; cli: string }
export interface HookIntegrationStatus {
  provider: HookProviderName; settings: string; state: 'installed' | 'missing' | 'stale' | 'invalid_config';
  installed: boolean; current: boolean; entries: number; executable_available: boolean; cli_available: boolean; expected: HookCommand; message: string;
}
const posixQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
/** PowerShell single-quoted literals: no `$`/backtick expansion; `&` invokes a quoted executable path. */
const powershellQuote = (value: string) => `'${value.replace(/'/g, "''")}'`;

/** Claude Code honors CLAUDE_CONFIG_DIR. Exec form (`args`) spawns directly: no Git Bash/PowerShell dependency. */
export function claudeHookTarget(executable: string, cli: string, home: string, env: NodeJS.ProcessEnv = process.env): HookTarget {
  return { provider: 'claude', executable, cli, file: join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json'),
    expected: { type: 'command', command: executable, args: [cli, '--home', home, ...marker('claude')], timeout: TIMEOUT_SECONDS } };
}
/** Codex honors CODEX_HOME and runs hook command strings through a shell (PowerShell on Windows). */
export function codexHookTarget(executable: string, cli: string, home: string, env: NodeJS.ProcessEnv = process.env): HookTarget {
  // Only the paths are quoted; the fixed marker words stay bare so the entry can be recognized for repair/removal.
  const line = (quote: (value: string) => string) => `${quote(executable)} ${quote(cli)} --home ${quote(home)} ${marker('codex').join(' ')}`;
  return { provider: 'codex', executable, cli, file: join(env.CODEX_HOME || join(homedir(), '.codex'), 'hooks.json'),
    expected: { type: 'command', command: line(posixQuote), commandWindows: `& ${line(powershellQuote)}`, timeout: TIMEOUT_SECONDS } };
}
function isContinuity(provider: HookProviderName, hook: HookCommand) {
  const tail = marker(provider).join(' ');
  if (Array.isArray(hook.args)) return hook.args.slice(-3).join(' ') === tail;
  return typeof hook.command === 'string' && hook.command.endsWith(tail);
}
const same = (hook: HookCommand, expected: HookCommand) => JSON.stringify(Object.keys(expected).sort().map(k => [k, hook[k]])) === JSON.stringify(Object.keys(expected).sort().map(k => [k, expected[k]])) && Object.keys(hook).length === Object.keys(expected).length;

type Settings = Record<string, unknown> & { hooks?: Record<string, unknown> };
type Group = { hooks?: unknown } & Record<string, unknown>;
function readSettings(path: string): { settings: Settings; exists: boolean } {
  if (!existsSync(path)) return { settings: {}, exists: false };
  const raw = readFileSync(path, 'utf8'), text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  if (!text.trim()) return { settings: {}, exists: true };
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Settings must be a JSON object.');
  const settings = parsed as Settings;
  if (settings.hooks !== undefined && (typeof settings.hooks !== 'object' || settings.hooks === null || Array.isArray(settings.hooks))) throw new Error('"hooks" must be an object.');
  if (settings.hooks?.SessionStart !== undefined && !Array.isArray(settings.hooks.SessionStart)) throw new Error('"hooks.SessionStart" must be an array.');
  return { settings, exists: true };
}
const groupsOf = (settings: Settings) => (settings.hooks?.SessionStart as Group[] | undefined) ?? [];
const ours = (provider: HookProviderName, settings: Settings) => groupsOf(settings).flatMap(g => Array.isArray(g?.hooks) ? (g.hooks as HookCommand[]).filter(h => h && typeof h === 'object' && isContinuity(provider, h)) : []);
/** Drops Continuity entries; a group is removed only if it became empty because of that. */
function withoutContinuity(provider: HookProviderName, settings: Settings): Group[] {
  return groupsOf(settings).flatMap(group => {
    if (!Array.isArray(group?.hooks)) return [group];
    const kept = (group.hooks as HookCommand[]).filter(h => !(h && typeof h === 'object' && isContinuity(provider, h)));
    return kept.length === (group.hooks as unknown[]).length ? [group] : kept.length ? [{ ...group, hooks: kept }] : [];
  });
}
/** Same-directory temporary file, flush, backup of the previous file, then atomic rename. */
function writeSettings(path: string, settings: Settings, existed: boolean) {
  mkdirSync(dirname(path), { recursive: true });
  const backup = existed ? `${path}.continuity-backup-${new Date().toISOString().replace(/[:.]/g, '-')}` : undefined;
  if (backup) copyFileSync(path, backup);
  const temporary = `${path}.${randomUUID()}.tmp`, fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(settings, null, 2) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(temporary, path); } catch (error) { try { unlinkSync(temporary); } catch { /* keep original error */ } throw error; }
  return backup;
}

export function hookIntegrationStatus(target: HookTarget): HookIntegrationStatus {
  const base = { provider: target.provider, settings: target.file, expected: target.expected, executable_available: existsSync(target.executable), cli_available: existsSync(target.cli) };
  let settings: Settings;
  try { settings = readSettings(target.file).settings; }
  catch (error) { return { ...base, state: 'invalid_config', installed: false, current: false, entries: 0, message: `Hook settings could not be read (${error instanceof Error ? error.message : 'invalid JSON'}). Nothing was changed.` }; }
  const hooks = ours(target.provider, settings), current = hooks.length === 1 && same(hooks[0]!, target.expected);
  const state = !hooks.length ? 'missing' : current && base.executable_available && base.cli_available ? 'installed' : 'stale';
  return { ...base, state, installed: hooks.length > 0, current, entries: hooks.length,
    message: state === 'installed' ? `${target.provider === 'claude' ? 'Claude Code' : 'Codex'} sessions in registered projects receive Continuity startup context${target.provider === 'codex' ? ' once the hook is trusted in Codex (/hooks)' : ''}.`
      : state === 'missing' ? `Not installed. Run continuity integrate ${target.provider} install.`
      : `The installed hook points to another Continuity command or home, is duplicated, or its executable is missing. Run continuity integrate ${target.provider} install to repair.` };
}
/** Additive and idempotent: only Continuity's own SessionStart entry is added or replaced; everything else is kept. */
export function installHookIntegration(target: HookTarget) {
  const { settings, exists } = readSettings(target.file);
  const status = hookIntegrationStatus(target);
  if (status.state === 'installed') return { ...status, changed: false };
  const groups = withoutContinuity(target.provider, settings);
  groups.push({ matcher: MATCHER, hooks: [target.expected] });
  const backup = writeSettings(target.file, { ...settings, hooks: { ...(settings.hooks ?? {}), SessionStart: groups } }, exists);
  return { ...hookIntegrationStatus(target), changed: true, ...(backup ? { backup } : {}) };
}
/** Removes only Continuity's entries; unrelated hooks, groups and settings are preserved. */
export function removeHookIntegration(target: HookTarget) {
  const { settings, exists } = readSettings(target.file);
  if (!exists || !ours(target.provider, settings).length) return { ...hookIntegrationStatus(target), changed: false };
  const groups = withoutContinuity(target.provider, settings), hooks: Record<string, unknown> = { ...(settings.hooks ?? {}) };
  if (groups.length) hooks.SessionStart = groups; else delete hooks.SessionStart;
  const backup = writeSettings(target.file, { ...settings, hooks }, true);
  return { ...hookIntegrationStatus(target), changed: true, backup };
}
