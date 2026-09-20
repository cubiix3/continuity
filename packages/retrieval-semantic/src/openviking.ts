import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { RemoteResourceCache, SemanticHealth, SemanticRetrievalPort, SemanticScope } from '../../core/src/contracts.js';
import { localEndpoint, requestJson } from './http.js';

const healthSchema = z.object({ healthy: z.literal(true), version: z.literal('0.4.20') });
const searchSchema = z.object({ status: z.literal('ok'), result: z.object({ resources: z.array(z.object({ uri: z.string(), score: z.number().finite() })).max(100) }) });
/** OpenViking 0.4.20 find: URI predicates are pushed into vector retrieval, not post-filtered. */
export class OpenVikingRetrieval implements SemanticRetrievalPort {
  private readonly endpoint: string;
  private readonly backend: string;
  constructor(private readonly cache: RemoteResourceCache, endpoint: string, revision: string) {
    this.endpoint = localEndpoint(endpoint);
    if (!revision.trim()) throw new Error('OpenViking requires an explicit embedding/index revision');
    this.backend = createHash('sha256').update(JSON.stringify(['openviking-0.4.20-v1', this.endpoint, revision])).digest('hex');
  }
  private uri(scope: SemanticScope, id: string) {
    if (!/^prj_[a-z0-9-]+$/.test(scope.project_id) || !/^psg_[a-f0-9]{64}$/.test(id)) throw new Error('Invalid semantic resource identity');
    return `viking://resources/continuity/${scope.project_id}/${this.backend}/${id}.txt`;
  }
  private async check(signal: AbortSignal) { healthSchema.parse(await requestJson(this.endpoint, '/health', signal)); }
  async index(scope: SemanticScope, signal: AbortSignal): Promise<SemanticHealth> {
    await this.check(signal);
    const old = new Map(this.cache.read(this.backend).map(e => [e.passage_id, e]));
    const entries = []; let changed = 0;
    for (const p of scope.passages) {
      const uri = this.uri(scope, p.id);
      if (old.get(p.id)?.uri !== uri) {
        let mode = 'replace';
        try { await requestJson(this.endpoint, `/api/v1/fs/stat?uri=${encodeURIComponent(uri)}`, signal); }
        catch (error) { if (error instanceof Error && error.message === 'Backend HTTP 404') mode = 'create'; else throw error; }
        const response = await requestJson(this.endpoint, '/api/v1/content/write', signal, { uri, content: p.path + '\n' + p.text, mode, processing_mode: 'vectors_only', wait: true, timeout: 10, telemetry: false });
        z.object({ status: z.literal('ok'), result: z.object({ vector_status: z.literal('complete') }) }).parse(response);
        changed++;
      }
      const entry = { passage_id: p.id, resource_id: p.resource_id, source_hash: p.source_hash, uri };
      if (old.get(p.id)?.resource_id !== p.resource_id || old.get(p.id)?.source_hash !== p.source_hash || old.get(p.id)?.uri !== uri) this.cache.replace(this.backend, [entry], false);
      entries.push(entry);
    }
    this.cache.replace(this.backend, entries);
    return { status: 'ready', reason: `Indexed ${changed}; reused ${entries.length - changed} passages`, indexed: entries.length, total: scope.passages.length };
  }
  private current(scope: SemanticScope) {
    const allowed = new Map(scope.passages.map(p => [p.id, p]));
    return this.cache.read(this.backend).filter(e => {
      const p = allowed.get(e.passage_id);
      return p && p.source_hash === e.source_hash && p.resource_id === e.resource_id && e.uri === this.uri(scope, p.id);
    });
  }
  async health(scope: SemanticScope, signal: AbortSignal): Promise<SemanticHealth> {
    await this.check(signal); const entries = this.current(scope);
    return { status: entries.length === scope.passages.length ? 'ready' : 'incomplete', reason: 'Local manifest; remote index uses the operator-specified revision', indexed: entries.length, total: scope.passages.length };
  }
  async search(scope: SemanticScope, task: string, signal: AbortSignal) {
    await this.check(signal);
    const entries = this.current(scope);
    if (entries.length !== scope.passages.length) throw new Error('Semantic index incomplete; run continuity sync');
    if (!entries.length) return [];
    const allowed = new Map(entries.map(e => [e.uri, e.passage_id]));
    // Exact authorized leaf URIs, never an empty/global scope or user-provided URI.
    const response = searchSchema.parse(await requestJson(this.endpoint, '/api/v1/search/find', signal, { query: task, target_uri: [...allowed.keys()], context_type: 'resource', level: 2, limit: 100, score_threshold: 0.5, telemetry: false }));
    if (response.result.resources.some(r => !allowed.has(r.uri))) throw new Error('Backend returned an unauthorized resource');
    return response.result.resources.filter(r => r.score >= 0.5).map(r => ({ passage_id: allowed.get(r.uri)!, similarity: r.score }));
  }
}
