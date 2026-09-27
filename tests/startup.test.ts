import { test, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { startupAction, startupRegistration, windowsArgument } from '../packages/sdk/src/startup-windows.js';
import { continuityHome } from '../packages/sdk/src/local-ipc.js';
import { recordStart } from '../packages/sdk/src/start-record.js';
import { runtimeRequest, stopBackground } from '../packages/sdk/src/background.js';

/** Test-only: changes the registered task's action through the same Task Scheduler COM API, keeping its principal. */
function tamper(name: string, change: { path?: string; args?: string; workdir?: string; second?: boolean }) {
  const payload = Buffer.from(JSON.stringify({ name, ...change }), 'utf8').toString('base64');
  const script = `$ErrorActionPreference = 'Stop'
$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
$s = New-Object -ComObject Schedule.Service; $s.Connect(); $f = $s.GetFolder('\\'); $d = $f.GetTask($p.name).Definition; $a = $d.Actions.Item(1)
if ($p.path) { $a.Path = $p.path }; if ($p.args) { $a.Arguments = $p.args }; if ($p.workdir) { $a.WorkingDirectory = $p.workdir }
if ($p.second) { $b = $d.Actions.Create(0); $b.Path = $a.Path; $b.Arguments = $a.Arguments }
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$null = $f.RegisterTaskDefinition($p.name, $d, 6, $sid, $null, 3)`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: 'pipe' });
}
const waitFor = async (check: () => Promise<boolean>) => { for (let i = 0; i < 150; i++) { if (await check()) return true; await new Promise(r => setTimeout(r, 100)); } return false; };

