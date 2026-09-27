import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:net';
import { readStart, recordStart, taskStartResult, TASK_RUN_WINDOW_MS } from '../packages/sdk/src/start-record.js';
import { startupAction, windowsArgument } from '../packages/sdk/src/startup-windows.js';
import { stopBackground } from '../packages/sdk/src/background.js';

vi.setConfig({ testTimeout: 60_000 });
const cli = resolve('dist/packages/cli/src/index.js');
let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'continuity start ü ')); });
afterEach(async () => { await stopBackground(home).catch(() => undefined); rmSync(home, { recursive: true, force: true }); });

test('the sign-in action is the headless console host running exactly node, the CLI, the home and the port', () => {
  const action = startupAction('C:\\Windows\\System32', 'C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\Zoë Ä\\AppData\\Roaming\\npm\\node_modules\\continuity-local\\dist\\packages\\cli\\src\\index.js', 'c:\\users\\zoë ä\\.continuity', 4783, true);
  expect(action).toEqual({
    executable: 'C:\\Windows\\System32\\conhost.exe',
    arguments: '--headless "C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\Zoë Ä\\AppData\\Roaming\\npm\\node_modules\\continuity-local\\dist\\packages\\cli\\src\\index.js" "--home" "c:\\users\\zoë ä\\.continuity" "runtime" "start" "--port" "4783"',
  });
  expect(startupAction('C:\\Windows\\System32', 'n.exe', 'c.js', 'h', 1, false).arguments).toBe('--headless "n.exe" "c.js" "--home" "h" "runtime" "start" "--port" "1" "--no-auto-sync"');
  // Windows argv quoting: quotes and backslashes that precede them survive, no shell syntax is involved.
  expect(windowsArgument('a b')).toBe('"a b"');
  expect(windowsArgument('C:\\dir\\')).toBe('"C:\\dir\\\\"');
  expect(windowsArgument('say "hi"')).toBe('"say \\"hi\\""');
  expect(windowsArgument('& calc | x')).toBe('"& calc | x"');
});

test('the start record is written atomically, holds no message, and a malformed record reads as none', () => {
  expect(readStart(home)).toBeUndefined();
  const failed = recordStart(home, 'failed', 'runtime_exited', new Date('2026-09-27T10:00:00.000Z'));
  expect(failed).toEqual({ version: 1, at: '2026-09-27T10:00:00.000Z', outcome: 'failed', exit_code: 1, category: 'runtime_exited' });
  expect(readStart(home)).toEqual(failed);
  expect(readdirSync(home).filter(f => f.endsWith('.tmp'))).toEqual([]);
  expect(recordStart(home, 'started')).toMatchObject({ outcome: 'started', exit_code: 0 });
  expect(readStart(home)).not.toHaveProperty('category');
  const file = join(home, 'runtime-start.json');
  for (const bad of ['{', '{"version":2,"at":"2026-09-27T10:00:00Z","outcome":"started","exit_code":0}', '{"version":1,"at":"x","outcome":"started","exit_code":0}',
    '{"version":1,"at":"2026-09-27T10:00:00Z","outcome":"started","exit_code":1}', '{"version":1,"at":"2026-09-27T10:00:00Z","outcome":"failed","exit_code":1}',
    '{"version":1,"at":"2026-09-27T10:00:00Z","outcome":"failed","exit_code":1,"category":"secret text"}', '{"version":1,"at":"2026-09-27T10:00:00Z","outcome":"started","exit_code":0,"category":"error"}']) {
    writeFileSync(file, bad); expect(readStart(home)).toBeUndefined();
  }
});

test('a record that cannot be written changes nothing and leaves no temporary file', () => {
  mkdirSync(join(home, 'runtime-start.json'));
  expect(recordStart(home, 'started')).toMatchObject({ outcome: 'started' });
  expect(readdirSync(home).filter(f => f.endsWith('.tmp'))).toEqual([]);
  expect(readStart(home)).toBeUndefined();
});

