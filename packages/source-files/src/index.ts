import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, relative, sep } from 'node:path';
import ignore from 'ignore';
import type { Ignore } from 'ignore';
import type { Project, Resource, SourcePort } from '../../core/src/contracts.js';
import { looksSensitive } from '../../core/src/security/sensitive.js';

const deniedName = /^(?:\.env(?:\..*)?|credentials.*|secrets.*|\.git|\.continuity|node_modules|dist|build|coverage|vendor|\.ssh|\.aws|\.venv|venv|\.next|\.cache)$|\.(?:pem|key|p12|pfx|db|sqlite|log)$/i;
const allowedExtensions = new Set(['.md', '.mdx', '.txt', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rs', '.go', '.java', '.cs', '.c', '.h', '.cpp', '.toml', '.yaml', '.yml', '.json', '.sql', '.sh']);
export { looksSensitive };
export function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}
// Conservative root prefixes for gitignore-style include patterns. Unanchored
// basename patterns can match at any depth and therefore cannot prune traversal.
function includePrefixes(patterns: readonly string[]): string[] | undefined {
  const prefixes: string[] = [];
  for (const raw of patterns) {
    if (!raw || raw.startsWith('#') || raw.startsWith('!')) continue;
    if (!/^[\p{L}\p{M}\p{N}_./*? ()@+-]+$/u.test(raw)) return undefined;
    const pattern = raw.replace(/^\//, '');
    const components = pattern.replace(/\/$/, '').split('/');
    if (components.length === 1 && !raw.startsWith('/')) return undefined;
    if (components.some(part => !part || part === '.' || part === '..')) return undefined;
    const wildcard = components.findIndex(part => /[*?]/.test(part));
    const parents = wildcard >= 0 ? components.slice(0, wildcard) : components;
    if (wildcard === 0) return undefined;
    if (parents.length) prefixes.push(parents.join('/').toLowerCase());
  }
  return prefixes;
}

interface IgnoreLayer { base: string; rules: Ignore }
export interface SourceSelection { include?: readonly string[]; exclude?: readonly string[] }
class SourceLimitError extends Error {
  constructor(message: string, readonly files: number, readonly bytes: number, readonly oversized: number) { super(message); }
}

export class FileSources implements SourcePort {
  constructor(private readonly registeredRoots: () => readonly string[] = () => [], private readonly selection: SourceSelection | (() => readonly SourceSelection[]) = {}) {}
  scan(project: Project): Resource[] { return this.collect(project).resources; }
  /** Directories and event filters from the same traversal and resolved selection as scan. */
  watchPlan(project: Project) { return this.collect(project, true).directories; }
  preview(project: Project) {
    try {
      const result = this.collect(project);
      return { files: result.resources.length, bytes: result.bytes, skipped_oversized: result.oversized, limit_exceeded: false, complete: true };
    } catch (error) {
      if (!(error instanceof SourceLimitError)) throw error;
      return { files: error.files, bytes: error.bytes, skipped_oversized: error.oversized, limit_exceeded: true, complete: false, reason: error.message };
    }
  }
  private collect(project: Project, metadataOnly = false) {
    const selections = typeof this.selection === 'function' ? this.selection() : [this.selection];
    const root = realpathSync.native(project.root);
    const identityRoot = process.platform === 'win32' ? root.toLowerCase() : root;
    if (identityRoot !== project.root) throw new Error('Project root changed its canonical location. Re-register the intended directory.');
    const output: Resource[] = [];
    const directories: { path: string; accepts: (name: string) => boolean }[] = [];
    let bytes = 0;
    let visited = 0;
    let oversized = 0;
    const nestedRoots = this.registeredRoots().filter(p => p !== project.root);
    const filters = selections.map(selection => ({
      excluded: ignore().add([...(selection.exclude ?? [])]),
      included: selection.include ? ignore().add([...selection.include]) : undefined,
      prefixes: selection.include ? includePrefixes(selection.include) : undefined,
    }));
    // Scan traversal and watch event acceptance share these checks and the resolved filters above.
    const excluded = (layers: IgnoreLayer[], path: string, local: string, directory: boolean) => {
      const suffix = directory ? '/' : '';
      return filters.some(f => f.excluded.ignores(local + suffix)) || layers.some(layer => layer.rules.ignores(relative(layer.base, path).split(sep).join('/') + suffix));
    };
    const outsidePrefixes = (local: string) => {
      const selectedPath = local.toLowerCase();
      return filters.some(({ prefixes }) => prefixes && !prefixes.some(prefix => selectedPath === prefix || selectedPath.startsWith(prefix + '/') || prefix.startsWith(selectedPath + '/')));
    };
    const eligibleFile = (name: string, local: string) => (allowedExtensions.has(extname(name).toLowerCase()) || /^(README|AGENTS|LICENSE)$/i.test(name))
      && !filters.some(f => f.included && !f.included.ignores(local));
    const walk = (directory: string, inherited: IgnoreLayer[]) => {
      const layers = [...inherited];
      const ignorePath = join(directory, '.gitignore');
      if (existsSync(ignorePath) && !lstatSync(ignorePath).isSymbolicLink()) {
        if (statSync(ignorePath).size > 65536) throw new Error('Oversized .gitignore; sync aborted.');
        layers.push({ base: directory, rules: ignore().add(readFileSync(ignorePath, 'utf8')) });
      }
      if (metadataOnly) directories.push({ path: directory, accepts: name => {
        if (name === '.gitignore') return true;
        if (name.includes('/') || name.includes('\\') || deniedName.test(name)) return false;
        const candidate = join(directory, name), local = relative(root, candidate).split(sep).join('/');
        const info = existsSync(candidate) ? lstatSync(candidate) : undefined;
        if (info?.isSymbolicLink() || excluded(layers, candidate, local, Boolean(info?.isDirectory()))) return false;
        if (info?.isDirectory()) return !outsidePrefixes(local);
        return eligibleFile(name, local);
      } });
      for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (++visited > 20000) throw new SourceLimitError('Source traversal exceeds 20,000 entries; narrow the source scope.', output.length, bytes, oversized);
        if (deniedName.test(entry.name) || entry.isSymbolicLink()) continue;
        const path = join(directory, entry.name);
        const relativePath = relative(root, path).split(sep).join('/');
        if (excluded(layers, path, relativePath, entry.isDirectory())) continue;
        const canonical = realpathSync.native(path);
        if (!isWithin(root, canonical) || canonical !== path) continue;
        if (entry.isDirectory()) {
          if (outsidePrefixes(relativePath)) continue;
          const normalized = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
          if (nestedRoots.includes(normalized) || existsSync(join(path, '.git'))) continue;
          walk(path, layers); continue;
        }
        if (!entry.isFile() || !eligibleFile(entry.name, relativePath)) continue;
        if (metadataOnly) continue;
        const info = statSync(path);
        if (info.nlink > 1) continue;
        if (info.size > 65536) { oversized++; continue; }
        const content = readFileSync(path, 'utf8');
        const afterRead = statSync(path);
        if (afterRead.size !== info.size || afterRead.mtimeMs !== info.mtimeMs || realpathSync.native(path) !== canonical) throw new Error('Source changed while being read; retry sync.');
        if (content.includes('\0') || looksSensitive(content)) continue;
        bytes += Buffer.byteLength(content);
        if (bytes > 8 * 1024 * 1024 || output.length >= 2000) throw new SourceLimitError('Index limit exceeded (2,000 files / 8 MiB). Narrow the source scope.', output.length + 1, bytes, oversized);
        const hash = createHash('sha256').update(content).digest('hex');
        const localPath = relative(root, path).split(sep).join('/');
        output.push({ id: `src_${randomUUID()}`, project_id: project.project_id, path: localPath, hash, content,
          kind: entry.name === 'AGENTS.md' ? 'rule' : 'source', state: 'fresh',
          provenance: { project_id: project.project_id, origin: localPath, captured_at: new Date().toISOString(), source_version: hash, trust: 'authoritative' } });
      }
    };
    walk(root, []);
    return { resources: output, directories, bytes, oversized };
  }
}
