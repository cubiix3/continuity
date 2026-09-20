import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, relative, sep } from 'node:path';
import ignore from 'ignore';
import type { Ignore } from 'ignore';
import type { Project, Resource, SourcePort } from '../../core/src/contracts.js';

const deniedName = /^(?:\.env(?:\..*)?|credentials.*|secrets.*|\.git|\.continuity|node_modules|dist|build|coverage|vendor|\.ssh|\.aws|\.venv|venv|\.next|\.cache)$|\.(?:pem|key|p12|pfx|db|sqlite|log)$/i;
const allowedExtensions = new Set(['.md', '.mdx', '.txt', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rs', '.go', '.java', '.cs', '.c', '.h', '.cpp', '.toml', '.yaml', '.yml', '.json', '.sql', '.sh']);
export function looksSensitive(text: string): boolean {
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})|(?:password|secret|api[_-]?key|access[_-]?token)\s*[=:]\s*["']?[^\s"']{8,}/i.test(text);
}
export function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}
interface IgnoreLayer { base: string; rules: Ignore }

export class FileSources implements SourcePort {
  constructor(private readonly registeredRoots: () => readonly string[] = () => [], private readonly selection: { include?: readonly string[]; exclude?: readonly string[] } = {}) {}
  scan(project: Project): Resource[] {
    const root = realpathSync.native(project.root);
    const identityRoot = process.platform === 'win32' ? root.toLowerCase() : root;
    if (identityRoot !== project.root) throw new Error('Project root changed its canonical location. Re-register the intended directory.');
    const output: Resource[] = [];
    let bytes = 0;
    let visited = 0;
    const nestedRoots = this.registeredRoots().filter(p => p !== project.root);
    const excluded = ignore().add([...(this.selection.exclude ?? [])]);
    const included = this.selection.include ? ignore().add([...this.selection.include]) : undefined;
    const walk = (directory: string, inherited: IgnoreLayer[]) => {
      const layers = [...inherited];
      const ignorePath = join(directory, '.gitignore');
      if (existsSync(ignorePath) && !lstatSync(ignorePath).isSymbolicLink()) {
        if (statSync(ignorePath).size > 65536) throw new Error('Oversized .gitignore; sync aborted.');
        layers.push({ base: directory, rules: ignore().add(readFileSync(ignorePath, 'utf8')) });
      }
      for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (++visited > 20000) throw new Error('Source traversal exceeds 20,000 entries; narrow the project root.');
        if (deniedName.test(entry.name) || entry.isSymbolicLink()) continue;
        const path = join(directory, entry.name);
        const relativePath = relative(root, path).split(sep).join('/');
        if (excluded.ignores(relativePath + (entry.isDirectory() ? '/' : ''))) continue;
        if (layers.some(layer => layer.rules.ignores(relative(layer.base, path).split(sep).join('/') + (entry.isDirectory() ? '/' : '')))) continue;
        const canonical = realpathSync.native(path);
        if (!isWithin(root, canonical) || canonical !== path) continue;
        if (entry.isDirectory()) {
          const normalized = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
          if (nestedRoots.includes(normalized) || existsSync(join(path, '.git'))) continue;
          walk(path, layers); continue;
        }
        if (!entry.isFile() || (!allowedExtensions.has(extname(entry.name).toLowerCase()) && !/^(README|AGENTS|LICENSE)$/i.test(entry.name))) continue;
        if (included && !included.ignores(relativePath)) continue;
        const info = statSync(path);
        if (info.nlink > 1 || info.size > 65536) continue;
        const content = readFileSync(path, 'utf8');
        const afterRead = statSync(path);
        if (afterRead.size !== info.size || afterRead.mtimeMs !== info.mtimeMs || realpathSync.native(path) !== canonical) throw new Error('Source changed while being read; retry sync.');
        if (content.includes('\0') || looksSensitive(content)) continue;
        bytes += Buffer.byteLength(content);
        if (bytes > 8 * 1024 * 1024 || output.length >= 2000) throw new Error('Index limit exceeded (2,000 files / 8 MiB). Narrow the project or add ignore rules.');
        const hash = createHash('sha256').update(content).digest('hex');
        const localPath = relative(root, path).split(sep).join('/');
        output.push({ id: `src_${randomUUID()}`, project_id: project.project_id, path: localPath, hash, content,
          kind: entry.name === 'AGENTS.md' ? 'rule' : 'source', state: 'fresh',
          provenance: { project_id: project.project_id, origin: localPath, captured_at: new Date().toISOString(), source_version: hash, trust: 'authoritative' } });
      }
    };
    walk(root, []);
    return output;
  }
}
