import { execFile, execFileSync } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const canonical = (path: string) => {
  const root = realpathSync.native(path);
  if (!statSync(root).isDirectory()) throw new Error('Workspace root must be a directory.');
  return process.platform === 'win32' ? root.toLowerCase() : root;
};
interface GitCall { args: string[]; maxBuffer: number }
const GIT_TIMEOUT_MS = 5000;
/**
 * The membership checks as a sequence of Git calls, so the synchronous and asynchronous verifiers share one
 * definition. Each yielded call receives Git's stdout; any failed call rejects the workspace.
 */
function* membership(projectRoot: string, workspaceRoot: string): Generator<GitCall, string, string> {
  const project = canonical(projectRoot); const workspace = canonical(workspaceRoot);
  const revParse = (root: string, ...args: string[]): GitCall => ({ args: ['-C', root, 'rev-parse', '--path-format=absolute', ...args], maxBuffer: 65536 });
  if (canonical((yield revParse(project, '--show-toplevel')).trim()) !== project) throw new Error('Only a full Git repository project can attach worktrees.');
  const projectCommon = canonical((yield revParse(project, '--git-common-dir')).trim());
  if (projectCommon !== canonical((yield revParse(workspace, '--git-common-dir')).trim())) throw new Error('Workspace belongs to another Git repository.');
  if (canonical((yield revParse(workspace, '--show-toplevel')).trim()) !== workspace) throw new Error('Workspace must be a Git worktree root.');
  // Check Git's registration too: a copied .git file is not an attached worktree.
  const entries = yield { args: ['-C', project, 'worktree', 'list', '--porcelain', '-z'], maxBuffer: 1024 * 1024 };
  if (!entries.split('\0').some(line => line.startsWith('worktree ') && existsSync(resolve(line.slice(9))) && canonical(resolve(line.slice(9))) === workspace)) throw new Error('Workspace is not registered with Git.');
  return workspace;
}
/** Host-only Git membership check. Neither display names nor copied identity files grant scope. */
export function verifyWorkspace(projectRoot: string, workspaceRoot: string): string {
  const checks = membership(projectRoot, workspaceRoot);
  for (let step = checks.next(); ; ) {
    if (step.done) return step.value;
    const { args, maxBuffer } = step.value;
    step = checks.next(execFileSync('git', args, { encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer, stdio: ['ignore', 'pipe', 'pipe'] }));
  }
}

/**
 * Runs a fixed executable with an argument array (never a shell), bounded by a timeout and output limit. The child is
 * killed on timeout or overflow, and the promise rejects; stdin is closed immediately.
 */
export function runFile(file: string, args: readonly string[], options: { timeout: number; maxBuffer: number }): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(file, args, { encoding: 'utf8', timeout: options.timeout, maxBuffer: options.maxBuffer, shell: false }, (error, stdout) => error ? reject(error) : resolvePromise(stdout));
    child.stdin?.end();
  });
}
/** The same membership check as verifyWorkspace, without blocking the event loop while Git runs. */
export async function verifyWorkspaceAsync(projectRoot: string, workspaceRoot: string): Promise<string> {
  const checks = membership(projectRoot, workspaceRoot);
  for (let step = checks.next(); ; ) {
    if (step.done) return step.value;
    const { args, maxBuffer } = step.value;
    step = checks.next(await runFile('git', args, { timeout: GIT_TIMEOUT_MS, maxBuffer }));
  }
}

/**
 * Maps items with at most `limit` operations in flight. Results keep the input order regardless of completion order;
 * a rejected operation rejects the whole map, so callers isolate per-item failures themselves.
 */
export async function mapBounded<T, R>(items: readonly T[], limit: number, operation: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const index = next++; results[index] = await operation(items[index]!, index); } };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, Math.trunc(limit) || 1), items.length) }, worker));
  return results;
}
