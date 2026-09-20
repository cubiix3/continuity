import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { contextRequestSchema, handoffInputSchema, memoryCandidateSchema } from '../../core/src/contracts.js';
import type { ProjectClient } from '../../core/src/index.js';

/** One server, one host-selected project. Token is supplied by the trusted local host. */
export function createLocalServer(client: ProjectClient, token: string) {
  if (token.length < 32) throw new Error('Local API token must contain at least 32 characters.');
  return createServer({ requestTimeout: 10000, headersTimeout: 10000, maxHeaderSize: 8192 }, async (req, res) => {
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(data));
    };
    const supplied = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (req.headers.origin || !/^127\.0\.0\.1(?::\d+)?$/.test(req.headers.host ?? '')) { send(403, { error: 'Local non-browser clients only.' }); return; }
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { send(401, { error: 'Bearer token required.' }); return; }
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.search) { send(400, { error: 'Query parameters are not supported.' }); return; }
      if (req.method === 'GET') {
        if (url.pathname === '/v1/health') { send(200, { schema_version: 1, status: 'ok' }); return; }
        if (url.pathname === '/v1/diagnostics') { send(200, { ...client.doctor(), retrieval: await client.retrievalHealth() }); return; }
        if (url.pathname === '/v1/projects') { const p = client.status(); send(200, [{ project_id: p.project_id, name: p.name }]); return; }
        if (url.pathname === '/v1/handoffs/latest') { send(200, client.latestHandoff()); return; }
        if (/^\/v1\/memory\/mem_[a-z0-9-]+$/.test(url.pathname)) {
          const memory = client.memories().find(m => m.id === url.pathname.split('/').at(-1));
          send(memory ? 200 : 404, memory ?? { error: 'Memory not found in this project.' }); return;
        }
      }
      if (req.method === 'POST') {
        if (req.headers['content-type']?.split(';')[0] !== 'application/json') { send(415, { error: 'Use application/json.' }); return; }
        let size = 0; const chunks: Buffer[] = [];
        for await (const chunk of req) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
          size += bytes.length;
          if (size > 65536) { send(413, { error: 'Request exceeds 64 KiB.' }); return; }
          chunks.push(bytes);
        }
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (url.pathname === '/v1/context') { send(200, await client.context(contextRequestSchema.parse(body))); return; }
        if (url.pathname === '/v1/memory/propose') { send(200, client.propose(memoryCandidateSchema.parse(body))); return; }
        if (url.pathname === '/v1/handoffs') { send(201, client.createHandoff(handoffInputSchema.parse(body))); return; }
        if (url.pathname === '/v1/sync') { z.object({}).strict().parse(body); send(200, await client.sync()); return; }
      }
      send(404, { error: 'Unknown v1 endpoint.' });
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError) send(400, { error: 'Invalid request. See the v1 schemas in docs/adapters.md.' });
      else send(500, { error: 'Local operation failed. Run continuity doctor and continuity sync.' });
    }
  });
}
