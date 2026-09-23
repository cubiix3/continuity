import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { ProjectClient, ProjectResolver, canonicalRoot } from '../../core/src/index.js';
import { SqliteStorage } from '../../storage-sqlite/src/index.js';
import { FileSources, isWithin } from '../../source-files/src/index.js';
import type { Project } from '../../core/src/contracts.js';
import { reviewMemory } from '../../core/src/memory/review.js';
import { accessSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { retrievalConfig } from './retrieval-config.js';
import { OllamaRetrieval } from '../../retrieval-semantic/src/ollama.js';
import { OpenVikingRetrieval } from '../../retrieval-semantic/src/openviking.js';
import { randomUUID } from 'node:crypto';
import { verifyWorkspace } from './workspaces.js';
import { Inspection } from '../../core/src/inspection.js';
import { passages } from '../../core/src/context/passages.js';
import { anchoredScope, readSourceScopes, sourceScopeSchema, writeSourceScope, SourceScopeError } from './source-scope.js';
import type { SourceScope } from './source-scope.js';

export const CONTINUITY_HOST_API_VERSION = 1;
const gitLink = (dir: string) => {
  const link = readFileSync(join(dir, '.git'), 'utf8').match(/^gitdir:\s*(.+?)\s*$/m)?.[1];
  if (!link) throw new Error('Not a Git link file.');
  return realpathSync.native(isAbsolute(link) ? link : join(dir, link));
};
const sameDir = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
/**
 * Cheap worktree check without spawning git: the worktree's common Git directory must be the project's. Handles
 * `.git` directories, `.git` link files (separate git dir, submodules) and relative links.
 */
function attachedWorktree(projectRoot: string, workspaceRoot: string) {
  try {
    const worktreeGit = gitLink(workspaceRoot);
    const common = realpathSync.native(join(worktreeGit, readFileSync(join(worktreeGit, 'commondir'), 'utf8').trim()));
    const projectGit = statSync(join(projectRoot, '.git')).isDirectory() ? realpathSync.native(join(projectRoot, '.git')) : gitLink(projectRoot);
    return sameDir(common, projectGit);
  } catch { return false; }
}
/** Bootstrap failed after the directory resolved to a registered project or workspace. */
export class BootstrapUnavailableError extends Error { constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = 'BootstrapUnavailableError'; } }
export interface HostOptions { sources?: { include?: readonly string[]; exclude?: readonly string[] } }