test('user startup runs the runtime through the headless console host, checks the exact action, and records each start', async () => {
  const home = mkdtempSync(join(tmpdir(), 'continuity startup ü ')), cli = resolve('dist/packages/cli/src/index.js');
  if (process.platform !== 'win32') {
    try { expect(() => startupRegistration('install', home, cli)).toThrow('not implemented'); } finally { rmSync(home, { recursive: true, force: true }); } return;
  }
  const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve)); const address = probe.address(); if (!address || typeof address === 'string') throw new Error('address'); const port = address.port; await new Promise<void>(resolve => probe.close(() => resolve()));
  const canonical = continuityHome(home), system = join(process.env.SystemRoot!, 'System32');
  const expected = startupAction(system, process.execPath, cli, canonical, port, false);
  type Status = { installed: boolean; current_command?: boolean; launcher?: string; startup_result?: { state: string } };
  const status = () => startupRegistration('status', home, cli, port, false) as Status;
  try {
    // An older Windows gets an explicit refusal, never a task that opens a window; 17763 (1809) itself is supported.
    expect(() => startupRegistration('install', home, cli, port, false, { build: 17762, systemRoot: process.env.SystemRoot })).toThrow('1809');
    expect(startupRegistration('status', home, cli, port, false, { build: 17762, systemRoot: process.env.SystemRoot })).toMatchObject({ installed: false, supported: false });
    expect(startupRegistration('status', home, cli, port, false, { build: 17763, systemRoot: process.env.SystemRoot })).toMatchObject({ installed: false, supported: true });
    // "Use legacy console" makes the console host refuse --headless: refused as well, and reported by status.
    expect(() => startupRegistration('install', home, cli, port, false, { build: 26200, systemRoot: process.env.SystemRoot, legacyConsole: true })).toThrow('legacy console');
    expect(startupRegistration('status', home, cli, port, false, { build: 26200, systemRoot: process.env.SystemRoot, legacyConsole: true })).toMatchObject({ supported: false, unsupported: expect.stringContaining('ForceV2') });
    // Windows expands %VAR% in the task's command line: such a path is refused.
    expect(() => startupRegistration('install', home, join(home, '%USERNAME%', 'index.js'), port, false)).toThrow('%');
    // A console host outside the Windows system directory (an altered SystemRoot) is refused, and nothing is registered.
    const fakeRoot = join(home, 'fake windows'); mkdirSync(join(fakeRoot, 'System32'), { recursive: true }); writeFileSync(join(fakeRoot, 'System32', 'conhost.exe'), '');
    expect(() => startupRegistration('install', home, cli, port, false, { build: 26200, systemRoot: fakeRoot })).toThrow('registration failed');
    expect(status().installed).toBe(false);
    const first = startupRegistration('install', home, cli, port, false), again = startupRegistration('install', home, cli, port, false);
    expect(first.name).toBe(again.name);
    expect(again).toMatchObject({ current_command: true, executable: expected.executable, arguments: expected.arguments, launcher: 'conhost --headless', logon_type: 3, run_level: 0, supported: true });
    expect(again.arguments).toMatch(/^--headless "[^"]+node\.exe" "[^"]+index\.js" "--home" "[^"]*ü[^"]*" "runtime" "start" "--port" "\d+" "--no-auto-sync"$/);
    expect(status()).toMatchObject({ dashboard: `http://127.0.0.1:${port}`, startup_result: { state: 'not_run' } });

    // An old failure record never stands for the task's run.
    recordStart(canonical, 'failed', 'start_timeout', new Date(Date.now() - 10 * 60_000));
    execFileSync('schtasks.exe', ['/Run', '/TN', String(first.name)], { windowsHide: true, stdio: 'pipe' });
    expect(await waitFor(async () => (await runtimeRequest(home)).running === true)).toBe(true);
    const running = await runtimeRequest(home);
    expect(running.auto_sync).toBe(false); expect(running.dashboard).toBe(`http://127.0.0.1:${port}`);
    const response = await fetch(String(running.dashboard)); expect(response.status).toBe(200); await response.text();
    expect(await waitFor(async () => status().startup_result?.state === 'started')).toBe(true);
    // A second run while the runtime is up: the same runtime, reported as already running.
    execFileSync('schtasks.exe', ['/Run', '/TN', String(first.name)], { windowsHide: true, stdio: 'pipe' });
    expect(await waitFor(async () => status().startup_result?.state === 'already_running')).toBe(true);
    expect((await runtimeRequest(home)).pid).toBe(running.pid);
    await stopBackground(home);

    // current_command is the exact wrapped action: every deviation reads as not current, and install repairs it.
    const node = windowsArgument(process.execPath), rest = expected.arguments.slice(`--headless ${node} `.length);
    const deviations: [string, Parameters<typeof tamper>[1]][] = [
      ['old direct task', { path: process.execPath, args: rest }],
      ['other console host', { path: join(home, 'fake windows', 'System32', 'conhost.exe') }],
      ['wrapper missing', { args: `${node} ${rest}` }],
      ['other Node', { args: expected.arguments.replace(node, windowsArgument('C:\\Other\\node.exe')) }],
      ['other CLI', { args: expected.arguments.replace(windowsArgument(cli), windowsArgument(join(home, 'other', 'index.js'))) }],
      ['other home', { args: expected.arguments.replace(windowsArgument(canonical), windowsArgument(`${canonical}-other`)) }],
      ['other port', { args: expected.arguments.replace(`"--port" "${port}"`, `"--port" "${port + 1}"`) }],
      ['extra argument', { args: `${expected.arguments} "--verbose"` }],
      ['option case', { args: expected.arguments.replace('"--home"', '"--HOME"') }],
      // Characters a culture-aware comparison ignores: a soft hyphen, a zero-width joiner, a decomposed ü.
      ['soft hyphen', { args: expected.arguments.replace('"runtime"', `"run${String.fromCharCode(0xad)}time"`) }],
      ['zero-width joiner', { args: expected.arguments.replace(`"--port" "${port}"`, `"--port" "${port}${String.fromCharCode(0x200d)}"`) }],
      ['decomposed home', { args: expected.arguments.replace(windowsArgument(canonical), windowsArgument(canonical.normalize('NFD'))) }],
      ['working directory', { workdir: tmpdir() }],
      ['second action', { second: true }],
    ];
    expect(canonical.normalize('NFD')).not.toBe(canonical);
    for (const [label, change] of deviations) {
      tamper(String(first.name), change);
      const tampered = status() as Status & { executable_available?: boolean };
      expect([label, tampered.current_command]).toEqual([label, false]);
      if (label === 'other Node') expect(tampered.executable_available).toBe(false);
      if (label === 'other console host') expect(tampered.launcher).toBe('conhost --headless (not the Windows system copy)');
      expect(startupRegistration('install', home, cli, port, false).current_command).toBe(true);
    }
    // The task's earlier runs belong to the replaced registration: none counts for this one yet.
    expect(status().startup_result?.state).toBe('not_run');
    expect((status() as { task?: { last_run: string | null; launcher_result: number | null } }).task).toMatchObject({ last_run: null, launcher_result: null });
    expect(status().launcher).toBe('conhost --headless');
    tamper(String(first.name), { path: process.execPath, args: rest });
    expect(status().launcher).toMatch(/^direct/);

    const stale = startupRegistration('install', home, join(home, 'missing cli.js'), port); expect(stale.installed_cli_available).toBe(false);
    expect(startupRegistration('install', home, cli, port).installed_cli_available).toBe(true);
    expect(startupRegistration('remove', home, cli).installed).toBe(false);
    expect(startupRegistration('remove', home, cli).installed).toBe(false);
    expect(startupRegistration('status', home, cli).installed).toBe(false);
  } finally { await stopBackground(home); startupRegistration('remove', home, cli); rmSync(home, { recursive: true, force: true }); }
  // About thirty sequential PowerShell/COM calls; slow Windows runners need headroom.
}, 240_000);
