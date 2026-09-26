import { chmodSync, closeSync, copyFileSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/** The path a write lands on: a symlink's target. A dangling link is refused before anything is written. */
export function assertWritable(requested: string) {
  let link = false;
  try { link = lstatSync(requested).isSymbolicLink(); } catch { /* absent */ }
  if (!link) return requested;
  try { return realpathSync.native(requested); } catch { throw new Error('Provider settings path is a dangling symbolic link. Nothing was changed.'); }
}

/**
 * Same-directory temporary file, flush, backup of the previous file, then atomic rename. A symlinked file stays a
 * symlink: its target is written. Returns the backup path when a previous file existed. `rolling` keeps one private
 * backup per file (for large files that may hold other tools' tokens) instead of a new timestamped copy each time.
 */
export function writeFileAtomically(requested: string, text: string, existed: boolean, options: { rolling?: boolean } = {}) {
  const path = assertWritable(requested);
  mkdirSync(dirname(path), { recursive: true });
  const backup = existed ? `${path}.continuity-backup${options.rolling ? '' : `-${new Date().toISOString().replace(/[:.]/g, '-')}`}` : undefined;
  if (backup) { copyFileSync(path, backup); try { chmodSync(backup, 0o600); } catch { /* best effort */ } }
  const temporary = `${path}.${randomUUID()}.tmp`, fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(temporary, path); } catch (error) { try { unlinkSync(temporary); } catch { /* keep original error */ } throw error; }
  return backup;
}
