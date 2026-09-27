import { autosaveEnabled } from '../../adapter-hooks/src/autosave.js';
import { insideGit, SHELL_TOOLS } from '../../adapter-hooks/src/shell.js';

/**
 * Claude Code calls the PostToolUse hook after every shell command, and most change nothing (#34). A Bash call in a
 * Git tree whose own report lists no change is answered here, before the CLI loads, and so is any call in a session
 * where autosave is off (the hook would do nothing). Everything else continues in main.js, which takes the input read here.
 */
const LIMIT = 1024 * 1024;
let buffered: string | undefined, oversized = false;
/** The hook input already read from stdin, if any. */
export const readHookInput = () => ({ text: buffered, oversized });

export async function quietToolUse(argv: readonly string[]): Promise<boolean> {
  const args = argv.slice(2);
  if (args.at(-3) !== 'integrate' || args.at(-2) !== 'claude' || args.at(-1) !== 'tool-use') return false;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += (chunk as Buffer).length;
    // Oversized input is ignored by the hook anyway.
    if (size > LIMIT) { oversized = true; return true; }
    chunks.push(chunk as Buffer);
  }
  buffered = Buffer.concat(chunks).toString('utf8');
  // The input is always read in full first, so the provider never writes into a closed pipe.
  if (!autosaveEnabled('claude')) return true;
  try {
    const input = JSON.parse(buffered) as { tool_name?: unknown; cwd?: unknown; tool_response?: { bashEditDiff?: { changedFiles?: unknown; moreFiles?: unknown } } };
    if (typeof input.tool_name !== 'string' || !SHELL_TOOLS.has(input.tool_name)) return false;
    const diff = input.tool_response?.bashEditDiff;
    if ((Array.isArray(diff?.changedFiles) && diff.changedFiles.length > 0) || (typeof diff?.moreFiles === 'number' && diff.moreFiles > 0)) return false;
    // Without Git the report is always empty, and PowerShell never reports: those need the bounded check in main.js.
    return input.tool_name === 'Bash' && typeof input.cwd === 'string' && input.cwd.length > 0 && input.cwd.length < 4096 && insideGit(input.cwd);
  } catch { return false; }
}
