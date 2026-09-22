import { test, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { startupRegistration } from '../packages/sdk/src/startup-windows.js';
import { runtimeRequest, stopBackground } from '../packages/sdk/src/background.js';

test('user startup registration is isolated, idempotent, launches exact argv and removes cleanly', async () => {
  const home = mkdtempSync(join(tmpdir(), 'continuity startup ü ')), cli = resolve('dist/packages/cli/src/index.js');
  if (process.platform !== 'win32') {
    try { expect(() => startupRegistration('install', home, cli)).toThrow('not implemented'); } finally { rmSync(home, { recursive: true, force: true }); } return;
  }
  const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve)); const address = probe.address(); if (!address || typeof address === 'string') throw new Error('address'); const port = address.port; await new Promise<void>(resolve => probe.close(() => resolve()));
  try {
    expect(startupRegistration('status', home, cli).installed).toBe(false);
    const first = startupRegistration('install', home, cli, port, false), again = startupRegistration('install', home, cli, port, false);
    expect(first.name).toBe(again.name); expect(again.current_command).toBe(true);
    expect(startupRegistration('status', home, cli).dashboard).toBe(`http://127.0.0.1:${port}`);
    execFileSync('schtasks.exe', ['/Run', '/TN', String(first.name)], { windowsHide: true, stdio: 'pipe' });
    let status: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) { status = await runtimeRequest(home); if (status.running) break; await new Promise(resolve => setTimeout(resolve, 100)); }
    expect(status.running).toBe(true); expect(status.auto_sync).toBe(false); expect(status.dashboard).toBe(`http://127.0.0.1:${port}`);
    const response = await fetch(String(status.dashboard)); expect(response.status).toBe(200); await response.text();
    await stopBackground(home);
    const stale = startupRegistration('install', home, join(home, 'missing cli.js'), port); expect(stale.installed_cli_available).toBe(false);
    expect(startupRegistration('install', home, cli, port).installed_cli_available).toBe(true);
    expect(startupRegistration('remove', home, cli).installed).toBe(false);
    expect(startupRegistration('remove', home, cli).installed).toBe(false);
    expect(startupRegistration('status', home, cli).installed).toBe(false);
  } finally { await stopBackground(home); startupRegistration('remove', home, cli); rmSync(home, { recursive: true, force: true }); }
}, 30000);
