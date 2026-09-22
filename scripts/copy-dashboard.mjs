import { cpSync, mkdirSync } from 'node:fs';
import { URL } from 'node:url';
const destination = new URL('../dist/packages/dashboard/public/', import.meta.url);
mkdirSync(destination, { recursive: true });
cpSync(new URL('../packages/dashboard/public/', import.meta.url), destination, { recursive: true });
