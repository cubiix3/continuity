import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Embedding, EmbeddingCache, SemanticHealth, SemanticRetrievalPort, SemanticScope } from '../../core/src/contracts.js';
import { localEndpoint, requestJson } from './http.js';

const tagsSchema = z.object({ models: z.array(z.object({ name: z.string(), digest: z.string().min(1) })) });
const vectorsSchema = z.object({ embeddings: z.array(z.array(z.number().finite()).min(1).max(8192)).max(32) });
function normalize(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, n) => sum + n * n, 0));
  if (!Number.isFinite(norm) || norm === 0) throw new Error('Invalid embedding norm');
  return vector.map(n => n / norm);
}
export class OllamaRetrieval implements SemanticRetrievalPort {
  private readonly endpoint: string;
  constructor(private readonly cache: EmbeddingCache, endpoint = 'http://127.0.0.1:11434', private readonly model = 'nomic-embed-text', private readonly documentPrefix = model.split(':')[0] === 'nomic-embed-text' ? 'search_document: ' : '', private readonly queryPrefix = model.split(':')[0] === 'nomic-embed-text' ? 'search_query: ' : '') {
    this.endpoint = localEndpoint(endpoint);
  }
  private async identity(signal: AbortSignal) {
    const tags = tagsSchema.parse(await requestJson(this.endpoint, '/api/tags', signal));
    const name = this.model.includes(':') ? this.model : `${this.model}:latest`;
    const tag = tags.models.find(m => m.name === name);
    if (!tag) throw new Error('Configured embedding model is not installed; download it explicitly with Ollama.');
    return createHash('sha256').update(JSON.stringify(['ollama-v1', this.endpoint, tag.name, tag.digest, this.documentPrefix, this.queryPrefix])).digest('hex');
  }
  private async embed(texts: string[], signal: AbortSignal): Promise<number[][]> {
    const result = vectorsSchema.parse(await requestJson(this.endpoint, '/api/embed', signal, { model: this.model, input: texts, truncate: false }));
    if (result.embeddings.length !== texts.length || new Set(result.embeddings.map(v => v.length)).size !== 1) throw new Error('Malformed embedding count or dimensions');
    return result.embeddings.map(normalize);
  }
  async index(scope: SemanticScope, signal: AbortSignal): Promise<SemanticHealth> {
    const model = await this.identity(signal);
    const old = new Map(this.cache.read(model).map(e => [e.passage_id, e]));
    const entries: Embedding[] = []; const missing = [];
    for (const p of scope.passages) {
      const cached = old.get(p.id);
      if (cached?.hash === p.hash) entries.push({ ...cached, resource_id: p.resource_id, source_hash: p.source_hash });
      else missing.push(p);
    }
    for (let n = 0; n < missing.length; n += 32) {
      signal.throwIfAborted();
      const batch = missing.slice(n, n + 32);
      const vectors = await this.embed(batch.map(p => this.documentPrefix + p.path + '\n' + p.text), signal);
      if (entries[0] && vectors.some(v => v.length !== entries[0]!.vector.length)) throw new Error('Embedding dimensions changed without a model revision');
      const completed = batch.map((p, i) => ({ passage_id: p.id, source_hash: p.source_hash, resource_id: p.resource_id, hash: p.hash, vector: vectors[i]! }));
      if (await this.identity(signal) !== model) throw new Error('Embedding model changed during indexing');
      this.cache.replace(model, completed, false);
      entries.push(...completed);
    }
    const dimensions = entries[0]?.vector.length;
    if (new Set(entries.map(e => e.vector.length)).size > 1) throw new Error('Embedding dimensions changed; select a new model revision.');
    if (await this.identity(signal) !== model) throw new Error('Embedding model changed during indexing');
    this.cache.replace(model, entries);
    return { status: 'ready', reason: `Embedded ${missing.length}; reused ${entries.length - missing.length} passages`, model: this.model, ...(dimensions ? { dimensions } : {}), indexed: entries.length, total: scope.passages.length };
  }
  private current(scope: SemanticScope, model: string) {
    const allowed = new Map(scope.passages.map(p => [p.id, p]));
    return this.cache.read(model).filter(e => { const p = allowed.get(e.passage_id); return p && p.hash === e.hash && p.source_hash === e.source_hash && p.resource_id === e.resource_id; });
  }
  async health(scope: SemanticScope, signal: AbortSignal): Promise<SemanticHealth> {
    const entries = this.current(scope, await this.identity(signal));
    const dimensions = entries[0]?.vector.length;
    if (new Set(entries.map(e => e.vector.length)).size > 1 || entries.some(e => e.vector.some(n => !Number.isFinite(n)))) throw new Error('Invalid cached embedding dimensions or values');
    return { status: entries.length === scope.passages.length ? 'ready' : 'incomplete', reason: entries.length === scope.passages.length ? 'Index current' : 'Run continuity sync to refresh embeddings', model: this.model, ...(dimensions ? { dimensions } : {}), indexed: entries.length, total: scope.passages.length };
  }
  async search(scope: SemanticScope, task: string, signal: AbortSignal) {
    const model = await this.identity(signal);
    const entries = this.current(scope, model);
    if (entries.length !== scope.passages.length) throw new Error('Semantic index incomplete; run continuity sync');
    if (!entries.length) return [];
    const [query] = await this.embed([this.queryPrefix + task], signal);
    if (entries.some(e => e.vector.length !== query!.length)) throw new Error('Embedding dimensions incompatible');
    if (await this.identity(signal) !== model) throw new Error('Embedding model changed during search');
    return entries.map(e => {
      const vector = normalize(e.vector);
      return { passage_id: e.passage_id, similarity: vector.reduce((sum, n, i) => sum + n * query![i]!, 0) };
    }).filter(c => c.similarity >= 0.5).sort((a, b) => b.similarity - a.similarity || a.passage_id.localeCompare(b.passage_id)).slice(0, 100);
  }
}
