import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const arg = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=') ?? fallback;
const backend = arg('backend', 'none'); const label = arg('label', backend);
if (!['none', 'ollama', 'openviking'].includes(backend) || !/^[a-z0-9-]+$/.test(label)) throw new Error('Invalid backend or label');
const { openContinuity } = await import(pathToFileURL(resolve(arg('sdk', 'dist/packages/sdk/src/index.js'))).href);
const results = [];
for (const count of arg('sizes', '100,1000,10000').split(',').map(Number)) {
  if (![100, 1000, 10000].includes(count)) throw new Error('Supported sizes: 100,1000,10000');
  const root = mkdtempSync(join(tmpdir(), 'continuity-perf-')); const path = join(root, 'project'); const home = join(root, 'state'); mkdirSync(path); mkdirSync(home);
  const resources = Math.min(count, 1000); const sections = count / resources;
  for (let i = 0; i < resources; i++) writeFileSync(join(path, `resource-${i}.md`), Array.from({ length: sections }, (_, j) => `# Recovery ${i * sections + j}\nComponent ${i * sections + j} calls recoverConnection${i * sections + j} after transport failures. Bounded retries and exponential backoff prevent duplicate reconnect managers.\n`).join(''));
  if (backend !== 'none') writeFileSync(join(home, 'retrieval.json'), JSON.stringify({ semantic: { enabled: true, provider: backend, ...(backend === 'openviking' ? { revision: 'performance-nomic-20260920' } : {}) } }));
  const host = openContinuity(home); host.init(path); const client = host.project(path);
  async function sync() {
    const start = performance.now(); const attempts = [];
    // Explicit benchmark work, not CLI retries: preserve and resume completed index batches.
    for (let attempt = 0; attempt < 4; attempt++) {
      const result = await client.sync(); attempts.push(result.semantic ?? { status: 'disabled' });
      if (backend === 'none' || result.semantic?.status === 'ready') return { completed: true, ms: Number((performance.now() - start).toFixed(2)), attempts };
      const health = await client.retrievalHealth();
      console.error(`${label} ${count}: ${health.indexed ?? 0}/${health.total ?? count} indexed; ${result.semantic?.reason}`);
      if (health.status === 'unavailable' || !health.indexed) return { completed: false, ms: Number((performance.now() - start).toFixed(2)), attempts, indexed: health.indexed ?? 0, total: health.total ?? count, reason: 'Backend unavailable or no indexing progress; remaining measurements skipped' };
    }
    const health = await client.retrievalHealth();
    return { completed: false, ms: Number((performance.now() - start).toFixed(2)), attempts, indexed: health.indexed, total: health.total, reason: 'Four bounded sync calls exhausted; remaining measurements skipped' };
  }
  try {
    const first_sync = await sync(); let unchanged_sync = null; let single_file_update = null; let incremental_ten_files = null;
    if (first_sync.completed) {
      unchanged_sync = await sync();
      const one = join(path, 'resource-0.md'); writeFileSync(one, readFileSync(one, 'utf8').replace('Component 0', 'Updated component 0'));
      single_file_update = await sync();
      for (let i = 1; i <= 10; i++) { const file = join(path, `resource-${i}.md`); writeFileSync(file, readFileSync(file, 'utf8').replace('Component ', 'Incrementally updated component ')); }
      incremental_ten_files = await sync();
    }
    const query_ms = []; const effective_modes = [];
    for (let i = 0; i < 5; i++) { const start = performance.now(); const bundle = await client.context({ task: 'recoverConnection42', budget: 6000 }); query_ms.push(Number((performance.now() - start).toFixed(2))); effective_modes.push(bundle.retrieval?.effective ?? 'lexical'); }
    host.close();
    const storage_bytes = ['continuity.db', 'continuity.db-wal', 'continuity.db-shm'].reduce((n, f) => n + (existsSync(join(home, f)) ? statSync(join(home, f)).size : 0), 0);
    const row = { resources, passages: count, first_sync, unchanged_sync, single_file_update, incremental_ten_files, query_ms, effective_modes, storage_bytes, storage_note: backend === 'openviking' ? 'Continuity manifest only; service storage not included' : 'SQLite after close, including embeddings and five context bundles' };
    results.push(row); console.log(JSON.stringify({ backend, passages: count, first_completed: first_sync.completed, first_ms: first_sync.ms, unchanged_ms: unchanged_sync?.ms, update_ms: single_file_update?.ms, query_ms, effective_modes, storage_bytes }));
  } finally { host.close(); rmSync(root, { recursive: true, force: true }); }
}
if (process.argv.includes('--write')) writeFileSync(`docs/performance-${label}.json`, JSON.stringify({ backend, recorded_at: new Date().toISOString(), node: process.versions.node, platform: process.platform, method: 'Wall time; same generated content per size; warm service; five queries; at most four 30s bounded sync calls explicitly resumed; incomplete runs reported, not discarded; incremental phase edits ten files', results }, null, 2) + '\n');
