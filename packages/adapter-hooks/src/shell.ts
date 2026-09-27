import { existsSync, readdirSync, statSync } from 'node:fs';
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

const key = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
/**
 * Where the provider reports nothing: indexed files of `root` modified since `since`, and new files in their
 * directories. Bounded by the index (the source scope): a file the index never saw, outside those directories, is not
 * noticed, and a deletion is not counted (the index may simply be older). Returns absolute paths.
 */
export function observedChanges(root: string, indexed: readonly string[], since: number): string[] {
  const changed = new Set<string>(), known = new Set<string>(), dirs = new Set<string>();
  for (const rel of indexed) {
    const file = resolve(root, rel);
    known.add(key(file)); dirs.add(dirname(file));
    try { if (statSync(file).mtimeMs >= since) changed.add(file); } catch { /* gone or unreadable */ }
  }
  for (const dir of dirs) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const file = join(dir, entry.name);
      if (known.has(key(file))) continue;
      try { const stat = statSync(file); if (Math.max(stat.birthtimeMs, stat.mtimeMs) >= since) changed.add(file); } catch { /* gone */ }
    }
  }
  return [...changed];
}
