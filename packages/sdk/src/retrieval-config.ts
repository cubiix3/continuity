import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

const schema = z.object({
  mode: z.enum(['lexical', 'semantic', 'hybrid']).default('hybrid'),
  semantic: z.object({
    enabled: z.boolean().default(false), provider: z.enum(['ollama', 'openviking']).default('ollama'),
    endpoint: z.string().optional(), model: z.string().min(1).max(200).default('nomic-embed-text'),
    revision: z.string().min(1).max(200).optional(),
    document_prefix: z.string().max(200).optional(), query_prefix: z.string().max(200).optional(),
  }).strict().optional(),
}).strict();
/** Trusted per-user configuration. Repository files never enable network access. */
export function retrievalConfig(home: string) {
  const path = join(home, 'retrieval.json');
  if (!existsSync(path)) return schema.parse({});
  const bytes = readFileSync(path);
  if (bytes.length > 8192) throw new Error('Retrieval configuration exceeds 8 KiB');
  return schema.parse(JSON.parse(bytes.toString('utf8')));
}
