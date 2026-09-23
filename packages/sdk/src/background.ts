import { createServer } from 'node:net';
import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { openContinuity } from './index.js';
import { continuityHome, exchange, ipcAddress } from './local-ipc.js';
import type { AutoSync } from './auto-sync.js';
import { createDashboardServer } from '../../server/src/dashboard.js';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export async function runtimeRequest(home: string, command = 'status') {
  home = continuityHome(home);
  let token: string;
  try { const value = JSON.parse(readFileSync(join(home, 'runtime.key'), 'utf8')) as { token: string }; token = value.token; }
  catch { return { running: false }; }
  try { return await exchange(ipcAddress(home, 'runtime'), { token, command }) as Record<string, unknown>; }
  catch (error) { if (['ECONNREFUSED', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) return { running: false }; throw error; }
}
export async function startBackground(home: string, cli: string, port = 4783, autoSync = true) {
  home = continuityHome(home); const existing = await runtimeRequest(home); if (existing.running) return { ...existing, message: 'Continuity is already running.' };
  const child = spawn(process.execPath, [cli, '--home', home, 'runtime', 'run', '--port', String(port), ...(!autoSync ? ['--no-auto-sync'] : [])], { detached: true, windowsHide: true, stdio: 'ignore' });
  let failure: Error | undefined; child.on('error', error => { failure = error; }); child.unref();
  for (let i = 0; i < 100; i++) { await delay(100); if (failure) throw failure; const status = await runtimeRequest(home); if (status.running) return status; if (child.exitCode !== null) break; }
  throw new Error('Runtime did not start. Port may be occupied; inspect logs/runtime.log or run continuity runtime run.');
}
export async function stopBackground(home: string) {
  const response = await runtimeRequest(home, 'stop');
  if (!response.stopping) return response;
  for (let i = 0; i < 90; i++) { await delay(500); if (!(await runtimeRequest(home)).running) return { running: false, stopped: true }; }
  throw new Error('Runtime is still finishing its current sync. No process was forcibly terminated.');
}
export async function runBackground(home: string, port = 4783, autoSync = true) {
  home = continuityHome(home);
  const token = randomBytes(32).toString('hex'), started = new Date().toISOString();
  const logs = join(home, 'logs'); mkdirSync(logs, { recursive: true });
  const log = (event: string, id?: string) => {
    try { const file = join(logs, 'runtime.log'); if (existsSync(file) && statSync(file).size > 256 * 1024) { rmSync(file + '.1', { force: true }); renameSync(file, file + '.1'); } appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), event, ...(id ? { scope: id } : {}) }) + '\n'); } catch { /* An unwritable log must not reset or replace user state. */ }
  };
  let host: ReturnType<typeof openContinuity> | undefined, worker: Worker | undefined, dashboard: ReturnType<typeof createDashboardServer> | undefined;
  let syncState: ReturnType<AutoSync['status']> | undefined, workerState = autoSync ? 'starting' : 'disabled';
  let workerExit: Promise<void> | undefined;
  let stopping = false, url = '';
  const control = createServer(socket => {
    let data = ''; socket.setTimeout(5000, () => socket.destroy()); socket.on('error', () => {});
    socket.on('data', chunk => {
      data += chunk.toString(); if (data.length > 4096) { socket.destroy(); return; } if (!data.includes('\n')) return;
      try {
        const input = JSON.parse(data.split('\n')[0]!) as { token?: string; command?: string };
        if (input.token !== token) { socket.end('{"error":"Runtime authentication failed."}\n'); return; }
        if (input.command === 'status') socket.end(JSON.stringify({ running: !!url, stopping, pid: process.pid, dashboard: url, started, home, auto_sync: autoSync, sync_worker: workerState, registered_projects: host?.projects().length ?? 0, ...syncState }) + '\n');
        else if (input.command === 'stop') { socket.end('{"stopping":true}\n'); setImmediate(() => { void stop(); }); }
        else socket.end('{"error":"Unknown runtime command."}\n');
      } catch { socket.destroy(); }
    });
  });
  const stop = async () => {
    if (stopping) return; stopping = true; log('runtime stopping'); worker?.postMessage('stop'); await workerExit;
    dashboard?.closeAllConnections(); if (dashboard?.listening) await new Promise<void>(resolve => dashboard!.close(() => resolve()));
    await new Promise<void>(resolve => control.close(() => resolve())); host?.close();
    try { if (JSON.parse(readFileSync(join(home, 'runtime.key'), 'utf8')).token === token) rmSync(join(home, 'runtime.key')); } catch { /* Do not remove another owner's state. */ }
    process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal);
  };
  const onSignal = () => { void stop(); };
  try { await new Promise<void>((resolve, reject) => { control.once('error', reject); control.listen(ipcAddress(home, 'runtime'), resolve); }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new Error('Continuity is already running for this home.', { cause: error }); throw error; }
  try {
    host = openContinuity(home); dashboard = createDashboardServer(host);
    await new Promise<void>((resolve, reject) => { dashboard!.once('error', reject); dashboard!.listen(port, '127.0.0.1', resolve); });
    const address = dashboard.address(); url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : port}`;
    writeFileSync(join(home, 'runtime.key'), JSON.stringify({ token }), { mode: 0o600 });
    process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
    if (autoSync) {
      worker = new Worker(new URL('./auto-sync-worker.js', import.meta.url), { workerData: home });
      workerExit = new Promise(resolve => worker!.once('exit', () => { workerState = stopping ? 'stopped' : 'unavailable'; resolve(); }));
      worker.on('error', () => { workerState = 'unavailable'; log('auto-sync worker failed; restart runtime to retry'); });
      worker.on('message', (message: { status?: ReturnType<AutoSync['status']>; event?: string; id?: string }) => {
        if (message.status) { syncState = message.status; workerState = 'active'; }
        if (message.event) log(message.event, message.id);
      });
    }
    log('runtime started'); console.error(`Continuity background runtime listening on ${url}`);
    return { stop, status: () => syncState, url };
  } catch (error) { log('runtime startup failed'); await stop(); if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new Error(`Dashboard port ${port} is occupied. Stop the existing dashboard or choose --port.`, { cause: error }); throw error; }
}
