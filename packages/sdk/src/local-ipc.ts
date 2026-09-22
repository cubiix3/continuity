import { createHash, createHmac, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { mkdirSync, realpathSync, readFileSync, writeFileSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createConnection, createServer, type Socket } from 'node:net';

async function syncKey(home: string) {
  const file = join(home, 'sync.key');
  try { writeFileSync(file, randomBytes(32), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  // Another process may have just created the file and still be writing its key.
  for (let i = 0; i < 10; i++) {
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('Unsafe sync key file.');
    const key = readFileSync(file); if (key.length === 32) return key;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Invalid local sync key.');
}

export function continuityHome(home = process.env.CONTINUITY_HOME ?? join(homedir(), '.continuity')) {
  mkdirSync(resolve(home), { recursive: true });
  const path = realpathSync.native(resolve(home));
  return process.platform === 'win32' ? path.toLowerCase() : path;
}
export function ipcAddress(home: string, purpose: string) {
  const id = createHash('sha256').update(`${home}\0${purpose}`).digest('hex');
  if (process.platform === 'win32') return `\\\\.\\pipe\\continuity-${id}`;
  if (process.platform === 'linux') return `\0continuity-${id}`;
  throw new Error('Background coordination is supported on Windows and Linux.');
}
export function exchange(address: string, input: unknown, timeout = 5000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(address); let data = '';
    socket.setTimeout(timeout, () => socket.destroy(new Error('Local runtime did not respond.')));
    socket.once('connect', () => socket.write(JSON.stringify(input) + '\n'));
    socket.on('error', reject);
    socket.on('data', chunk => {
      data += chunk.toString();
      if (Buffer.byteLength(data) > 1024 * 1024) { socket.destroy(new Error('Local response exceeds limit.')); return; }
      if (data.includes('\n')) { socket.destroy(); try { resolve(JSON.parse(data.split('\n')[0]!)); } catch { reject(new Error('Invalid local response.')); } }
    });
    socket.once('end', () => { if (!data.includes('\n')) reject(new Error('Local runtime closed without a response.')); });
  });
}

/** OS-owned lease; concurrent CLI/dashboard syncs share one completed result. No PID-based recovery. */
export async function coordinatedSync<T>(home: string, key: string, run: () => Promise<T>, attempt = 0): Promise<T> {
  if (!['win32', 'linux'].includes(process.platform)) return run();
  const secret = await syncKey(home);
  const proof = (text: string) => createHmac('sha256', secret).update(`${key}:${text}`).digest('hex');
  const address = ipcAddress(home, `sync:${key}`), clients = new Map<Socket, string>();
  let response: { ok: boolean; value?: T } = { ok: false }, completed = false;
  const reply = (socket: Socket, nonce: string) => { if (!socket.writableEnded) socket.end(JSON.stringify({ result: response, proof: proof(`response:${nonce}:${JSON.stringify(response)}`) }) + '\n'); };
  const server = createServer(socket => {
    let data = ''; socket.setTimeout(45000, () => socket.destroy()); socket.on('error', () => {}); socket.on('close', () => clients.delete(socket));
    socket.on('data', chunk => {
      data += chunk.toString(); if (data.length > 1024) { socket.destroy(); return; } if (!data.includes('\n')) return;
      try {
        const request = JSON.parse(data.split('\n')[0]!) as { nonce?: string; proof?: string };
        if (typeof request.nonce !== 'string' || request.proof !== proof(`request:${request.nonce}`)) { socket.destroy(); return; }
        clients.set(socket, request.nonce);
        if (completed) reply(socket, request.nonce);
      } catch { socket.destroy(); }
    });
  });
  try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(address, resolve); }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    try {
      const nonce = randomBytes(16).toString('hex');
      const envelope = await exchange(address, { nonce, proof: proof(`request:${nonce}`) }, 45000) as { result: { ok: boolean; value: T }; proof: string };
      if (envelope.proof !== proof(`response:${nonce}:${JSON.stringify(envelope.result)}`)) throw new Error('Local sync authentication failed.', { cause: error });
      const result = envelope.result;
      if (!result.ok) throw new Error('Concurrent source sync failed; retry sync.', { cause: error });
      return result.value;
    } catch (error) {
      if (attempt < 3 && ['ECONNREFUSED', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) return coordinatedSync(home, key, run, attempt + 1);
      throw error;
    }
  }
  try { const value = await run(); response = { ok: true, value }; return value; }
  finally {
    completed = true;
    // Let queued connects reach the lease before releasing it, including synchronous FTS syncs.
    await new Promise<void>(resolve => setImmediate(resolve));
    for (const [socket, nonce] of clients) reply(socket, nonce);
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
