import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { openContinuity } from '../../sdk/src/index.js';
import { passages } from '../../core/src/context/passages.js';
import { SourceScopeError } from '../../sdk/src/source-scope.js';

type Host = ReturnType<typeof openContinuity>;
const querySchema = z.object({ project: z.string().max(100).optional(), workspace: z.string().max(100).default(''), kind: z.enum(['handoffs', 'memories', 'contexts', 'sources', 'revisions']).default('handoffs'), limit: z.coerce.number().int().min(1).max(50).default(20), after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0), id: z.string().min(1).max(150).optional(), status: z.enum(['active', 'source_backed', 'agent_learned', 'conflicts', 'accepted', 'proposed', 'needs_attention', 'rejected', 'superseded', 'forgotten']).optional(), source_filter: z.enum(['fresh', 'stale', 'rules', 'docs', 'code']).optional() }).strict();
const writeSchema = z.object({ project: z.string().max(100), workspace: z.string().max(100).default(''), id: z.string().max(150).optional(), decision: z.enum(['accepted', 'rejected']).optional(), by: z.string().trim().min(1).max(100).optional() }).strict();

export function createDashboardServer(host: Host, assetsRoot = new URL('../../dashboard/', import.meta.url)) {
  const capability = randomBytes(32).toString('hex');
  // Overlapping Diagnostics requests share one run, so the doctor's Git concurrency bound holds per server.
  let diagnostics: ReturnType<Host['doctor']> | undefined;
  const doctor = () => diagnostics ??= host.doctor().finally(() => { diagnostics = undefined; });
  const assets = new Map([
    ['/', { type: 'text/html; charset=utf-8', body: readFileSync(new URL('public/index.html', assetsRoot)) }],
    ['/app.css', { type: 'text/css; charset=utf-8', body: readFileSync(new URL('public/app.css', assetsRoot)) }],
    ['/app.js', { type: 'text/javascript; charset=utf-8', body: readFileSync(new URL('src/app.js', assetsRoot)) }],
    ['/favicon.svg', { type: 'image/svg+xml', body: readFileSync(new URL('public/favicon.svg', assetsRoot)) }],
  ]);
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 10000, headersTimeout: 10000 }, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    const send = (status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    const address = server.address();
    if (!address || typeof address === 'string') return send(503, { error: 'Dashboard unavailable.' });
    const origin = new URL(`http://127.0.0.1:${address.port}`).origin;
    const authority = new URL(origin).host;
    if (req.headers.host !== authority || (req.headers.origin !== undefined && req.headers.origin !== origin) || ['cross-site', 'same-site'].includes(String(req.headers['sec-fetch-site']))) return send(403, { error: 'Local same-origin request required.' });
    let url: URL;
    try { url = new URL(req.url ?? '/', origin); }
    catch { return send(400, { error: 'Invalid request URL.' }); }
    if (req.method === 'GET' && assets.has(url.pathname) && !url.search) {
      const asset = assets.get(url.pathname)!; res.writeHead(200, { 'Content-Type': asset.type }); res.end(asset.body); return;
    }
    if (req.method === 'GET' && url.pathname === '/dashboard-api/session' && !url.search && req.headers['x-continuity-dashboard'] === '1') return send(200, { capability, version: '0.1.0' });
    const supplied = req.headers['x-continuity-token'];
    if (typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(capability))) return send(403, { error: 'Dashboard session required. Reload this page.' });
    try {
      if (req.method === 'GET') {
        if (url.pathname === '/dashboard-api/projects') {
          const page = z.object({ after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0), limit: z.coerce.number().int().min(1).max(50).default(50) }).strict().parse(Object.fromEntries(url.searchParams));
          const all = host.projects(); return send(200, { projects: all.slice(page.after, page.after + page.limit), next: all.length > page.after + page.limit ? page.after + page.limit : null });
        }
        // Full diagnostics: Git runs asynchronously, so other Dashboard requests are served meanwhile.
        if (url.pathname === '/dashboard-api/diagnostics' && !url.search) return send(200, await doctor());
        const q = querySchema.parse(Object.fromEntries(url.searchParams));
        if (!q.project) return send(400, { error: 'Select a registered project.' });
        const scope = host.inspection.scope(q.project, q.workspace);
        const client = () => scope.workspace ? host.workspace(scope.project.root, scope.workspace.root) : host.project(scope.project.root);
        if (url.pathname === '/dashboard-api/workspaces') {
          const all = host.inspection.workspaces(q.project);
          return send(200, { project: scope.project, selected: scope.workspace, workspaces: all.slice(q.after, q.after + q.limit), next: all.length > q.after + q.limit ? q.after + q.limit : null });
        }
        if (url.pathname === '/dashboard-api/status') return send(200, client().status());
        if (url.pathname === '/dashboard-api/source-scope') return send(200, host.sourceScope(q.project));
        if (url.pathname === '/dashboard-api/stats') return send(200, host.inspection.stats(q.project, q.workspace));
        // Cheap Overview health for the selected project; the full doctor stays on /diagnostics.
        if (url.pathname === '/dashboard-api/health') return send(200, await host.health(q.project));
        if (url.pathname === '/dashboard-api/retrieval') return send(200, await host.inspectionRetrievalHealth(q.project, q.workspace));
        if (url.pathname === '/dashboard-api/records') {
          if (q.kind === 'sources' && q.id) {
            const preview = host.previewSource(q.project, q.workspace, q.id);
            if (!preview) return send(404, { error: 'Source is no longer available in this workspace. Sync and refresh the list.' });
            return send(200, { ...preview, passages: passages([preview.resource]).map(p => ({ id: p.id, start_line: p.start_line, end_line: p.end_line })) });
          }
          return send(200, host.inspection.page(q.project, q.workspace, q.kind, q.limit, q.after, q.id, q.status, q.source_filter));
        }
        if (url.pathname === '/dashboard-api/selection' && q.id) return send(200, host.inspection.selection(q.project, q.workspace, q.id) ?? null);
      }
      if (req.method === 'POST' && ['/dashboard-api/review', '/dashboard-api/forget', '/dashboard-api/sync'].includes(url.pathname) && !url.search) {
        if (req.headers.origin !== origin || req.headers['content-type'] !== 'application/json') return send(403, { error: 'Same-origin JSON write required.' });
        const chunks: Buffer[] = []; let bytes = 0;
        for await (const chunk of req) { const data = Buffer.from(chunk as Uint8Array); bytes += data.length; if (bytes > 4096) return send(413, { error: 'Request too large.' }); chunks.push(data); }
        const input = writeSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        const scope = host.inspection.scope(input.project, input.workspace);
        if (url.pathname === '/dashboard-api/forget') {
          if (!input.id || input.decision || input.by) return send(400, { error: 'A memory ID is required.' });
          return send(200, host.project(scope.project.root).forget(input.id));
        }
        if (url.pathname === '/dashboard-api/review') {
          if (!input.id || !input.decision || !input.by) return send(400, { error: 'Memory, decision and reviewer are required.' });
          try { return send(200, host.review(scope.project.root, input.id, input.decision, input.by)); }
          catch { return send(409, { error: 'Review could not be applied. Only pending memories can be reviewed; an accepted key may conflict. Refresh the memory and review its history.' }); }
        }
        return send(200, await (scope.workspace ? host.workspace(scope.project.root, scope.workspace.root) : host.project(scope.project.root)).sync());
      }
      send(404, { error: 'Dashboard route not found.' });
    } catch (error) {
      if (error instanceof SourceScopeError) return send(409, { error: error.message });
      send(error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 409, { error: error instanceof z.ZodError || error instanceof SyntaxError ? 'Invalid dashboard request.' : 'Registration, workspace or record is unavailable. Run diagnostics; source previews require a current accessible workspace.' });
    }
  });
  return server;
}
