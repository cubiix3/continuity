import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { passages } from '../packages/core/src/context/passages.js';
import type { Resource } from '../packages/core/src/contracts.js';

function resource(content: string): Resource {
  return { id: 'src_fixture', project_id: 'prj_fixture', path: 'docs/example.md', hash: 'version', content,
    kind: 'source', state: 'fresh', provenance: { project_id: 'prj_fixture', origin: 'docs/example.md',
      source_version: 'version', captured_at: '2026-01-01T00:00:00Z', trust: 'authoritative' } };
}

it('preserves UTF-8 boundaries, source lines and content-derived identities at the byte limit', () => {
  const content = 'a'.repeat(2397) + '😀é\n' + '界'.repeat(801);
  const chunks = passages([resource(content)]);
  expect(chunks.map(p => p.text)).toEqual(['a'.repeat(2397), '😀é\n', '界'.repeat(800), '界']);
  expect(chunks.map(p => [p.start_line, p.end_line])).toEqual([[1, 1], [1, 1], [2, 2], [2, 2]]);
  expect(chunks.map(p => p.text).join('')).toBe(content);
  for (const chunk of chunks) {
    expect(Buffer.byteLength(chunk.text)).toBeLessThanOrEqual(2400);
    const digest = createHash('sha256').update(chunk.text).digest('hex');
    expect(chunk.hash).toBe(digest);
    expect(chunk.id).toBe(`psg_${createHash('sha256').update(['prj_fixture', 'docs/example.md', digest, '0'].join('\0')).digest('hex')}`);
  }
});

it('preserves structural and fenced section boundaries and duplicate occurrence identities', () => {
  const chunks = passages([resource('# One\nbody\n```ts\n# not a heading\n```\n# Two\nbody\n# Two\nbody\n')]);
  expect(chunks.map(p => p.text)).toEqual(['# One\nbody\n```ts\n# not a heading\n```\n', '# Two\nbody\n', '# Two\nbody\n']);
  expect(chunks[1]!.hash).toBe(chunks[2]!.hash);
  expect(chunks[1]!.id).not.toBe(chunks[2]!.id);
});
