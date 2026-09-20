import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer, request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { openContinuity } from '../packages/sdk/src/index.js';
import { GenericAdapter } from '../packages/adapter-generic/src/index.js';
import { createLocalServer } from '../packages/server/src/index.js';

let root: string;
let path: string;
let home: string;
const cli = resolve('dist/packages/cli/src/index.js');
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'continuity-interface-'));
  path = join(root, 'project'); home = join(root, 'state'); mkdirSync(path);
  writeFileSync(join(path, 'AGENTS.md'), 'Reconnect uses bounded retry attempts.');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function run(...args: string[]): unknown {
  return JSON.parse(execFileSync(process.execPath, [cli, '--home', home, '--project', path, '--json', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) as unknown;
}
const handoff = {
  from: { agent: 'generic-a', session: 's1' }, task: { goal: 'Fix reconnect', status: 'in_progress' },
  completed: ['Read source'], remaining: ['Implement retry'], decisions: [], files_changed: [], risks: [], recommended_next_action: 'Write regression test',
};

it('runs the real compiled CLI workflow across processes', async () => {
  expect(run('init')).toMatchObject({ identity_version: 1 });
  expect(run('project', 'list')).toHaveLength(1);
  expect(run('sync')).toMatchObject({ files: 1 });
  expect(run('search', 'reconnect')).toHaveLength(1);
  const context = run('context', 'reconnect', '--role', 'reviewer') as { context_id: string };
  expect(run('inspect', context.context_id)).toMatchObject({ role: 'reviewer' });
  expect(run('explain', context.context_id)).toMatchObject({ historical: true });
  const memory = run('memory', 'remember', 'Reconnect uses bounded retry attempts.', '--key', 'retry', '--source', 'AGENTS.md') as { id: string };
  expect(run('memory', 'show', memory.id)).toMatchObject({ status: 'persist' });
  expect(run('memory', 'forget', memory.id)).toMatchObject({ status: 'forgotten' });
  const handoffPath = join(root, 'handoff.json'); writeFileSync(handoffPath, JSON.stringify(handoff));
  const created = run('handoff', 'create', '--file', handoffPath) as { id: string };
  expect(run('handoff', 'latest')).toMatchObject({ id: created.id });
  expect(run('handoff', 'show', created.id)).toMatchObject({ id: created.id });
  expect(run('doctor')).toMatchObject({ integrity: 'ok', fts5: true });
}, 30000);

it('hands work between generic agent instances', async () => {
  const host = openContinuity(home);
  try {
    host.init(path);
    const a = new GenericAdapter(host.project(path)); const b = new GenericAdapter(host.project(path));
    const created = a.createHandoff(handoff);
    expect(b.latestHandoff()).toEqual(created);
    const items = (await b.context({ task: 'reconnect' })).items;
    expect(items.map(i => i.kind)).toEqual(['rule', 'handoff']);
    expect(items[1]?.id).toBe(created.id);
  } finally { host.close(); }
});

it('serves authenticated localhost HTTP and rejects browser and namespace injection', async () => {
  const host = openContinuity(home); host.init(path);
  const token = 'local-test-token-'.repeat(3);
  const server = createLocalServer(host.project(path), token);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No TCP address');
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  try {
    expect((await fetch(`${base}/v1/health`)).status).toBe(401);
    expect((await fetch(`${base}/v1/health`, { headers })).status).toBe(200);
    expect((await fetch(`${base}/v1/health`, { headers: { ...headers, Origin: 'https://attacker.example' } })).status).toBe(403);
    const forgedHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(`${base}/v1/health`, { headers: { ...headers, Host: 'attacker.example' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject); req.end();
    });
    expect(forgedHostStatus).toBe(403);
    expect((await fetch(`${base}/v1/context`, { method: 'POST', headers, body: JSON.stringify({ task: 'reconnect', project_id: 'forged' }) })).status).toBe(400);
    const context = await fetch(`${base}/v1/context`, { method: 'POST', headers, body: JSON.stringify({ task: 'reconnect' }) });
    expect(await context.json()).toMatchObject({ schema_version: 1, items: [{ kind: 'rule' }] });
    const created = await fetch(`${base}/v1/handoffs`, { method: 'POST', headers, body: JSON.stringify(handoff) });
    expect(created.status).toBe(201);
    expect(await (await fetch(`${base}/v1/handoffs/latest`, { headers })).json()).toMatchObject(handoff);
    expect((await fetch(`${base}/v1/context`, { method: 'POST', headers, body: 'x'.repeat(66000) })).status).toBe(413);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    host.close();
  }
});

it('keeps HTTP diagnostics structured for missing and invalid roots with an unavailable backend', async () => {
  const backend = createServer((_req, res) => { res.writeHead(503).end(); });
  await new Promise<void>(resolve => backend.listen(0, '127.0.0.1', resolve));
  const backendAddress = backend.address();
  if (!backendAddress || typeof backendAddress === 'string') throw new Error('No backend address');
  mkdirSync(home);
  writeFileSync(join(home, 'retrieval.json'), JSON.stringify({ semantic: { enabled: true, provider: 'ollama', endpoint: `http://127.0.0.1:${backendAddress.port}` } }));
  const host = openContinuity(home); host.init(path); const client = host.project(path);
  const token = 'diagnostics-test-token-'.repeat(2); const server = createLocalServer(client, token);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No TCP address');
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  try {
    const availableRoot = await fetch(`${base}/v1/diagnostics`, { headers });
    expect(availableRoot.status).toBe(200);
    expect(await availableRoot.json()).toMatchObject({ integrity: 'ok', fts5: true, retrieval: { status: 'unavailable', reason: 'Backend HTTP 503' } });
    renameSync(path, join(root, 'moved-project'));
    for (const state of ['missing', 'file']) {
      if (state === 'file') writeFileSync(path, 'This is no longer a project directory.');
      const diagnostic = await fetch(`${base}/v1/diagnostics`, { headers });
      expect(diagnostic.status).toBe(200);
      expect(await diagnostic.json()).toMatchObject({ integrity: 'ok', fts5: true, retrieval: { status: 'unavailable', reason: expect.stringMatching(/ENOENT|ENOTDIR/) } });
      const context = await fetch(`${base}/v1/context`, { method: 'POST', headers, body: JSON.stringify({ task: 'reconnect' }) });
      expect(context.status).toBe(500);
      expect(await context.json()).toEqual({ error: 'Local operation failed. Run continuity doctor and continuity sync.' });
    }
    expect((await fetch(`${base}/v1/diagnostics`)).status).toBe(401);
    const doctor = vi.spyOn(client, 'doctor').mockImplementation(() => { throw new Error('Storage failed'); });
    try { expect((await fetch(`${base}/v1/diagnostics`, { headers })).status).toBe(500); }
    finally { doctor.mockRestore(); }
  } finally {
    server.closeAllConnections(); backend.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => backend.close(() => resolve()))]);
    host.close();
  }
});

