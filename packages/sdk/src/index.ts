import { homedir } from 'node:os';
import { join } from 'node:path';
import { ProjectClient, ProjectResolver } from '../../core/src/index.js';
import { SqliteStorage } from '../../storage-sqlite/src/index.js';
import { FileSources } from '../../source-files/src/index.js';
import { reviewMemory } from '../../core/src/memory/review.js';
import { accessSync, realpathSync, statSync } from 'node:fs';
import { retrievalConfig } from './retrieval-config.js';
import { OllamaRetrieval } from '../../retrieval-semantic/src/ollama.js';
import { OpenVikingRetrieval } from '../../retrieval-semantic/src/openviking.js';
import { randomUUID } from 'node:crypto';
import { verifyWorkspace } from './workspaces.js';

export const CONTINUITY_HOST_API_VERSION = 1;
export interface HostOptions { sources?: { include?: readonly string[]; exclude?: readonly string[] } }

/** Trusted composition root for local hosts. Do not pass this host into agent tools. */
export function openContinuity(home = process.env.CONTINUITY_HOME ?? join(homedir(), '.continuity'), options: HostOptions = {}) {
  const config = retrievalConfig(home);
  const storage = new SqliteStorage(join(home, 'continuity.db'));
  const resolver = new ProjectResolver(storage);
  const source = new FileSources(() => storage.projects().flatMap(p => [p.root, ...storage.workspaces(p.project_id).map(w => w.root)]), options.sources);
  const workspaceStores = new Map<string, SqliteStorage>();
  const semanticFor = (bound: SqliteStorage, projectId: string) => {
    const s = config.semantic;
    return !s?.enabled ? undefined : s.provider === 'openviking'
      ? new OpenVikingRetrieval(bound.remoteResourceCache(projectId), s.endpoint ?? 'http://127.0.0.1:1933', s.revision ?? '')
      : new OllamaRetrieval(bound.embeddingCache(projectId), s.endpoint, s.model, s.document_prefix, s.query_prefix);
  };
  return {
    init: (path: string, name?: string) => resolver.init(path, name),
    rebind: (id: string, from: string, to: string) => resolver.rebind(id, from, to),
    review: (path: string, id: string, decision: 'accepted' | 'rejected', by: string) => reviewMemory(storage, resolver.resolve(path).project_id, id, decision, by),
    retention: (path: string) => ({ dry_run: true, classes: storage.retention(resolver.resolve(path).project_id, new Date().toISOString()) }),
    projects: () => storage.projects(),
    workspace: (projectPath: string, workspacePath: string) => {
      const project = resolver.resolve(projectPath);
      const root = verifyWorkspace(project.root, workspacePath);
      if (root === project.root) throw new Error('Use project() for the primary workspace.');
      const workspace = storage.registerWorkspace({ workspace_id: `ws_${randomUUID()}`, project_id: project.project_id, root });
      let bound = workspaceStores.get(workspace.workspace_id);
      if (!bound) { bound = new SqliteStorage(join(home, 'continuity.db'), workspace.workspace_id); workspaceStores.set(workspace.workspace_id, bound); }
      const semantic = semanticFor(bound, project.project_id);
      const workspaceSource = { scan: () => { verifyWorkspace(project.root, root); return source.scan({ ...project, root }); } };
      return new ProjectClient(bound, workspaceSource, project, undefined, semantic, semantic ? config.mode : 'lexical', workspace);
    },
    project: (path: string) => {
      const project = resolver.resolve(path);
      const semantic = semanticFor(storage, project.project_id);
      return new ProjectClient(storage, source, project, undefined, semantic, semantic ? config.mode : 'lexical');
    },
    doctor: () => {
      const health = storage.diagnose();
      const roots: { project_id: string; accessible: boolean }[] = [];
      if (!health.problems.includes('corrupted project identity')) {
        for (const p of storage.projects()) {
          try {
            accessSync(p.root);
            const canonical = realpathSync.native(p.root);
            if (!statSync(p.root).isDirectory() || (process.platform === 'win32' ? canonical.toLowerCase() : canonical) !== p.root) throw new Error('Root binding changed');
            roots.push({ project_id: p.project_id, accessible: true });
          }
          catch { roots.push({ project_id: p.project_id, accessible: false }); health.problems.push(`inaccessible/stale registration: ${p.project_id}`); }
        }
      }
      const major = Number(process.versions.node.split('.')[0]);
      const minor = Number(process.versions.node.split('.')[1]);
      if (major < 24 || (major === 24 && minor < 13)) health.problems.push('unsupported Node runtime: use Node 24.13 or later');
      const adapters = { generic: true, 'http-loopback': true, 'mcp-stdio': false };
      try { import.meta.resolve('@modelcontextprotocol/sdk/server/mcp.js'); adapters['mcp-stdio'] = true; }
      catch { health.problems.push('MCP SDK unavailable'); }
      return { ...health, version: '0.1.0', node: process.versions.node, roots, adapters, runtime_note: 'node:sqlite is pre-stable in Node 24; warnings depend on the installed patch version.' };
    },
    close: () => { for (const bound of workspaceStores.values()) bound.close(); storage.close(); },
  };
}
