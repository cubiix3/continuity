import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const canonical = (path: string) => {
  const root = realpathSync.native(path);
  if (!statSync(root).isDirectory()) throw new Error('Workspace root must be a directory.');
  return process.platform === 'win32' ? root.toLowerCase() : root;
};
/** Host-only Git membership check. Neither display names nor copied identity files grant scope. */
export function verifyWorkspace(projectRoot: string, workspaceRoot: string): string {
  const project = canonical(projectRoot); const workspace = canonical(workspaceRoot);
  const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, 'rev-parse', '--path-format=absolute', ...args], { encoding: 'utf8', timeout: 5000, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (canonical(git(project, '--git-common-dir')) !== canonical(git(workspace, '--git-common-dir'))) throw new Error('Workspace belongs to another Git repository.');
  if (canonical(git(workspace, '--show-toplevel')) !== workspace) throw new Error('Workspace must be a Git worktree root.');
  // Check Git's registration too: a copied .git file is not an attached worktree.
  const entries = execFileSync('git', ['-C', project, 'worktree', 'list', '--porcelain', '-z'], { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  if (!entries.split('\0').some(line => line.startsWith('worktree ') && existsSync(resolve(line.slice(9))) && canonical(resolve(line.slice(9))) === workspace)) throw new Error('Workspace is not registered with Git.');
  return workspace;
}