/** Trusted composition root for local hosts. Do not pass this host into agent tools. */
export function openContinuity(home = process.env.CONTINUITY_HOME ?? join(homedir(), '.continuity'), options: HostOptions = {}) {
  const config = retrievalConfig(home);
  const storage = new SqliteStorage(join(home, 'continuity.db'));
  const resolver = new ProjectResolver(storage);
  const sourceFor = (project: Project, root = project.root, preview?: SourceScope) => new FileSources(() => {
    const registered = storage.projects().flatMap(p => [p.root, ...storage.workspaces(p.project_id).map(w => w.root)]);
    const checkouts = [project.root, ...storage.workspaces(project.project_id).map(w => w.root)];
    // A nested project remains private in every checkout of its enclosing project.
    // Resolve on every scan so registration after client creation also takes effect.
    const mapped = checkouts.flatMap(checkout => registered
      .filter(candidate => candidate !== checkout && isWithin(checkout, candidate))
      .map(candidate => join(root, relative(checkout, candidate))));
    return [...registered, ...mapped];
  }, () => {
    const local = readSourceScopes(home).projects[project.project_id];
    return [options.sources ?? {}, anchoredScope(preview ?? local)];
  });
  const sourceScope = (id: string) => {
    inspection.scope(id, '');
    const scope = readSourceScopes(home).projects[id];
    return { project_id: id, filtered: Boolean(scope || options.sources?.include || options.sources?.exclude), include: scope?.include ?? [], exclude: scope?.exclude ?? [], host_include: options.sources?.include ?? [], host_exclude: options.sources?.exclude ?? [] };
  };
  const workspaceStores = new Map<string, SqliteStorage>();
  const inspection = new Inspection(storage);
  const boundStore = (workspaceId: string) => {
    if (!workspaceId) return storage;
    let bound = workspaceStores.get(workspaceId);
    if (!bound) { bound = new SqliteStorage(join(home, 'continuity.db'), workspaceId); workspaceStores.set(workspaceId, bound); }
    return bound;
  };
  const inspectionScope = (projectId: string, workspaceId: string) => {
    const scope = inspection.scope(projectId, workspaceId);
    if (resolver.resolve(scope.project.root).project_id !== projectId) throw new Error('Project binding changed.');
    if (scope.workspace) verifyWorkspace(scope.project.root, scope.workspace.root);
    return scope;
  };
  const scanForInspection = (projectId: string, workspaceId: string) => {
    const { project, workspace } = inspectionScope(projectId, workspaceId);
    const root = workspace?.root ?? project.root;
    const resources = sourceFor(project, root).scan({ ...project, root });
    const indexed = new Map(boundStore(workspaceId).resources(projectId).filter(r => r.state === 'fresh').map(r => [r.path, r]));
    for (const resource of resources) {
      if (resource.project_id !== projectId || resource.provenance.project_id !== projectId) throw new Error('Source boundary denied.');
      if (workspace) resource.provenance.workspace_id = workspace.workspace_id;
      const previous = indexed.get(resource.path);
      if (previous?.hash === resource.hash) resource.id = previous.id;
    }
    return resources;
  };
  const semanticFor = (bound: SqliteStorage, projectId: string) => {
    const s = config.semantic;
    return !s?.enabled ? undefined : s.provider === 'openviking'
      ? new OpenVikingRetrieval(bound.remoteResourceCache(projectId), s.endpoint ?? 'http://127.0.0.1:1933', s.revision ?? '')
      : new OllamaRetrieval(bound.embeddingCache(projectId), s.endpoint, s.model, s.document_prefix, s.query_prefix);
  };
  return {
    inspection,
    sourceScope,
    setSourceScope: (path: string, input: unknown) => {
      const project = resolver.resolve(path);
      writeSourceScope(home, project.project_id, sourceScopeSchema.parse(input));
      return sourceScope(project.project_id);
    },
    clearSourceScope: (path: string) => {
      const project = resolver.resolve(path);
      writeSourceScope(home, project.project_id, undefined);
      return sourceScope(project.project_id);
    },
    previewSourceScope: (path: string, input?: unknown) => {
      const project = resolver.resolve(path);
      const proposed = input === undefined ? undefined : sourceScopeSchema.parse(input);
      return { project_id: project.project_id, ...sourceFor(project, project.root, proposed).preview(project) };
    },
    /** Human host inspection only. Never handed to an agent adapter; never changes the index. */
    previewSource: (projectId: string, workspaceId: string, id: string) => {
      const registered = inspection.page(projectId, workspaceId, 'sources', 1, 0, id).items[0]?.record;
      if (!registered || !('path' in registered) || !('hash' in registered)) return undefined;
      const resource = scanForInspection(projectId, workspaceId).find(r => r.path === registered.path);
      if (!resource) return undefined;
      if (resource.hash === registered.hash) resource.id = registered.id;
      return { resource, indexed_hash: registered.hash, changed_since_sync: resource.hash !== registered.hash };
    },
    /** Uses the existing backend health port against a fresh read-only authorized snapshot. */
    inspectionRetrievalHealth: async (projectId: string, workspaceId: string) => {
      inspectionScope(projectId, workspaceId);
      sourceScope(projectId);
      const semantic = semanticFor(boundStore(workspaceId), projectId);
      if (!semantic) return { status: 'disabled', reason: 'FTS5 active; semantic retrieval is disabled.' };
      try {
        const snapshot = { project_id: projectId, passages: passages(scanForInspection(projectId, workspaceId)) };
        const health = await semantic.health(snapshot, AbortSignal.timeout(3000));
        inspectionScope(projectId, workspaceId);
        return health;
      } catch { return { status: 'unavailable', reason: 'Semantic health could not be verified. FTS remains available; run doctor for local diagnostics.' }; }
    },
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
      const bound = boundStore(workspace.workspace_id);
      const semantic = semanticFor(bound, project.project_id);
      const source = sourceFor(project, root);
      const workspaceSource = { scan: () => { verifyWorkspace(project.root, root); return source.scan({ ...project, root }); } };
      return new ProjectClient(bound, workspaceSource, project, undefined, semantic, semantic ? config.mode : 'lexical', workspace);
    },
    /**
     * Read-only agent startup index for the directory an agent runs in. Resolves the nearest registered project or
     * workspace root without registering, syncing, or running git. Returns undefined for an unregistered directory.
     */
    bootstrap: (path: string, options: { budget?: number } = {}) => {
      let current = canonicalRoot(path);
      const projects = storage.projects(), workspaceRoots = new Map(projects.flatMap(p => storage.workspaces(p.project_id).map(w => [w.root, { project: p, workspace: w }] as const)));
      for (;;) {
        const candidate = projects.find(p => p.root === current) ? { project: projects.find(p => p.root === current)! } : workspaceRoots.get(current);
        // A removed worktree's path can be reused by an unrelated checkout: no context rather than a wrong one.
        if (candidate && 'workspace' in candidate && !attachedWorktree(candidate.project.root, candidate.workspace.root)) return undefined;
        const scope = candidate;
        if (scope) {
          const store = boundStore('workspace' in scope ? scope.workspace.workspace_id : '');
          const client = new ProjectClient(store, sourceFor(scope.project), scope.project, undefined, undefined, 'lexical', 'workspace' in scope ? scope.workspace : undefined);
          try { return client.bootstrap(options); }
          catch (error) { throw new BootstrapUnavailableError(error instanceof Error ? error.message : 'Bootstrap failed.', { cause: error }); }
        }
        const parent = dirname(current);
        if (parent === current) return undefined;
        current = parent;
      }
    },
    project: (path: string) => {
      const project = resolver.resolve(path);
      const semantic = semanticFor(storage, project.project_id);
      return new ProjectClient(storage, sourceFor(project), project, undefined, semantic, semantic ? config.mode : 'lexical');
    },
    doctor: () => {
      const health = storage.diagnose();
      try { readSourceScopes(home); }
      catch (error) { health.problems.push(error instanceof SourceScopeError ? error.message : 'Source-scope configuration unavailable.'); }
      const roots: { project_id: string; accessible: boolean }[] = [];
      const workspaces: { project_id: string; workspace_id: string; accessible: boolean }[] = [];
      if (!health.problems.includes('corrupted project identity')) {
        for (const p of storage.projects()) {
          try {
            accessSync(p.root);
            const canonical = realpathSync.native(p.root);
            if (!statSync(p.root).isDirectory() || (process.platform === 'win32' ? canonical.toLowerCase() : canonical) !== p.root) throw new Error('Root binding changed');
            roots.push({ project_id: p.project_id, accessible: true });
          }
          catch { roots.push({ project_id: p.project_id, accessible: false }); health.problems.push(`inaccessible/stale registration: ${p.project_id}`); }
          for (const w of storage.workspaces(p.project_id)) {
            let accessible = true;
            try { verifyWorkspace(p.root, w.root); }
            catch { accessible = false; health.problems.push(`inaccessible/stale workspace: ${w.workspace_id}`); }
            workspaces.push({ project_id: p.project_id, workspace_id: w.workspace_id, accessible });
          }
        }
      }
      const major = Number(process.versions.node.split('.')[0]);
      const minor = Number(process.versions.node.split('.')[1]);
      if (major < 24 || (major === 24 && minor < 13)) health.problems.push('unsupported Node runtime: use Node 24.13 or later');
      const adapters = { generic: true, 'http-loopback': true, 'mcp-stdio': false };
      try { import.meta.resolve('@modelcontextprotocol/sdk/server/mcp.js'); adapters['mcp-stdio'] = true; }
      catch { health.problems.push('MCP SDK unavailable'); }
      return { ...health, version: '0.1.0', node: process.versions.node, roots, workspaces, adapters, runtime_note: 'node:sqlite is pre-stable in Node 24; warnings depend on the installed patch version.' };
    },
    close: () => { for (const bound of workspaceStores.values()) bound.close(); storage.close(); },
  };
}
