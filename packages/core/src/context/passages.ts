import { createHash } from 'node:crypto';
import type { Passage, Resource } from '../contracts.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export class PassageLimitError extends Error {
  constructor() { super('Passage limit exceeded (20,000). Exclude overly fragmented sources.'); }
}
/** Prefer Markdown sections and top-level declarations; bound oversized units by lines. */
export function passages(resources: readonly Resource[], structuralBoundaries = true): Passage[] {
  const result: Passage[] = [];
  for (const r of resources.filter(r => r.state === 'fresh')) {
    const lines = r.content.split('\n');
    let start = 0; let text = ''; let textBytes = 0; let fenced = false;
    const occurrences = new Map<string, number>();
    const emit = (end: number) => {
      if (!text.trim()) return;
      if (result.length >= 20000) throw new PassageLimitError();
      const digest = hash(text); const occurrence = occurrences.get(digest) ?? 0;
      occurrences.set(digest, occurrence + 1);
      const identity = `${r.project_id}\0${r.path}\0${digest}\0${occurrence}`;
      result.push({ id: `psg_${hash(r.provenance.workspace_id ? `${identity}\0${r.provenance.workspace_id}` : identity)}`, project_id: r.project_id, resource_id: r.id, source_hash: r.hash, hash: digest, path: r.path, text, start_line: start + 1, end_line: end + 1 });
    };
    for (let n = 0; n < lines.length; n++) {
      const line = lines[n]!;
      const boundary = structuralBoundaries && !fenced && (/^#{1,6} /.test(line) || /^(?:export\s+)?(?:async\s+)?(?:function |class |interface |def |fn |pub fn )/.test(line));
      if (text && (boundary || textBytes + Buffer.byteLength(line) > 2400)) { emit(n - 1); text = ''; textBytes = 0; start = n; }
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      // Even minified code and long prose lines remain bounded, without splitting UTF-8.
      for (const character of line + (n < lines.length - 1 ? '\n' : '')) {
        const characterBytes = Buffer.byteLength(character);
        if (textBytes + characterBytes > 2400) { emit(n); text = ''; textBytes = 0; start = n; }
        text += character;
        textBytes += characterBytes;
      }
    }
    emit(lines.length - 1);
  }
  return result;
}