test.runIf(process.platform === 'win32')('a record another process holds for a moment is still written (retried rename)', async () => {
  recordStart(home, 'failed', 'error', new Date('2026-01-01T00:00:00.000Z'));
  const file = join(home, 'runtime-start.json'), held = join(home, 'held.flag');
  const script = `$f = [IO.File]::Open(${JSON.stringify(file).replace(/^"|"$/g, "'")}, 'Open', 'ReadWrite', 'None'); Set-Content -LiteralPath ${JSON.stringify(held).replace(/^"|"$/g, "'")} -Value 1; Start-Sleep -Milliseconds 400; $f.Close()`;
  const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: 'ignore' });
  for (let i = 0; i < 200 && !existsSync(held); i++) await new Promise(r => setTimeout(r, 25));
  expect(existsSync(held)).toBe(true);
  const record = recordStart(home, 'started');
  await new Promise(done => holder.on('exit', done));
  expect(readStart(home)).toEqual(record);
  expect(readdirSync(home).filter(f => f.endsWith('.tmp'))).toEqual([]);
});

test('concurrent starts each leave a valid record and no temporary file', async () => {
  const module = pathToFileURL(resolve('dist/packages/sdk/src/start-record.js')).href;
  const writer = `const { recordStart } = await import(${JSON.stringify(module)}); for (let i = 0; i < 100; i++) recordStart(process.argv[1], i % 2 ? 'started' : 'already_running');`;
  const children = Array.from({ length: 4 }, () => spawn(process.execPath, ['--input-type=module', '-e', writer, home], { stdio: 'ignore', windowsHide: true }));
  await Promise.all(children.map(child => new Promise(done => child.on('exit', done))));
  expect(readdirSync(home).filter(f => f.endsWith('.tmp'))).toEqual([]);
  expect(readStart(home)?.outcome).toMatch(/^(started|already_running)$/);
});

test('a record counts only for the task run it belongs to; an older one is never shown as the current result', () => {
  const run = '2026-09-27T10:00:00.000Z', at = (ms: number) => ({ version: 1 as const, at: new Date(Date.parse(run) + ms).toISOString(), outcome: 'failed' as const, exit_code: 1 as const, category: 'start_timeout' as const });
  expect(taskStartResult(null, false, at(500))).toEqual({ state: 'not_run', last_run: null });
  expect(taskStartResult(run, false, at(700))).toEqual({ state: 'failed', last_run: run, at: at(700).at, exit_code: 1, category: 'start_timeout' });
  // Task Scheduler keeps whole seconds: a record up to a second before the stored time belongs to the same run.
  expect(taskStartResult(run, false, at(-900)).state).toBe('failed');
  expect(taskStartResult(run, false, at(-1500)).state).toBe('no_result');
  // An older record (a previous run or a manual start) is not this run's result.
  expect(taskStartResult(run, false, at(-5000))).toEqual({ state: 'no_result', last_run: run });
  expect(taskStartResult(run, true, at(-5000))).toEqual({ state: 'running', last_run: run });
  expect(taskStartResult(run, false, at(TASK_RUN_WINDOW_MS + 1)).state).toBe('no_result');
  expect(taskStartResult(run, false, undefined)).toEqual({ state: 'no_result', last_run: run });
});

test('runtime start records started, already running and each failure category, and still exits non-zero on failure', async () => {
  const run = (...args: string[]) => spawnSync(process.execPath, ['--no-warnings', cli, '--home', home, ...args], { encoding: 'utf8', windowsHide: true, timeout: 45_000 });
  const probe = createServer(); await new Promise<void>(done => probe.listen(0, '127.0.0.1', done));
  const busy = (probe.address() as { port: number }).port;
  try {
    // The runtime cannot bind a port that is taken: it exits, and the start fails.
    const occupied = run('runtime', 'start', '--port', String(busy));
    expect(occupied.status).not.toBe(0);
    expect(readStart(home)).toMatchObject({ outcome: 'failed', exit_code: 1, category: 'runtime_exited' });
  } finally { await new Promise<void>(done => probe.close(() => done())); }
  expect(run('runtime', 'start', '--port', 'x').status).not.toBe(0);
  expect(readStart(home)).toMatchObject({ outcome: 'failed', category: 'invalid_arguments' });
  expect(run('runtime', 'start', '--port', '0').status).toBe(0);
  expect(readStart(home)).toEqual(expect.objectContaining({ outcome: 'started', exit_code: 0 }));
  expect(run('runtime', 'start', '--port', '0').status).toBe(0);
  expect(readStart(home)).toMatchObject({ outcome: 'already_running', exit_code: 0 });
  // Only the fixed fields: no message, path or output.
  expect(Object.keys(JSON.parse(readFileSync(join(home, 'runtime-start.json'), 'utf8'))).sort()).toEqual(['at', 'exit_code', 'outcome', 'version']);
  expect(existsSync(join(home, 'runtime-start.json'))).toBe(true);
});
