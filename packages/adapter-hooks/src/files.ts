import { closeSync, copyFileSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Same-directory temporary file, flush, backup of the previous file, then atomic rename. A symlinked file stays a
 * symlink: its target is written. Returns the backup path when a previous file existed.
 */
export function writeFileAtomically(requested: string, text: string, existed: boolean) {
  let path = requested, link = false;
  try { link = lstatSync(requested).isSymbolicLink(); } catch { /* absent */ }
  if (link) {
    try { path = realpathSync.native(requested); } catch { throw new Error('Provider settings path is a dangling symbolic link. Nothing was changed.'); }
  }
  mkdirSync(dirname(path), { recursive: true });
  const backup = existed ? `${path}.continuity-backup-${new Date().toISOString().replace(/[:.]/g, '-')}` : undefined;
  if (backup) copyFileSync(path, backup);
  const temporary = `${path}.${randomUUID()}.tmp`, fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(temporary, path); } catch (error) { try { unlinkSync(temporary); } catch { /* keep original error */ } throw error; }
  return backup;
}
