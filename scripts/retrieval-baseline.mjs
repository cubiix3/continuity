import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openContinuity } from '../dist/packages/sdk/src/index.js';

const cases = [
  { name: 'exact symbol', query: 'recoverConnection', relevant: 'reconnect.ts', files: { 'reconnect.ts': 'export function recoverConnection() { return "bounded retry"; }', 'noise.md': 'Connection metrics dashboard.' } },
  { name: 'architecture decision', query: 'single reconnect manager', relevant: 'decision.md', files: { 'decision.md': 'Architecture decision: reuse a single reconnect manager.', 'noise.md': 'Use a manager for UI layout.' } },
  { name: 'wording variation', query: 'restore dropped transport', relevant: 'decision.md', files: { 'decision.md': 'Reconnect recovery reuses bounded retries.', 'noise.md': 'Storage persistence and snapshots.' } },
  { name: 'outdated source', query: 'reconnect legacy', relevant: 'decision.md', replace: true, files: { 'decision.md': 'Reconnect uses the legacy manager.' } },
  { name: 'conflicting source', query: 'reconnect manager', relevant: 'decision.md', files: { 'decision.md': 'Reconnect must reuse one manager.', 'contradiction.md': 'Reconnect must create a second manager.' } },
  { name: 'common generic terms', query: 'fix state recovery', relevant: 'reconnect.md', files: { 'reconnect.md': 'Reconnect recovery updates state.', 'noise.md': 'Fix page state after navigation.' } },
  { name: 'similarly named files', query: 'bounded retry', relevant: 'reconnect.md', files: { 'reconnect.md': 'Bounded retry is required.', 'reconnect-old.md': 'Connection screens use blue labels.' } },
  { name: 'irrelevant large document', query: 'bounded retry', relevant: 'reconnect.md', files: { 'reconnect.md': 'Bounded retry is required.', 'large.md': 'Documentation about typography and spacing.\n'.repeat(1200) } },
];
const root = mkdtempSync(join(tmpdir(), 'continuity-baseline-'));
const host = openContinuity(join(root, 'state'));
try {
  const results = await Promise.all(cases.map(async (c, index) => {
    const path = join(root, String(index)); mkdirSync(path);
    for (const [name, content] of Object.entries(c.files)) writeFileSync(join(path, name), content);
    host.init(path); const client = host.project(path); (await client.sync());
    if (c.replace) writeFileSync(join(path, 'decision.md'), 'Reconnect uses the current bounded strategy.');
    const bundle = (await client.context({ task: c.query, budget: 3000 }));
    const included = bundle.items.map(i => i.provenance.origin);
    if (bundle.budget.used > 3000 || (c.replace && bundle.items.some(i => i.content.includes('legacy')))) throw new Error('Baseline violated budget/freshness');
    return { scenario: c.name, query: c.query, relevant_included: included.includes(c.relevant), wrong_items: included.filter(p => p !== c.relevant), budget_bytes: bundle.budget.used, selected: bundle.items.map(i => ({ source: i.provenance.origin, reasons: i.reasons })) };
  }));
  const report = { method: 'FTS5/BM25; eight synthetic fixtures; 3000-byte bundles; no embeddings', results };
  console.log(JSON.stringify(report, null, 2));
  if (process.argv.includes('--write')) writeFileSync('docs/retrieval-baseline.json', JSON.stringify(report, null, 2) + '\n');
} finally { host.close(); rmSync(root, { recursive: true, force: true }); }
