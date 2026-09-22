import { closeSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const maxBytes = 65536;
const pattern = z.string().min(1).max(256).refine(value => {
  if (value !== value.trim() || !/^[\p{L}\p{M}\p{N}_ .@()+*?/-]+$/u.test(value) || value.startsWith('/')) return false;
  const parts = value.replace(/\/$/, '').split('/');
  return parts.every(part => part && part !== '.' && part !== '..' && (!part.includes('**') || part === '**'));
}, 'Use project-relative patterns with /, * and ?; no traversal or absolute paths.');
export const sourceScopeSchema = z.object({ include: z.array(pattern).min(1).max(64).optional(), exclude: z.array(pattern).min(1).max(64).optional() }).strict()
  .refine(value => value.include || value.exclude, 'Specify include or exclude patterns.');
export type SourceScope = z.infer<typeof sourceScopeSchema>;
const projectId = z.string().regex(/^prj_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const schema = z.object({ version: z.literal(1), projects: z.record(projectId, sourceScopeSchema).refine(value => Object.keys(value).length <= 128) }).strict();
export class SourceScopeError extends Error {
  constructor(message = 'Invalid sources.json. Source indexing is blocked; correct the local source-scope configuration.') { super(message); this.name = 'SourceScopeError'; }
}
export function readSourceScopes(home: string): z.infer<typeof schema> {
  const path = join(home, 'sources.json');
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > maxBytes) throw new SourceScopeError();
    const fd = openSync(path, 'r');
    try {
      const current = fstatSync(fd);
      if (!current.isFile() || current.nlink !== 1 || current.ino !== info.ino || current.dev !== info.dev || current.size > maxBytes) throw new SourceScopeError();
      const buffer = Buffer.alloc(maxBytes + 1);
      const length = readSync(fd, buffer, 0, buffer.length, 0);
      if (length > maxBytes) throw new SourceScopeError();
      return schema.parse(JSON.parse(buffer.subarray(0, length).toString('utf8')));
    } finally { closeSync(fd); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, projects: {} };
    throw new SourceScopeError();
  }
}
export function writeSourceScope(home: string, id: string, input: unknown | undefined) {
  projectId.parse(id);
  const filter = input === undefined ? undefined : sourceScopeSchema.parse(input);
  const path = join(home, 'sources.json'), lock = path + '.lock', temporary = path + '.' + randomUUID() + '.tmp';
  let fd: number;
  let created = false;
  try { fd = openSync(lock, 'wx', 0o600); }
  catch { throw new SourceScopeError('Source-scope configuration is locked or not writable. No changes were applied.'); }
  try {
    const config = readSourceScopes(home);
    if (filter) config.projects[id] = filter; else delete config.projects[id];
    schema.parse(config);
    const data = JSON.stringify(config, null, 2) + '\n';
    if (Buffer.byteLength(data) > maxBytes) throw new SourceScopeError('sources.json exceeds 64 KiB. No changes were applied.');
    const output = openSync(temporary, 'wx', 0o600);
    created = true;
    try { writeFileSync(output, data); fsyncSync(output); } finally { closeSync(output); }
    renameSync(temporary, path);
    created = false;
  } finally {
    try { if (created) unlinkSync(temporary); }
    finally { closeSync(fd); unlinkSync(lock); }
  }
}
// Local patterns are rooted at the project. Existing host selections retain their semantics.
export function anchoredScope(scope: SourceScope | undefined) {
  return scope ? { ...(scope.include ? { include: scope.include.map(p => '/' + p) } : {}), ...(scope.exclude ? { exclude: scope.exclude.map(p => '/' + p) } : {}) } : {};
}
