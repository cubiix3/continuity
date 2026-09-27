#!/usr/bin/env node
import { quietToolUse } from './quiet.js';

// A shell command that changed nothing needs none of the CLI (#34); everything else loads it.
if (!(await quietToolUse(process.argv))) await import('./main.js');
