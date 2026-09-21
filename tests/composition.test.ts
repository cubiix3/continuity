import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openContinuity } from '../packages/sdk/src/index.js';
import { compositionOrder } from '../packages/core/src/context/composition.js';
import type { ContextItem } from '../packages/core/src/contracts.js';

let root: string;
let host: ReturnType<typeof openContinuity>;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'continuity-composition-')); });
afterEach(() => { host?.close(); rmSync(root, { recursive: true, force: true }); });

it('uses source diversity only when the host opts in, preserving rules, provenance and budget', async () => {
  const project = join(root, 'project'), foreign = join(root, 'foreign');
  mkdirSync(project); mkdirSync(foreign);
  writeFileSync(join(project, 'AGENTS.md'), 'Always preserve project isolation.');
  writeFileSync(join(project, 'README.md'), Array.from({ length: 8 }, (_, n) => `# Recovery ${n}\nReconnect recovery ${'retry '.repeat(160)}\n`).join(''));
  writeFileSync(join(project, 'other.ts'), 'export const recoverConnection = () => "reconnect DISTINCT_EVIDENCE";');
  writeFileSync(join(foreign, 'README.md'), 'Reconnect FOREIGN_CANARY');
  const home = join(root, 'state');
  host = openContinuity(home); host.init(project); host.init(foreign);
  await host.project(foreign).sync();
  const before = await host.project(project).context({ task: 'reconnect recovery', budget: 6000 });
  host.close(); host = openContinuity(home, { composition: 'source-diversity' });
  const client = host.project(project);
  const after = await client.context({ task: 'reconnect recovery', budget: 6000 });
  expect(after.items.some(i => i.content.includes('DISTINCT_EVIDENCE'))).toBe(true);
  expect(before.items.some(i => i.content.includes('DISTINCT_EVIDENCE'))).toBe(false);
  expect(after.items.filter(i => i.kind === 'rule').map(i => i.content)).toEqual(before.items.filter(i => i.kind === 'rule').map(i => i.content));
  expect(after.items.every(i => i.provenance.project_id === after.project_id)).toBe(true);
  expect(JSON.stringify(after)).not.toContain('FOREIGN_CANARY');
  expect(Buffer.byteLength(JSON.stringify(after))).toBe(after.budget.used);
  expect(after.budget.used).toBeLessThanOrEqual(6000);
  expect(client.explain(after.context_id, true).selection?.entries.some(e => e.composition?.pass === 'additional')).toBe(true);
  await expect(client.context({ task: 'reconnect', budget: 512 })).rejects.toThrow('Mandatory project rules');
  await expect(client.context({ task: 'reconnect', composition: 'flat' } as never)).rejects.toThrow();
  writeFileSync(join(project, 'other.ts'), 'export const recoverConnection = () => "reconnect CURRENT_VERSION";');
  const fresh = await client.context({ task: 'reconnect recovery', budget: 6000 });
  expect(JSON.stringify(fresh)).not.toContain('DISTINCT_EVIDENCE');
  expect(JSON.stringify(fresh)).toContain('CURRENT_VERSION');
});

it('keeps explicit path passages ahead of diversity and preserves original rank within each pass', () => {
  const item = (id: string, path: string, explicit = false): ContextItem => ({ id, kind: 'source', content: id,
    passage: { path, start_line: 1, end_line: 1 }, provenance: { project_id: 'prj_test', origin: path, trust: 'authoritative', captured_at: '', source_version: 'v1' },
    reasons: explicit ? ['explicit source path requested'] : [] });
  const entries = [item('a1', 'a'), item('a2', 'a'), item('b1', 'b'), item('b2', 'b'), item('x1', 'x', true), item('x2', 'x', true)];
  expect(compositionOrder(entries, 'flat').map(e => e.item.id)).toEqual(entries.map(e => e.id));
  expect(compositionOrder(entries, 'source-diversity').map(e => e.item.id)).toEqual(['x1', 'x2', 'a1', 'b1', 'a2', 'b2']);
  expect(entries.map(e => e.id)).toEqual(['a1', 'a2', 'b1', 'b2', 'x1', 'x2']);
});
