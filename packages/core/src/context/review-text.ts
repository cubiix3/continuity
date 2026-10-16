export interface ReviewComment {
  type: 'review'; title: string; body: string; raw: string;
  file?: string; start?: number; end?: number; priority?: 0 | 1 | 2 | 3;
}
export type ReviewTextPart = { type: 'text'; text: string } | ReviewComment;

const marker = '::code-comment{';
const attributes = new Set(['title', 'body', 'file', 'start', 'end', 'priority', 'confidence']);

function readReview(text: string, from: number): { end: number; review?: ReviewComment } {
  let at = from + marker.length;
  let recovery: number | undefined;
  const failed = (end: number) => ({ end: recovery ?? end });
  const fields: Record<string, string | number> = {};
  while (at < text.length) {
    while (/\s/.test(text[at] ?? '') && at < text.length) at++;
    if (text[at] === '}') {
      const { title, body, file, start, end, priority, confidence } = fields;
      const line = (value: unknown) => value === undefined || (typeof value === 'number' && Number.isSafeInteger(value) && value > 0);
      if (typeof title !== 'string' || !title.trim() || typeof body !== 'string' || !body.trim()
        || (file !== undefined && (typeof file !== 'string' || !file.trim()))
        || !line(start) || !line(end) || (end !== undefined && (start === undefined || end < start))
        || (priority !== undefined && (typeof priority !== 'number' || !Number.isInteger(priority) || priority < 0 || priority > 3))
        || (confidence !== undefined && (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1))) return failed(at + 1);
      const prefix = /^\[P([0-3])\]\s*/.exec(title.trim());
      const level = priority ?? (prefix ? Number(prefix[1]) : undefined);
      const review: ReviewComment = { type: 'review', title: prefix && Number(prefix[1]) === level ? title.trim().slice(prefix[0].length) : title.trim(), body, raw: text.slice(from, at + 1) };
      if (file !== undefined) review.file = String(file);
      if (start !== undefined) review.start = Number(start);
      if (end !== undefined) review.end = Number(end);
      if (level !== undefined) review.priority = level as 0 | 1 | 2 | 3;
      return { end: at + 1, review };
    }
    const key = /^[a-z_]+/i.exec(text.slice(at))?.[0];
    if (!key) return failed(at);
    at += key.length;
    if (!attributes.has(key) || Object.hasOwn(fields, key)) return failed(at);
    while (/\s/.test(text[at] ?? '') && at < text.length) at++;
    if (text[at++] !== '=') return failed(at);
    while (/\s/.test(text[at] ?? '') && at < text.length) at++;
    if (text[at] === '"') {
      let value = '', closed = false; at++;
      while (at < text.length) {
        // Recover here only if the outer annotation is malformed; quoted examples remain literal.
        if (text.startsWith(marker, at) && !text.slice(text.lastIndexOf('\n', at - 1) + 1, at).trim()) recovery ??= at;
        const char = text[at++]!;
        if (char === '"') { closed = true; break; }
        if (char !== '\\' || at === text.length) { value += char; continue; }
        const escaped = text[at++]!;
        if (escaped === '"' || escaped === '\\') value += escaped;
        else if (key !== 'file' && ['n', 'r', 't'].includes(escaped)) value += { n: '\n', r: '\r', t: '\t' }[escaped];
        else if (key !== 'file' && escaped === 'u' && /^[a-f\d]{4}$/i.test(text.slice(at, at + 4))) { value += String.fromCharCode(parseInt(text.slice(at, at + 4), 16)); at += 4; }
        else value += '\\' + escaped;
      }
      if (!closed) return failed(at);
      fields[key] = value;
    } else {
      const token = /^[^\s}]+/.exec(text.slice(at))?.[0];
      if (!token) return failed(at);
      at += token.length;
      if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(token)) return failed(at);
      fields[key] = Number(token);
    }
    if (text[at] !== '}' && !/\s/.test(text[at] ?? '')) return failed(at);
  }
  return failed(at);
}

/** Read display annotations as data; literal code examples and malformed annotations stay untouched. */
export function parseReviewText(text: string): ReviewTextPart[] {
  const parts: ReviewTextPart[] = [];
  let at = 0, plain = 0, fence = '', fenceLength = 0;
  while (at < text.length) {
    if (at === 0 || text[at - 1] === '\n') {
      const next = text.indexOf('\n', at), lineEnd = next < 0 ? text.length : next;
      const opening = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/.exec(text.slice(at, lineEnd));
      if (opening && (!fence || (opening[1]![0] === fence && opening[1]!.length >= fenceLength && !opening[2]!.trim()))) {
        if (fence) { fence = ''; fenceLength = 0; }
        else { fence = opening[1]![0]!; fenceLength = opening[1]!.length; }
        at = lineEnd + 1; continue;
      }
      if (fence) { at = lineEnd + 1; continue; }
    }
    if (text[at] === '\\') { at += 2; continue; }
    if (text[at] === '`') {
      let run = 1; while (text[at + run] === '`') run++;
      const ticks = '`'.repeat(run);
      let close = text.indexOf(ticks, at + run);
      while (close >= 0 && (text[close - 1] === '`' || text[close + run] === '`')) close = text.indexOf(ticks, close + run);
      if (close >= 0) { at = close + run; continue; }
      at += run; continue;
    }
    if (!text.startsWith(marker, at)) { at++; continue; }
    const read = readReview(text, at);
    if (read.review) {
      if (plain < at) parts.push({ type: 'text', text: text.slice(plain, at) });
      parts.push(read.review); plain = read.end;
    }
    at = Math.max(read.end, at + marker.length);
  }
  if (plain < text.length || !parts.length) parts.push({ type: 'text', text: text.slice(plain) });
  return parts;
}

export function reviewHeading(review: ReviewComment): string {
  return `${review.priority === undefined ? '' : `[P${review.priority}] `}${review.title}`;
}
export function reviewLocation(review: ReviewComment): string {
  if (!review.file) return '';
  const file = review.file.split(/[\\/]/).filter(Boolean).at(-1) ?? review.file;
  return file + (review.start === undefined ? '' : `:${review.start}${review.end !== undefined && review.end !== review.start ? `-${review.end}` : ''}`);
}
export function formatReviewText(text: string): string {
  const parts = parseReviewText(text);
  return parts.map((part, index) => part.type === 'text' ? part.text
    : `${index ? '\n' : ''}${[reviewHeading(part), reviewLocation(part), part.body].filter(Boolean).join('\n')}${index < parts.length - 1 ? '\n' : ''}`).join('');
}
