import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Shell-made edits (#34). Claude Code's Bash tool reports what a command changed in `tool_response.bashEditDiff`: a
 * before/after comparison of the Git working tree over the command. It needs Git, and it also lists files that someone
 * else changed while the command ran. Claude Code's PowerShell tool reports nothing. Continuity reads only the changed
 * paths and the command's duration, never the command, its output or file contents.
 *
 * Node built-ins only: the CLI entry uses this module before anything else loads.
 */
export const SHELL_TOOLS: ReadonlySet<string> = new Set(['Bash', 'PowerShell']);
/** Paths taken from one report. */
export const MAX_CHANGED = 50;
/** Added before the command's start, for clock skew and the hook's own delay. */
export const WINDOW_MARGIN_MS = 1500;
/** The window assumed when the provider gives no duration. */
export const DEFAULT_WINDOW_MS = 60_000;

/** Whether `dir` lies in a Git working tree: a `.git` directory or file in it or an ancestor. No Git process runs. */
export function insideGit(dir: string): boolean {
  for (let current = resolve(dir); ; current = dirname(current)) {
    if (existsSync(join(current, '.git'))) return true;
    if (dirname(current) === current) return false;
  }
}
