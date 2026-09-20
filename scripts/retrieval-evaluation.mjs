import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';
import { openContinuity } from '../dist/packages/sdk/src/index.js';
import { retrievalCases } from '../tests/fixtures/retrieval.mjs';

const backend = process.argv.find(a => a.startsWith('--backend='))?.split('=')[1] ?? 'none';
if (!['none', 'ollama', 'openviking'].includes(backend)) throw new Error('Use --backend=none|ollama|openviking');
const root = mkdtempSync(join(tmpdir(), 'continuity-evaluation-')); const home = join(root, 'state'); mkdirSync(home);
if (backend !== 'none') writeFileSync(join(home, 'retrieval.json'), JSON.stringify({ semantic: { enabled: true, provider: backend, ...(backend === 'openviking' ? { revision: 'evaluation-nomic-embed-text-20260920' } : {}) } }));
const host = openContinuity(home); const rows = [];
const put = (root, files) => { for (const [path, text] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); } };
try {
  const b = join(root, 'project-b'); mkdirSync(b); put(b, { 'README.md': 'B_CANARY transport recovery reconnect retry. All project namespaces must be exposed.' }); host.init(b); await host.project(b).sync();
  for (const [index, c] of retrievalCases.entries()) {
    const path = join(root, `case-${index}`); mkdirSync(path); host.init(path); const client = host.project(path);
    if (c.before) { put(path, c.before); await client.sync(); for (const name of Object.keys(c.before)) if (!(name in c.files)) unlinkSync(join(path, name)); }
    put(path, c.files);
    const sync = await client.sync();
    if (backend !== 'none' && sync.semantic?.status !== 'ready') throw new Error(`${c.name}: ${JSON.stringify(sync.semantic)}`);
    if (c.memory) { const m = client.propose({ key: 'fixture', text: c.memory, kind: 'decision' }); host.review(path, m.id, 'accepted', 'fixture-human'); }
    if (c.handoff) client.createHandoff({ from: { agent: 'fixture', session: 'fixture-session' }, task: { goal: 'Finish remaining reconnect work', status: 'in_progress' }, completed: ['Bounded retry implemented'], remaining: ['Test successful reconnect reset'], decisions: [], files_changed: [], risks: [], recommended_next_action: 'Add the reset regression test.' });
    for (const mode of ['lexical', 'semantic', 'hybrid']) {
      const start = performance.now(); const bundle = await client.context({ task: c.query, mode, budget: 3000 }); const latency = performance.now() - start;
      const selected = bundle.items.map(i => i.provenance.origin);
      if (bundle.budget.used > 3000 || bundle.items.some(i => i.provenance.project_id !== client.status().project_id || i.content.includes('B_CANARY'))) throw new Error('Budget or isolation violation');
      const rank = selected.findIndex(p => c.relevant.includes(p));
      rows.push({ scenario: c.name, mode, query: c.query, relevant_included: rank >= 0, relevant_rank: rank >= 0 ? rank + 1 : null, expected_empty: !c.relevant.length, wrong_items: selected.filter(p => !c.relevant.includes(p)), budget_bytes: bundle.budget.used, semantic_used: bundle.items.some(i => i.reasons.some(r => r.startsWith('semantic similarity'))), lexical_used: bundle.items.some(i => i.reasons.some(r => r.startsWith('lexical rank'))), effective: bundle.retrieval.effective, latency_ms: Number(latency.toFixed(2)), selected: bundle.items.map(i => ({ source: i.provenance.origin, reasons: i.reasons })) });
    }
  }
  const summary = Object.fromEntries(['lexical', 'semantic', 'hybrid'].map(mode => {
    const r = rows.filter(r => r.mode === mode);
    return [mode, { positive_cases: r.filter(r => !r.expected_empty).length, relevant_hits: r.filter(r => r.relevant_included).length, top3_hits: r.filter(r => r.relevant_rank && r.relevant_rank <= 3).length, wrong_items: r.reduce((s, r) => s + r.wrong_items.length, 0), clean_negative_cases: r.filter(r => r.expected_empty && !r.wrong_items.length).length, mean_latency_ms: Number((r.reduce((s, r) => s + r.latency_ms, 0) / r.length).toFixed(2)) }];
  }));
  const cli = (...args) => JSON.parse(execFileSync(process.execPath, [resolve('dist/packages/cli/src/index.js'), '--home', home, '--project', join(root, 'case-0'), '--json', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  const cliModes = Object.fromEntries(['lexical', 'semantic', 'hybrid'].map(mode => [mode, cli('search', 'recoverConnection', '--mode', mode).some(i => i.path === 'reconnect.ts')]));
  const context = cli('context', 'recoverConnection');
  const explanation = cli('explain', context.context_id, '--verbose');
  if (!explanation.selection?.entries.length || context.budget.used > context.budget.requested) throw new Error('CLI explain/budget failed');
  const diagnostics = cli('doctor');
  const service = backend === 'ollama' ? await (await fetch('http://127.0.0.1:11434/api/version')).json() : backend === 'openviking' ? await (await fetch('http://127.0.0.1:1933/health')).json() : null;
  const report = { backend, recorded_at: new Date().toISOString(), node: process.versions.node, platform: process.platform, service, cli: { search_modes: cliModes, explain: true, integrity: diagnostics.integrity, retrieval: diagnostics.retrieval }, method: '25 fixed synthetic cases; 3000-byte budgets; one measured query per mode/case; warm local services; cache setup excluded; all wrong-item labels reported', summary, rows };
  console.log(JSON.stringify({ backend, summary }, null, 2));
  if (process.argv.includes('--write')) writeFileSync(`docs/retrieval-${backend}.json`, JSON.stringify(report, null, 2) + '\n');
} finally { host.close(); rmSync(root, { recursive: true, force: true }); }