it('exposes six scoped tools over a real MCP stdio connection', async () => {
  run('init');
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, '--home', home, '--project', path, 'mcp'], stderr: 'pipe' });
  const client = new Client({ name: 'continuity-test-agent', version: '1.0.0' });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(6);
    const observed = await client.callTool({ name: 'continuity_observe', arguments: { text: 'Reconnect tests passed', agent: 'test', session: 'mcp-session' } });
    expect(observed.isError).not.toBe(true);
    expect(observed.structuredContent).toMatchObject({ result: { text: 'Reconnect tests passed', provenance: { trust: 'agent_observation', source_version: 'mcp-session' } } });
    for (const args of [{ text: '', agent: 'test', session: 's' }, { text: 'x'.repeat(4001), agent: 'test', session: 's' }, { text: 'valid', agent: 'test', session: 's', project_id: 'foreign' }, { text: 'valid', agent: 'test', session: 's', trust: 'authoritative' }]) {
      expect((await client.callTool({ name: 'continuity_observe', arguments: args })).isError).toBe(true);
    }
    const host = openContinuity(home);
    try {
      expect(host.retention(path).classes.find(c => c.name === 'observations')?.records).toBe(1);
      expect(host.project(path).memories()).toEqual([]);
    } finally { host.close(); }
    const context = await client.callTool({ name: 'continuity_context', arguments: { task: 'reconnect' } });
    expect(context.isError).not.toBe(true);
    expect(JSON.stringify(context)).toContain('bounded retry');
    const search = await client.callTool({ name: 'continuity_search', arguments: { query: 'reconnect', mode: 'semantic' } });
    expect(search.isError).not.toBe(true);
    expect(JSON.stringify(search)).toContain('Semantic disabled; FTS5 active');
    expect((await client.callTool({ name: 'continuity_search', arguments: { query: 'reconnect', mode: 'global' } })).isError).toBe(true);
    const forged = await client.callTool({ name: 'continuity_context', arguments: { task: 'reconnect', project_id: 'forged' } });
    expect(forged.isError).toBe(true);
    for (const args of [{ task: 'x'.repeat(2001) }, { task: 'reconnect', budget: -1 }, { task: 'reconnect', trust: 'authoritative' }, { task: 42 }]) {
      expect((await client.callTool({ name: 'continuity_context', arguments: args })).isError).toBe(true);
    }
    expect(tools.tools.some(t => /approve|rebind|forget|reject/.test(t.name))).toBe(false);
    const created = await client.callTool({ name: 'continuity_handoff_create', arguments: handoff });
    expect(created.isError).not.toBe(true);
    const latest = await client.callTool({ name: 'continuity_handoff_latest', arguments: {} });
    expect(JSON.stringify(latest)).toContain('Write regression test');
  } finally { await client.close(); }
}, 15000);
