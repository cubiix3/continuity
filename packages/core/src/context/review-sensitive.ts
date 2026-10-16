import { looksSensitive } from '../security/sensitive.js';
import { formatReviewText } from './review-text.js';

/** Check original records and each emitted projection before summaries are clipped. */
export function reviewTextLooksSensitive(...fields: string[]): boolean {
  if ([...fields, fields.join('\n')].some(looksSensitive)) return true;
  const formatted = fields.map(formatReviewText);
  return [...formatted, formatted.join('\n')].some(looksSensitive);
}
