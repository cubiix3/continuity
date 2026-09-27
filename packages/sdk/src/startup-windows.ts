import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { release } from 'node:os';
import { win32 } from 'node:path';
import { continuityHome } from './local-ipc.js';
import { readStart, taskStartResult } from './start-record.js';
import { windowsPowerShell, windowsPowerShellEnvironment, windowsSystemDirectory } from './windows-process.js';

/** Windows argv quoting, not shell interpolation. Task Scheduler launches the executable directly. */
export function windowsArgument(value: string) { return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"'; }
export function startupName(home: string) { return `Continuity-${createHash('sha256').update(home).digest('hex').slice(0, 24)}`; }
/** `conhost.exe --headless`, the console host without a window that ConPTY uses, first shipped with Windows 10 1809. */
export const HEADLESS_CONSOLE_BUILD = 17763;
/**
 * The sign-in task's action (#44). Node is a console program, so a task that starts it directly opens a console
 * window at every sign-in. The console host started headless gives it a console without a window and runs exactly
 * `node.exe <cli> --home <home> runtime start --port <port>`. No shell, script host or launcher of Continuity's own.
 */
export function startupAction(systemDirectory: string, node: string, cli: string, home: string, port: number, autoSync: boolean) {
  const command = [node, cli, '--home', home, 'runtime', 'start', '--port', String(port), ...(!autoSync ? ['--no-auto-sync'] : [])];
  return { executable: win32.join(systemDirectory, 'conhost.exe'), arguments: `--headless ${command.map(windowsArgument).join(' ')}` };
}
/** The Windows build from the kernel version string, which application compatibility settings do not change. */
const windowsBuild = () => Number(release().split('.')[2]);
export function startupRegistration(action: 'install' | 'status' | 'remove', home: string, cli: string, port = 4783, autoSync = true, platform: { build: number; systemRoot: string | undefined; legacyConsole?: boolean } = { build: windowsBuild(), systemRoot: process.env.SystemRoot }) {
  if (process.platform !== 'win32') throw new Error('Automatic startup installation is not implemented on this platform.');
  home = continuityHome(home);
  const name = startupName(home), marker = `Continuity user startup ${name}`;
  const systemDirectory = platform.systemRoot ? win32.join(platform.systemRoot, 'System32') : '';
  const supported = Number.isInteger(platform.build) && platform.build >= HEADLESS_CONSOLE_BUILD && !!systemDirectory && existsSync(win32.join(systemDirectory, 'conhost.exe'));
  // No silent fallback to a task that opens a window: an older Windows gets no sign-in startup and says why.
  if (action === 'install' && !supported) throw new Error('Sign-in startup needs Windows 10 version 1809 (build 17763) or later, whose console host can run without a window. Nothing was installed, and an existing startup task is unchanged (continuity startup remove deletes it); run continuity runtime start instead.');
  // Task Scheduler and the console host both expand %VAR%, so a path containing % would start something else.
  if (action === 'install' && [process.execPath, cli, home].some(path => path.includes('%'))) throw new Error('Sign-in startup cannot use a Node, CLI or home path containing %, which Windows would expand. Nothing was installed.');
  const expected = supported ? startupAction(systemDirectory, process.execPath, cli, home, port, autoSync) : { executable: '', arguments: '' };
  const payload = Buffer.from(JSON.stringify({ action, name, marker, executable: expected.executable, args: expected.arguments, legacy: platform.legacyConsole ?? null }), 'utf8').toString('base64');
  // Fixed, versioned adapter logic; dynamic paths cross as JSON data, never PowerShell code.
  const script = `
$ErrorActionPreference = 'Stop'
[Console]::Error.WriteLine('startup:entry')
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::Error.WriteLine('startup:encoding')
$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
[Console]::Error.WriteLine('startup:json')
$service = New-Object -ComObject Schedule.Service
[Console]::Error.WriteLine('startup:object')
$service.Connect()
[Console]::Error.WriteLine('startup:connected')
$folder = $service.GetFolder('\\')
$task = $null
try { $task = $folder.GetTask($p.name) } catch { if ($_.Exception.HResult -ne -2147024894) { throw } }
[Console]::Error.WriteLine('startup:lookup')
if ($task -and $task.Definition.RegistrationInfo.Description -ne $p.marker) { throw 'Startup name is owned by another registration.' }
if ($p.action -eq 'remove') { if ($task) { $folder.DeleteTask($p.name, 0) }; @{ installed = $false; mechanism = 'Task Scheduler'; name = $p.name } | ConvertTo-Json -Compress; exit }
# "Use legacy console" (ForceV2 = 0) makes the console host refuse --headless and start nothing.
$legacy = $false
# Like the console host, only a DWORD value of 0 counts; another type is ignored.
if ($null -ne $p.legacy) { $legacy = [bool]$p.legacy } else { try { $v = (Get-ItemProperty -LiteralPath 'HKCU:\\Console' -Name ForceV2 -ErrorAction Stop).ForceV2; $legacy = ($v -is [int]) -and $v -eq 0 } catch { $legacy = $false } }
[Console]::Error.WriteLine('startup:registry')
if ($p.action -eq 'install') {
  if ($legacy) { @{ refused = 'legacy_console' } | ConvertTo-Json -Compress; exit }
  # The console host must be the one in the Windows system directory, however the environment names it.
  if (-not [string]::Equals($p.executable, (Join-Path ([Environment]::SystemDirectory) 'conhost.exe'), [StringComparison]::OrdinalIgnoreCase)) { throw 'Console host is not the Windows system copy.' }
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $definition = $service.NewTask(0)
  $definition.RegistrationInfo.Description = $p.marker
  $definition.RegistrationInfo.Date = [DateTime]::Now.ToString('s')
  $definition.Principal.UserId = $sid
  $definition.Principal.LogonType = 3
  $definition.Principal.RunLevel = 0
  $definition.Settings.Enabled = $true
  $definition.Settings.StartWhenAvailable = $true
  $definition.Settings.DisallowStartIfOnBatteries = $false
  $definition.Settings.StopIfGoingOnBatteries = $false
  $definition.Settings.ExecutionTimeLimit = 'PT1M'
  $definition.Settings.MultipleInstances = 2
  $trigger = $definition.Triggers.Create(9)
  $trigger.UserId = $sid
  $trigger.Enabled = $true
  $exec = $definition.Actions.Create(0)
  $exec.Path = $p.executable
  $exec.Arguments = $p.args
  $task = $folder.RegisterTaskDefinition($p.name, $definition, 6, $sid, $null, 3)
}
if (!$task) { @{ installed = $false; mechanism = 'Task Scheduler'; name = $p.name; legacy_console = $legacy } | ConvertTo-Json -Compress; exit }
$entry = $task.Definition.Actions.Item(1)
$principal = $task.Definition.Principal
# Current only as exactly one action: this executable, exactly these arguments (ordinal, character by character;
# -ceq compares by culture and ignores invisible characters), no working directory.
$current = $task.Definition.Actions.Count -eq 1 -and $entry.Type -eq 0 -and $p.executable -ne '' -and [string]::Equals($entry.Path, $p.executable, [StringComparison]::OrdinalIgnoreCase) -and [string]::Equals($entry.Arguments, $p.args, [StringComparison]::Ordinal) -and [string]::IsNullOrEmpty($entry.WorkingDirectory)
$lastRun = $null; if ($task.LastRunTime.Year -ge 2000) { $lastRun = $task.LastRunTime.ToUniversalTime().ToString('o') }
$registered = $null; try { $registered = [DateTime]::Parse($task.Definition.RegistrationInfo.Date).ToUniversalTime().ToString('o') } catch { $registered = $null }
@{ installed = $true; mechanism = 'Task Scheduler'; name = $p.name; executable = $entry.Path; arguments = $entry.Arguments; current_command = $current; enabled = $task.Enabled; logon_type = $principal.LogonType; run_level = $principal.RunLevel; last_run = $lastRun; registered = $registered; task_state = $task.State; launcher_result = $task.LastTaskResult; legacy_console = $legacy } | ConvertTo-Json -Compress
`;
  let output: string;
  try { output = execFileSync(windowsPowerShell(), ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { cwd: windowsSystemDirectory(), env: windowsPowerShellEnvironment(), encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) {
    if (process.env.CI) {
      const failure = error as Error & { code?: string; status?: number; signal?: string; stderr?: Buffer };
      const phases = failure.stderr?.toString('utf8').match(/startup:(?:entry|encoding|json|object|connected|lookup|registry)/g) ?? [];
      console.error('Startup helper failure', { code: failure.code, status: failure.status, signal: failure.signal, phases });
    }
    // eslint-disable-next-line preserve-caught-error -- Temporary CI diagnosis; keep the public error stable.
    throw new Error('User startup registration failed. Check Task Scheduler permissions and the Continuity task; no elevation or alternate registration was attempted.');
  }
  const result = JSON.parse(output.trim()) as { refused?: string; installed: boolean; name: string; mechanism: string; executable?: string; arguments?: string; current_command?: boolean; enabled?: boolean; logon_type?: number; run_level?: number; last_run?: string | null; registered?: string | null; task_state?: number; launcher_result?: number; legacy_console?: boolean };
  if (result.refused === 'legacy_console') throw new Error(LEGACY_CONSOLE + ' Nothing was installed, and an existing startup task is unchanged; turn the legacy console off (console window properties, Options), or run continuity runtime start.');
  const installedArgs = typeof result.arguments === 'string' ? result.arguments : '';
  const installedPort = installedArgs.match(/"--port" "(\d+)"/)?.[1];
  // A wrapped task quotes Node and then the CLI; an older direct task quotes the CLI first.
  const wrapped = installedArgs.startsWith('--headless ');
  const tokens = [...installedArgs.matchAll(/"([^"]*)"/g)].map(m => m[1]!);
  const node = wrapped ? tokens[0] : result.executable, installedCli = wrapped ? tokens[1] : tokens[0];
  const systemHost = !!systemDirectory && (result.executable ?? '').toLowerCase() === win32.join(systemDirectory, 'conhost.exe').toLowerCase();
  const { launcher_result: launcherResult, task_state: taskState, last_run: lastRun, registered, legacy_console: legacy, ...task } = result;
  const usable = supported && !legacy;
  // Task Scheduler keeps the last run time when a task is replaced; a run from before this registration is not its run.
  const run = lastRun && !(registered && Date.parse(lastRun) < Date.parse(registered)) ? lastRun : null;
  return {
    ...task, home, supported: usable,
    ...(result.installed ? {
      launcher: wrapped && systemHost ? 'conhost --headless' : wrapped ? 'conhost --headless (not the Windows system copy)' : 'direct (opens a console window; run startup install)',
      dashboard: installedPort ? `http://127.0.0.1:${installedPort}` : null,
      executable_available: typeof result.executable === 'string' && existsSync(result.executable) && typeof node === 'string' && existsSync(node),
      installed_cli_available: existsSync(installedCli ?? ''),
      // Task Scheduler reports the console host's exit code, which is 0 even when the runtime failed to start; the
      // start record written by runtime start decides.
      startup_result: taskStartResult(run, taskState === 4, readStart(home)),
      // The console host's exit code of that run; none when the last run belongs to a replaced registration.
      task: { state: taskState, last_run: run, registered: registered ?? null, launcher_result: run ? launcherResult : null },
    } : { dashboard: null, executable_available: true, installed_cli_available: true }),
    ...(!supported ? { unsupported: 'Sign-in startup needs Windows 10 version 1809 (build 17763) or later.' } : legacy ? { unsupported: LEGACY_CONSOLE } : {}),
    ...(action === 'install' ? { message: 'Continuity will start automatically after Windows sign-in, without a window. No browser is opened.' } : {}),
  };
}
const LEGACY_CONSOLE = 'Sign-in startup cannot run without a window while "Use legacy console" is on (HKCU\\Console\\ForceV2 = 0): the console host then refuses to start Continuity.';
