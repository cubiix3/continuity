import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { ProjectClient, ProjectResolver, canonicalRoot } from '../../core/src/index.js';
import { SqliteStorage } from '../../storage-sqlite/src/index.js';
import { FileSources, isWithin } from '../../source-files/src/index.js';
import type { Project, Workspace } from '../../core/src/contracts.js';
import { reviewMemory } from '../../core/src/memory/review.js';
import { accessSync, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { retrievalConfig } from './retrieval-config.js';
import { OllamaRetrieval } from '../../retrieval-semantic/src/ollama.js';
import { OpenVikingRetrieval } from '../../retrieval-semantic/src/openviking.js';
import { randomUUID } from 'node:crypto';
import { mapBounded, verifyWorkspace, verifyWorkspaceAsync } from './workspaces.js';
import { Inspection } from '../../core/src/inspection.js';
import { passages } from '../../core/src/context/passages.js';
import { continuityHome, coordinatedSync } from './local-ipc.js';
import { anchoredScope, readSourceScopes, sourceScopeSchema, writeSourceScope, SourceScopeError } from './source-scope.js';
import type { SourceScope } from './source-scope.js';

/** Host API compatibility boundary. 2: host.doctor() returns a Promise (Host API 1, v0.1.0, returned the report synchronously). */
export const CONTINUITY_HOST_API_VERSION = 2;
/** Workspaces verified at once by doctor. Each verification runs up to five short Git processes in sequence. */
export const DOCTOR_WORKSPACE_CONCURRENCY = 4;
/** Workspaces whose Git link files the cheap Overview health reads at once. */
const HEALTH_READ_CONCURRENCY = 16;
const gitLinkTarget = (dir: string, text: string) => {
  const link = text.match(/^gitdir:\s*(.+?)\s*$/m)?.[1];
  if (!link) throw new Error('Not a Git link file.');
  return isAbsolute(link) ? link : join(dir, link);
};
const gitLink = (dir: string) => realpathSync.native(gitLinkTarget(dir, readFileSync(join(dir, '.git'), 'utf8')));
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
const gitLinkAsync = async (dir: string) => realpath(gitLinkTarget(dir, await readFile(join(dir, '.git'), 'utf8')));
/**
 * A checkout's common Git directory without spawning git: its .git directory, or behind a .git link file the linked
 * directory's commondir (a linked worktree) or the linked directory itself (separate Git dir, submodule).
 */
async function commonGitDir(root: string) {
  if ((await stat(join(root, '.git'))).isDirectory()) return realpath(join(root, '.git'));
  const linked = await gitLinkAsync(root);
  let common: string;
  try { common = (await readFile(join(linked, 'commondir'), 'utf8')).trim(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return linked; throw error; }
  return realpath(isAbsolute(common) ? common : join(linked, common));
}
/**
 * attachedWorktree without blocking the event loop, for display-only health over many workspaces. The project may
 * itself be a linked worktree, so its common Git directory is resolved the way git rev-parse --git-common-dir does.
 */
async function attachedWorktreeAsync(projectRoot: string, workspaceRoot: string) {
  try {
    const worktreeGit = await gitLinkAsync(workspaceRoot);
    const common = await realpath(join(worktreeGit, (await readFile(join(worktreeGit, 'commondir'), 'utf8')).trim()));
    return sameDir(common, await commonGitDir(projectRoot));
  } catch { return false; }
}
/** Runtime findings shared by the full doctor and the cheap Overview health. */
function runtimeProblems() {
  const problems: string[] = [];
  const major = Number(process.versions.node.split('.')[0]);
  const minor = Number(process.versions.node.split('.')[1]);
  if (major < 24 || (major === 24 && minor < 13)) problems.push('unsupported Node runtime: use Node 24.13 or later');
  let mcp = true;
  try { import.meta.resolve('@modelcontextprotocol/sdk/server/mcp.js'); }
  catch { mcp = false; problems.push('MCP SDK unavailable'); }
  return { problems, mcp };
}
/** Bootstrap failed after the directory resolved to a registered project or workspace. */
export class BootstrapUnavailableError extends Error { constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = 'BootstrapUnavailableError'; } }
export interface HostOptions { sources?: { include?: readonly string[]; exclude?: readonly string[] } }

/** Trusted composition root for local hosts. Do not pass this host into agent tools. */
export function openContinuity(home = process.env.CONTINUITY_HOME ?? join(homedir(), '.continuity'), options: HostOptions = {}) {
  home = continuityHome(home);
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
  /** Nearest registered project or workspace root at or above `path`; a detached worktree path resolves to nothing. */
  const nearest = (path: string): { project: Project; workspace?: Workspace; start: string } | undefined => {
    const start = canonicalRoot(path);
    let current = start;
    const projects = storage.projects(), workspaceRoots = new Map(projects.flatMap(p => storage.workspaces(p.project_id).map(w => [w.root, { project: p, workspace: w }] as const)));
    for (;;) {
      const primary = projects.find(p => p.root === current);
      if (primary) return { project: primary, start };
      const candidate = workspaceRoots.get(current);
      // A removed worktree's path can be reused by an unrelated checkout: no context rather than a wrong one.
      if (candidate) return attachedWorktree(candidate.project.root, candidate.workspace.root) ? { ...candidate, start } : undefined;
      const parent = dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  };
  const sourceScopeFinding = () => {
    try { readSourceScopes(home); return undefined; }
    catch (error) { return error instanceof SourceScopeError ? error.message : 'Source-scope configuration unavailable.'; }
  };
  const rootAccessible = (p: Project) => {
    try {
      accessSync(p.root);
      const canonical = realpathSync.native(p.root);
      return statSync(p.root).isDirectory() && (process.platform === 'win32' ? canonical.toLowerCase() : canonical) === p.root;
    } catch { return false; }
  };
  const coordinate = (client: ProjectClient, projectId: string, workspaceId = '') => {
    const sync = client.sync.bind(client);
    client.sync = () => coordinatedSync(home, `${projectId}:${workspaceId}`, sync);
    return client;
  };
  return {
    inspection,
    /** Trusted local runtime only; the same scanner chooses watch directories and source exclusions. */
    watchPlan: (projectId: string, workspaceId = '') => {
      const { project, workspace } = inspectionScope(projectId, workspaceId);
      const root = workspace?.root ?? project.root;
      return sourceFor(project, root).watchPlan({ ...project, root });
    },
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
      return coordinate(new ProjectClient(bound, workspaceSource, project, undefined, semantic, semantic ? config.mode : 'lexical', workspace), project.project_id, workspace.workspace_id);
    },
    /**
     * Read-only agent startup index for the directory an agent runs in. Resolves the nearest registered project or
     * workspace root without registering, syncing, or running git. Returns undefined for an unregistered directory.
     */
    bootstrap: (path: string, options: { budget?: number } = {}) => {
      const scope = nearest(path);
      if (!scope) return undefined;
      const client = new ProjectClient(boundStore(scope.workspace?.workspace_id ?? ''), sourceFor(scope.project), scope.project, undefined, undefined, 'lexical', scope.workspace);
      try { return client.bootstrap(options); }
      catch (error) { throw new BootstrapUnavailableError(error instanceof Error ? error.message : 'Bootstrap failed.', { cause: error }); }
    },
    /**
     * Project-bound client for an agent session's directory, resolved exactly like bootstrap (nearest registered
     * project or attached worktree, never registering). Lexical only: no semantic backend. Undefined when unbound.
     */
    session: (path: string) => {
      const scope = nearest(path);
      if (!scope) return undefined;
      const { project, workspace, start } = scope;
      // A Git checkout nested below the resolved root (an unregistered worktree, submodule or nested repository) is a
      // different tree: writes there would carry the wrong workspace and source evidence.
      for (let dir = start; dir !== (workspace?.root ?? project.root); dir = dirname(dir)) if (dirname(dir) === dir || existsSync(join(dir, '.git'))) return undefined;
      if (!workspace) return new ProjectClient(storage, sourceFor(project), project, undefined, undefined, 'lexical');
      const source = sourceFor(project, workspace.root);
      const workspaceSource = { scan: () => { verifyWorkspace(project.root, workspace.root); return source.scan({ ...project, root: workspace.root }); } };
      return new ProjectClient(boundStore(workspace.workspace_id), workspaceSource, project, undefined, undefined, 'lexical', workspace);
    },
    project: (path: string) => {
      const project = resolver.resolve(path);
      const semantic = semanticFor(storage, project.project_id);
      return coordinate(new ProjectClient(storage, sourceFor(project), project, undefined, semantic, semantic ? config.mode : 'lexical'), project.project_id);
    },
    /**
     * Full local diagnostics: storage integrity, every registration and every workspace's Git membership. Git runs
     * asynchronously, at most DOCTOR_WORKSPACE_CONCURRENCY workspaces at a time; findings keep registration order.
     */
    doctor: async () => {
      const health = storage.diagnose();
      const sourceScopeProblem = sourceScopeFinding();
      if (sourceScopeProblem) health.problems.push(sourceScopeProblem);
      const roots: { project_id: string; accessible: boolean }[] = [];
      const workspaces: { project_id: string; workspace_id: string; accessible: boolean }[] = [];
      if (!health.problems.includes('corrupted project identity')) {
        const projects = storage.projects().map(project => ({ project, accessible: rootAccessible(project), workspaces: storage.workspaces(project.project_id) }));
        const checks = projects.flatMap(({ project, workspaces: registered }) => registered.map(workspace => ({ project, workspace })));
        const verified = await mapBounded(checks, DOCTOR_WORKSPACE_CONCURRENCY, ({ project, workspace }) => verifyWorkspaceAsync(project.root, workspace.root).then(() => true, () => false));
        let index = 0;
        for (const { project: p, accessible: rootOk, workspaces: registered } of projects) {
          roots.push({ project_id: p.project_id, accessible: rootOk });
          if (!rootOk) health.problems.push(`inaccessible/stale registration: ${p.project_id}`);
          for (const w of registered) {
            const accessible = verified[index++]!;
            if (!accessible) health.problems.push(`inaccessible/stale workspace: ${w.workspace_id}`);
            workspaces.push({ project_id: p.project_id, workspace_id: w.workspace_id, accessible });
          }
        }
      }
      const runtime = runtimeProblems();
      health.problems.push(...runtime.problems);
      const adapters = { generic: true, 'http-loopback': true, 'mcp-stdio': runtime.mcp };
      return { ...health, version: '0.1.0', node: process.versions.node, roots, workspaces, adapters, runtime_note: 'node:sqlite is pre-stable in Node 24; warnings depend on the installed patch version.' };
    },
    /**
     * Cheap current health for one project's Overview: storage capabilities, local configuration, the project root
     * and each workspace's Git link files (read asynchronously). No Git process, record scan or integrity check runs.
     * Display only: it never authorizes an operation, which still verifies its workspace in full.
     */
    health: async (projectId: string) => {
      const { project } = inspection.scope(projectId, '');
      const { schema_version, fts5 } = storage.capabilities();
      const problems: string[] = [];
      if (!fts5) problems.push('FTS5 unavailable');
      const sourceScopeProblem = sourceScopeFinding();
      if (sourceScopeProblem) problems.push(sourceScopeProblem);
      if (!rootAccessible(project)) problems.push(`inaccessible/stale registration: ${project.project_id}`);
      const registered = storage.workspaces(project.project_id);
      // A few file reads per workspace; bounded so thousands of workspaces cannot exhaust file handles.
      const attached = await mapBounded(registered, HEALTH_READ_CONCURRENCY, w => attachedWorktreeAsync(project.root, w.root));
      registered.forEach((w, index) => { if (!attached[index]) problems.push(`inaccessible/stale workspace: ${w.workspace_id}`); });
      problems.push(...runtimeProblems().problems);
      return { project_id: project.project_id, schema_version, fts5, problems };
    },
    close: () => { for (const bound of workspaceStores.values()) bound.close(); storage.close(); },
  };
}
