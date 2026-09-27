import { test, expect } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openContinuity } from '../packages/sdk/src/index.js';
import { startupRegistration } from '../packages/sdk/src/startup-windows.js';
import { verifyWorkspace, verifyWorkspaceAsync } from '../packages/sdk/src/workspaces.js';
import { windowsGit, windowsGitEnvironment, windowsPowerShell, windowsSystemDirectory } from '../packages/sdk/src/windows-process.js';

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

test.skipIf(process.platform !== 'win32')('repository executables and poisoned process settings cannot redirect Windows verification or startup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'continuity-win-process-'));
  const project = join(root, 'project'), workspace = join(root, 'worktree');
  const marker = join(root, 'marker.txt'), program = join(root, 'marker.exe');
  const originalCwd = process.cwd();
  const original = { PATH: process.env.PATH, PATHEXT: process.env.PATHEXT, SystemRoot: process.env.SystemRoot, PSModulePath: process.env.PSModulePath, GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE, GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT, GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0, GIT_CONFIG_VALUE_0: process.env.GIT_CONFIG_VALUE_0, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL };
  let host: ReturnType<typeof openContinuity> | undefined;
  try {
    mkdirSync(project);
    const git = (...args: string[]) => execFileSync(windowsGit(), args, { cwd: windowsSystemDirectory(), env: windowsGitEnvironment(), windowsHide: true, stdio: 'pipe' });
    git('-C', project, 'init', '-q');
    git('-C', project, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture');
    git('-C', project, 'worktree', 'add', '-q', '-b', 'fixture-worktree', workspace);
    host = openContinuity(join(root, 'state'));
    host.init(project);
    host.workspace(project, workspace);
    const canonicalWorkspace = realpathSync.native(workspace).toLowerCase();

    const source = `using System.IO; class Marker { public static int Main(string[] args) { File.WriteAllText(${JSON.stringify(marker)}, "executed"); return 0; } }`;
    const compile = `Add-Type -TypeDefinition ${quote(source)} -OutputType ConsoleApplication -OutputAssembly ${quote(program)}`;
    execFileSync(windowsPowerShell(), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(compile, 'utf16le').toString('base64')], { cwd: windowsSystemDirectory(), windowsHide: true, stdio: 'pipe' });
    copyFileSync(program, join(project, 'git.exe'));
    copyFileSync(program, join(project, 'git.com'));
    copyFileSync(program, join(project, 'powershell.exe'));
    const module = join(project, 'Microsoft.PowerShell.Management');
    mkdirSync(module);
    writeFileSync(join(module, 'Microsoft.PowerShell.Management.psm1'), `Set-Content -LiteralPath ${quote(marker)} -Value 'module loaded'\nfunction Get-ItemProperty { throw 'marker module' }\nExport-ModuleMember -Function Get-ItemProperty`);
    process.chdir(project);
    process.env.PATH = `.;${project};${original.PATH ?? ''}`;
    process.env.PATHEXT = '.COM;.EXE';
    process.env.PSModulePath = project;
    process.env.GIT_DIR = join(root, 'other-repository');
    process.env.GIT_WORK_TREE = join(root, 'other-worktree');
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = 'core.fsmonitor';
    process.env.GIT_CONFIG_VALUE_0 = join(project, 'git.exe');
    process.env.GIT_CONFIG_GLOBAL = join(project, 'git.exe');

    expect(verifyWorkspace(project, workspace).toLowerCase()).toBe(canonicalWorkspace);
    expect((await verifyWorkspaceAsync(project, workspace)).toLowerCase()).toBe(canonicalWorkspace);
    expect((await host.doctor()).problems).toEqual([]);
    expect(startupRegistration('status', join(root, 'startup-home'), resolve('dist/packages/cli/src/index.js')).installed).toBe(false);
    expect(existsSync(marker)).toBe(false);

    rmSync(join(project, 'git.exe'));
    expect(verifyWorkspace(project, workspace).toLowerCase()).toBe(canonicalWorkspace);
    expect((await verifyWorkspaceAsync(project, workspace)).toLowerCase()).toBe(canonicalWorkspace);
    expect(existsSync(marker)).toBe(false);

    const fakeSystem = join(project, 'fake-system');
    mkdirSync(join(fakeSystem, 'System32', 'WindowsPowerShell', 'v1.0'), { recursive: true });
    for (const file of ['conhost.exe', 'reg.exe']) copyFileSync(program, join(fakeSystem, 'System32', file));
    copyFileSync(program, join(fakeSystem, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
    process.env.SystemRoot = fakeSystem;
    expect(windowsSystemDirectory()).toMatch(/\\Windows\\System32$/i);
    expect(verifyWorkspace(project, workspace).toLowerCase()).toBe(canonicalWorkspace);
    expect((await verifyWorkspaceAsync(project, workspace)).toLowerCase()).toBe(canonicalWorkspace);
    expect(() => startupRegistration('install', join(root, 'startup-home'), resolve('dist/packages/cli/src/index.js'))).toThrow();
    expect(existsSync(marker)).toBe(false);
  } finally {
    process.chdir(originalCwd);
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    host?.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
