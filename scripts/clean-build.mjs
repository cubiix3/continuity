import { rmSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

// Fixed repository-owned output only: tsc does not remove obsolete compiled modules.
rmSync(fileURLToPath(new URL('../dist/', import.meta.url)), { recursive: true, force: true });
