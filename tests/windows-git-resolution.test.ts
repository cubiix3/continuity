import { expect, test, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const state = vi.hoisted(() => ({ root: '', asyncCalls: 0, syncCalls: 0 }));
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: ((file: string, ...args: unknown[]) => {
      if (/[/\\]reg\.exe$/i.test(file)) { state.syncCalls++; throw new Error('Synchronous registry lookup'); }
      return (actual.execFileSync as (...args: unknown[]) => unknown)(file, ...args);
    }) as typeof actual.execFileSync,
    execFile: ((file: string, args: string[], options: object, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
      if (/[/\\]reg\.exe$/i.test(file)) {
        state.asyncCalls++;
        setTimeout(() => callback(null, `    InstallPath    REG_SZ    ${state.root}\r\n`, ''), 50);
        return { stdin: { end() {} } };
      }
      return actual.execFile(file, args, options, callback);
    }) as typeof actual.execFile,
  };
});

test.skipIf(process.platform !== 'win32')('cold Git discovery leaves the event loop available for Doctor', async () => {
  const root = mkdtempSync(join(tmpdir(), 'continuity-git-resolution-'));
  state.root = root;
  mkdirSync(join(root, 'cmd'));
  writeFileSync(join(root, 'cmd', 'git.exe'), 'fixture');
  try {
    const { windowsGitAsync } = await import('../packages/sdk/src/windows-process.js');
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    try { expect(await windowsGitAsync()).toBe(realpathSync.native(join(root, 'cmd', 'git.exe'))); }
    finally { clearInterval(timer); }
    expect(ticks).toBeGreaterThan(0);
    expect(state.asyncCalls).toBe(1);
    expect(state.syncCalls).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
