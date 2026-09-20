/** Optional backends are local HTTP services. Redirects cannot move project text elsewhere. */
export function localEndpoint(input: string): string {
  const url = new URL(input);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Semantic endpoint must be a loopback HTTP origin.');
  return url.origin;
}
export async function requestJson(endpoint: string, path: string, signal: AbortSignal, body?: unknown): Promise<unknown> {
  const response = await fetch(endpoint + path, { signal, redirect: 'error', ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Backend HTTP ${response.status}`); }
  if (!response.body) throw new Error('Empty backend response');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 8 * 1024 * 1024) throw new Error('Backend response exceeds 8 MiB');
      chunks.push(chunk.value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
    catch (error) {
      // JSON parser errors can echo backend content. Never expose that text in a bundle.
      if (error instanceof SyntaxError) throw new Error('Malformed semantic backend response', { cause: error });
      throw error;
    }
  } finally { await reader.cancel(); }
}
