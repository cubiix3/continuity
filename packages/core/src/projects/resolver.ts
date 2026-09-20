import { realpathSync, statSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Project, StoragePort } from '../contracts.js';

export function canonicalRoot(path: string): string {
  const root = realpathSync.native(path);
  if (!statSync(root).isDirectory()) throw new Error('Project root must be a directory.');
  return process.platform === 'win32' ? root.toLowerCase() : root;
}

export class ProjectResolver {
  constructor(private readonly storage: StoragePort) {}
  init(path: string, name?: string): Project {
    const root = canonicalRoot(path);
    const existing = this.storage.projects().find(p => p.root === root);
    if (existing) return existing;
    return this.storage.register({ project_id: `prj_${randomUUID()}`, name: name ?? basename(root), identity_version: 1, root });
  }
  resolve(path: string): Project {
    let current = canonicalRoot(path);
    const projects = this.storage.projects();
    for (;;) {
      const project = projects.find(p => p.root === current);
      if (project) return project;
      const parent = dirname(current);
      if (parent === current) throw new Error('No project registered here. Run continuity init in the project root.');
      current = parent;
    }
  }
}
