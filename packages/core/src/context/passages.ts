import { createHash } from 'node:crypto';
import type { Passage, Resource } from '../contracts.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
/** Prefer Markdown sections and top-level declarations; bound oversized units by lines. */
export function passages(resources: readonly Resource[]): Passage[] {
  const result: Passage[] = [];
  for (const r of resources.filter(r => r.state === 'fresh')) {
    const lines = r.content.split('\n');
    let start = 0; let text = ''; let fenced = false;
    const occurrences = new Map<string, number>();
    const emit = (end: number) => {
      if (!text.trim()) return;
      const digest = hash(text); const occurrence = occurrences.get(digest) ?? 0;
      occurrences.set(digest, occurrence + 1);
      result.push({ id: `psg_${hash(`${r.project_id}\0${r.path}\0${digest}\0${occurrence}`)}`, project_id: r.project_id, resource_id: r.id, source_hash: r.hash, hash: digest, path: r.path, text, start_line: start + 1, end_line: end + 1 });
    };
    for (let n = 0; n < lines.length; n++) {
      const line = lines[n]!;
      const boundary = !fenced && (/^#{1,6} /.test(line) || /^(?:export\s+)?(?:async\s+)?(?:function |class |interface |def |fn |pub fn )/.test(line));
      if (text && (boundary || Buffer.byteLength(text + line) > 2400)) { emit(n - 1); text = ''; start = n; }
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      // Even minified code and long prose lines remain bounded, without splitting UTF-8.
      for (const character of line + (n < lines.length - 1 ? '\n' : '')) {
        if (Buffer.byteLength(text + character) > 2400) { emit(n); text = ''; start = n; }
        text += character;
      }
    }
    emit(lines.length - 1);
  }
  return result;
}
