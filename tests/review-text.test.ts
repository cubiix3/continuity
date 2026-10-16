import { expect, test } from 'vitest';
import { formatReviewText, parseReviewText, reviewHeading, reviewLocation } from '../packages/core/src/context/review-text.js';

const finding = '::code-comment{title="[P1] Client input becomes a format string" body="Use DirectQueryRaw for a completed query." file="D:/project/source/input_unique.cpp" start=159 end=167 priority=1 confidence=0.97}';

test('review text exposes priority, title, compact location and explanation', () => {
  const parts = parseReviewText(finding), review = parts[0]!;
  expect(parts).toHaveLength(1);
  expect(review.type).toBe('review');
  if (review.type !== 'review') throw new Error('Expected review');
  expect(review.title).toBe('Client input becomes a format string');
  expect(reviewHeading(review)).toBe('[P1] Client input becomes a format string');
  expect(reviewLocation(review)).toBe('input_unique.cpp:159-167');
  expect(review.raw).toBe(finding);
  const text = formatReviewText(finding);
  expect(text).toBe('[P1] Client input becomes a format string\ninput_unique.cpp:159-167\nUse DirectQueryRaw for a completed query.');
  expect(text).not.toMatch(/::code-comment|confidence=|priority=|D:\//);
});

test('multiple findings preserve surrounding prose and their input order', () => {
  const input = `Review results:\n\n${finding}\n\nKeep the existing API.\n\n${finding.replaceAll('input_unique.cpp', 'input.cpp')}`;
  const result = formatReviewText(input);
  expect(parseReviewText(input).filter(p => p.type === 'review')).toHaveLength(2);
  expect(result).toContain('Review results:'); expect(result).toContain('Keep the existing API.');
  expect(result.indexOf('input_unique.cpp')).toBeLessThan(result.indexOf('input.cpp'));
});

test('quoted braces, Unicode, escaped quotes and Windows separators stay literal', () => {
  const input = String.raw`::code-comment{title="[P2] Prüfe \"{input}\"" body="Keep { braces }, C:\\temp\\file and a newline\nvisible." file="D:\project\source\input.cpp" start=12 end=12 priority=2}`;
  const review = parseReviewText(input)[0]!;
  expect(review.type).toBe('review');
  if (review.type !== 'review') throw new Error('Expected review');
  expect(review.title).toBe('Prüfe "{input}"');
  expect(review.body).toBe('Keep { braces }, C:\\temp\\file and a newline\nvisible.');
  expect(reviewLocation(review)).toBe('input.cpp:12');
});

test('multiline attributes and bodies remain readable without interpreting markup', () => {
  const input = '::code-comment{\n title="[P0] Check input"\n body="<script>alert(1)</script>\nUse `bounded_read`."\n priority=0\n}';
  expect(formatReviewText(input)).toBe('[P0] Check input\n<script>alert(1)</script>\nUse `bounded_read`.');
});

test('missing optional metadata does not invent a priority or location', () => {
  expect(formatReviewText('::code-comment{title="Check input" body="Bound the received bytes."}')).toBe('Check input\nBound the received bytes.');
  expect(formatReviewText('::code-comment{title="[P3] Check input" body="Bound the received bytes."}')).toBe('[P3] Check input\nBound the received bytes.');
});

test('conflicting priority labels are retained rather than silently discarded', () => {
  expect(formatReviewText('::code-comment{title="[P2] Check input" body="Bound the received bytes." priority=1}')).toContain('[P1] [P2] Check input');
});

test.each([
  '::code-comment{title="Unfinished" body="No closing quote}',
  '::code-comment{title="No body"}',
  '::code-comment{title="Wrong type" body=1}',
  '::code-comment{title="Duplicate" title="Other" body="Keep the original."}',
  '::code-comment{title="Bad priority" body="Keep the original." priority=8}',
  '::code-comment{title="Bad range" body="Keep the original." start=12 end=2}',
  '::code-comment{title="Bad range" body="Keep the original." start=0}',
  '::code-comment{title="Bad confidence" body="Keep the original." confidence=2}',
  '::code-comment{title="Unknown metadata" body="Keep the original." action="execute"}',
  '::unknown{title="Unknown" body="Keep the original."}',
])('malformed or unknown markup stays verbatim: %s', input => {
  expect(formatReviewText(input)).toBe(input);
  expect(parseReviewText(input)).toEqual([{ type: 'text', text: input }]);
});

test('a malformed directive does not consume the next valid finding', () => {
  const input = `::code-comment{invalid}\n\n${finding}`;
  expect(formatReviewText(input)).toContain('::code-comment{invalid}');
  expect(parseReviewText(input).filter(p => p.type === 'review')).toHaveLength(1);
});

test.each(['::code-comment{title="Unfinished', '::code-comment{title="Unfinished" body="Open body'])('an unfinished quote does not swallow the next finding: %s', broken => {
  const input = `${broken}\n${finding}`;
  expect(parseReviewText(input).filter(p => p.type === 'review')).toHaveLength(1);
  expect(formatReviewText(input)).toContain(broken);
});

test('Windows paths retain separators that look like string escapes', () => {
  const input = String.raw`::code-comment{title="Check file" body="Use the bounded reader." file="C:\new\test.ts"}`;
  const review = parseReviewText(input)[0]!;
  if (review.type !== 'review') throw new Error('Expected review');
  expect(review.file).toBe(String.raw`C:\new\test.ts`);
  expect(reviewLocation(review)).toBe('test.ts');
});

test('a quoted annotation example belongs to its outer finding', () => {
  const input = '::code-comment{title="Check documentation" body="Keep this example literal:\n::code-comment{title=\\"Example\\" body=\\"Quoted text\\"}\nUse plain text."}';
  const parts = parseReviewText(input);
  expect(parts).toHaveLength(1);
  expect(parts[0]).toMatchObject({ type: 'review', title: 'Check documentation', body: 'Keep this example literal:\n::code-comment{title="Example" body="Quoted text"}\nUse plain text.' });
});

test('shorter or different fence markers do not close a literal example', () => {
  const literal = `\`\`\`\`text\n\`\`\`\n${finding}\n~~~\n\`\`\`\``;
  expect(formatReviewText(literal)).toBe(literal);
  expect(parseReviewText(`${literal}\n${finding}`).filter(p => p.type === 'review')).toHaveLength(1);
});

test('fenced and inline code examples remain exact while actual findings render', () => {
  for (const fence of ['```', '~~~~']) {
    const literal = `${fence}text\n${finding}\n${fence}`;
    expect(formatReviewText(literal)).toBe(literal);
    expect(parseReviewText(`${literal}\n\n${finding}`).filter(p => p.type === 'review')).toHaveLength(1);
  }
  for (const ticks of ['`', '``']) expect(formatReviewText(`${ticks}${finding}${ticks}`)).toBe(`${ticks}${finding}${ticks}`);
  expect(formatReviewText(`\\${finding}`)).toBe(`\\${finding}`);
});

test.each(['```', '````'])('a line-start %s code span does not hide later findings', ticks => {
  const literal = `${ticks}example${ticks}\n\n`;
  expect(parseReviewText(`${literal}${finding}`)).toEqual([{ type: 'text', text: literal }, expect.objectContaining({ type: 'review', raw: finding })]);
  expect(formatReviewText(`${literal}${finding}`)).toContain(`${literal}\n[P1]`);
});

test.each(['    ', '\t', ' \t', '   \t', '        '])('indented code examples remain exact with %j indentation', indentation => {
  const input = `${indentation}${finding}`;
  expect(parseReviewText(input)).toEqual([{ type: 'text', text: input }]);
  expect(formatReviewText(input)).toBe(input);
});

test.each(['\n', '\r\n'])('indented code blocks end before a real finding with %j line endings', newline => {
  const literal = [`    ${finding}`, '', `\t${finding}`, '', ''].join(newline);
  const parts = parseReviewText(`${literal}${finding}`);
  expect(parts).toEqual([{ type: 'text', text: literal }, expect.objectContaining({ type: 'review', raw: finding })]);
});

test.each(['    ', '\t'])('indented fence markers do not open a fenced block with %j indentation', indentation => {
  const literal = `${indentation}\`\`\`text\n${indentation}${finding}\n\n`;
  expect(parseReviewText(`${literal}${finding}`)).toEqual([{ type: 'text', text: literal }, expect.objectContaining({ type: 'review', raw: finding })]);
});

test.each(['', ' ', '  ', '   '])('real findings still render with %j indentation', indentation => {
  const parts = parseReviewText(`${indentation}${finding}`);
  expect(parts.filter(part => part.type === 'review')).toEqual([expect.objectContaining({ raw: finding })]);
  expect(formatReviewText(`${indentation}${finding}`)).not.toContain('::code-comment');
});

test('malformed quote recovery preserves the indentation of the next code example', () => {
  const input = `::code-comment{title="Unfinished\n    ${finding}`;
  expect(parseReviewText(input)).toEqual([{ type: 'text', text: input }]);
  expect(formatReviewText(input)).toBe(input);
});

test('plain text and unfinished code fences stay exact', () => {
  for (const input of ['', 'Regular text.\n\nKeep spacing.  ', `\`\`\`text\n${finding}`]) expect(formatReviewText(input)).toBe(input);
});
