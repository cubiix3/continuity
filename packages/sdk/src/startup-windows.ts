import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { continuityHome } from './local-ipc.js';

/** Windows argv quoting, not shell interpolation. Task Scheduler launches the executable directly. */
export function windowsArgument(value: string) { return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"'; }
export function startupName(home: string) { return `Continuity-${createHash('sha256').update(home).digest('hex').slice(0, 24)}`; }
export function startupRegistration(action: 'install' | 'status' | 'remove', home: string, cli: string, port = 4783, autoSync = true) {
  if (process.platform !== 'win32') throw new Error('Automatic startup installation is not implemented on this platform.');
  home = continuityHome(home);
  const name = startupName(home), marker = `Continuity user startup ${name}`;
  const args = [cli, '--home', home, 'runtime', 'start', '--port', String(port), ...(!autoSync ? ['--no-auto-sync'] : [])].map(windowsArgument).join(' ');
  const payload = Buffer.from(JSON.stringify({ action, name, marker, executable: process.execPath, args }), 'utf8').toString('base64');
  // Fixed, versioned adapter logic; dynamic paths cross as JSON data, never PowerShell code.
  const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
$service = New-Object -ComObject Schedule.Service
$service.Connect()
$folder = $service.GetFolder('\\')
$task = $null
try { $task = $folder.GetTask($p.name) } catch { if ($_.Exception.HResult -ne -2147024894) { throw } }
if ($task -and $task.Definition.RegistrationInfo.Description -ne $p.marker) { throw 'Startup name is owned by another registration.' }
if ($p.action -eq 'remove') { if ($task) { $folder.DeleteTask($p.name, 0) }; @{ installed = $false; mechanism = 'Task Scheduler'; name = $p.name } | ConvertTo-Json -Compress; exit }
if ($p.action -eq 'install') {
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $definition = $service.NewTask(0)
  $definition.RegistrationInfo.Description = $p.marker
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
if (!$task) { @{ installed = $false; mechanism = 'Task Scheduler'; name = $p.name } | ConvertTo-Json -Compress; exit }
$entry = $task.Definition.Actions.Item(1)
@{ installed = $true; mechanism = 'Task Scheduler'; name = $p.name; executable = $entry.Path; arguments = $entry.Arguments; current_command = ($entry.Path -eq $p.executable -and $entry.Arguments -eq $p.args); enabled = $task.Enabled } | ConvertTo-Json -Compress
`;
  let output: string;
  try { output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch { throw new Error('User startup registration failed. Check Task Scheduler permissions and the Continuity task; no elevation or alternate registration was attempted.'); }
  const result = JSON.parse(output.trim()) as { installed: boolean; name: string; mechanism: string; executable?: string; arguments?: string; current_command?: boolean; enabled?: boolean };
  const installedArgs = typeof result.arguments === 'string' ? result.arguments : '';
  const installedPort = installedArgs.match(/"--port" "(\d+)"/)?.[1];
  return { ...result, home, dashboard: installedPort ? `http://127.0.0.1:${installedPort}` : null, executable_available: !result.installed || (typeof result.executable === 'string' && existsSync(result.executable)), installed_cli_available: !result.installed || existsSync(installedArgs.match(/^"([^"]+)"/)?.[1] ?? ''), ...(action === 'install' ? { message: 'Continuity will start automatically after Windows sign-in. No browser is opened.' } : {}) };
}
