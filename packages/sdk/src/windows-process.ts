import { execFile, execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { win32 } from 'node:path';

/** Resolve system tools without consulting the caller's current directory or PATH. */
export function windowsSystemDirectory(): string {
  return realpathSync.native('\\\\?\\GLOBALROOT\\SystemRoot\\System32');
}

export function windowsPowerShell(): string {
  return realpathSync.native(win32.join(windowsSystemDirectory(), 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
}

export function windowsPowerShellEnvironment(system = windowsSystemDirectory()): NodeJS.ProcessEnv {
  const root = win32.dirname(system);
  return {
    SystemRoot: root,
    WINDIR: root,
    PATH: `${system};${root}`,
    PSModulePath: win32.join(system, 'WindowsPowerShell', 'v1.0', 'Modules'),
  };
}

/** Only OS variables needed by native Windows programs; never forward inherited Git settings. */
export function windowsGitEnvironment(system = windowsSystemDirectory()): NodeJS.ProcessEnv {
  const root = win32.dirname(system);
  return {
    SystemRoot: root,
    WINDIR: root,
    PATH: `${system};${root}`,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: 'NUL',
    HOME: system,
  };
}

let gitExecutable: string | undefined;
const registryKeys = ['HKLM\\SOFTWARE\\GitForWindows', 'HKCU\\SOFTWARE\\GitForWindows'];
const registryOptions = (system: string) => ({
  cwd: system, env: windowsGitEnvironment(system), encoding: 'utf8' as const, timeout: 5000,
  maxBuffer: 65536, windowsHide: true,
});
function gitFromRegistry(output: string): string {
  const install = output.match(/^\s*InstallPath\s+REG_SZ\s+(.+?)\s*$/im)?.[1];
  if (!install || !win32.isAbsolute(install)) throw new Error('Trusted Git installation is unavailable.');
  return realpathSync.native(win32.join(install, 'cmd', 'git.exe'));
}
export function windowsGit(): string {
  if (gitExecutable) return gitExecutable;
  const system = windowsSystemDirectory();
  for (const key of registryKeys) {
    try {
      const output = execFileSync(win32.join(system, 'reg.exe'), ['query', key, '/v', 'InstallPath'], {
        ...registryOptions(system), stdio: ['ignore', 'pipe', 'pipe'],
      });
      return gitExecutable = gitFromRegistry(output);
    } catch { /* Try the next installer scope. */ }
  }
  throw new Error('Trusted Git installation is unavailable.');
}

let gitPromise: Promise<string> | undefined;
export async function windowsGitAsync(): Promise<string> {
  if (gitExecutable) return Promise.resolve(gitExecutable);
  if (gitPromise) return gitPromise;
  gitPromise = (async () => {
    const system = windowsSystemDirectory();
    for (const key of registryKeys) {
      try {
        const output = await new Promise<string>((resolve, reject) => {
          const child = execFile(win32.join(system, 'reg.exe'), ['query', key, '/v', 'InstallPath'], registryOptions(system), (error, stdout) => error ? reject(error) : resolve(stdout));
          child.stdin?.end();
        });
        return gitExecutable = gitFromRegistry(output);
      } catch { /* Try the next installer scope. */ }
    }
    throw new Error('Trusted Git installation is unavailable.');
  })();
  try { return await gitPromise; } finally { gitPromise = undefined; }
}
