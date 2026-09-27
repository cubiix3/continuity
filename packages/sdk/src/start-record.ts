import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The outcome of the last `runtime start` (#44). On Windows the sign-in task starts it through a headless console
 * host whose exit code is always 0, so Task Scheduler's result cannot show whether the runtime started; this record
 * does. It holds a timestamp, the outcome, the exit code and a fixed failure category: never a message, path or output.
 */
export type StartCategory = 'invalid_arguments' | 'spawn_failed' | 'runtime_exited' | 'start_timeout' | 'error';
export interface StartRecord { version: 1; at: string; outcome: 'started' | 'already_running' | 'failed'; exit_code: 0 | 1; category?: StartCategory }
const CATEGORIES: readonly StartCategory[] = ['invalid_arguments', 'spawn_failed', 'runtime_exited', 'start_timeout', 'error'];
const file = (home: string) => join(home, 'runtime-start.json');

/** Replaces the record atomically. Failing to write it never changes the start result. */
export function recordStart(home: string, outcome: StartRecord['outcome'], category?: StartCategory, now = new Date()) {
  const record: StartRecord = { version: 1, at: now.toISOString(), outcome, exit_code: outcome === 'failed' ? 1 : 0, ...(outcome === 'failed' ? { category: category ?? 'error' } : {}) };
  try {
    mkdirSync(home, { recursive: true });
    const temporary = `${file(home)}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
    renameSync(temporary, file(home));
  } catch { /* An unwritable home must not turn a start into a failure, or a failure into another error. */ }
  return record;
}
/** The last record, if it is well-formed; anything else reads as no record. */
export function readStart(home: string): StartRecord | undefined {
  try {
    const value = JSON.parse(readFileSync(file(home), 'utf8')) as Partial<StartRecord>;
    const at = typeof value.at === 'string' ? Date.parse(value.at) : NaN;
    if (value.version !== 1 || !Number.isFinite(at) || !['started', 'already_running', 'failed'].includes(value.outcome as string)) return undefined;
    const failed = value.outcome === 'failed';
    if (value.exit_code !== (failed ? 1 : 0) || (failed ? !CATEGORIES.includes(value.category as StartCategory) : value.category !== undefined)) return undefined;
    return { version: 1, at: new Date(at).toISOString(), outcome: value.outcome!, exit_code: value.exit_code as 0 | 1, ...(failed ? { category: value.category! } : {}) };
  } catch { return undefined; }
}
/** The category of a failed start: the runtime launcher's own, or a generic one. */
export function startCategory(error: unknown): StartCategory {
  const category = (error as { category?: unknown } | undefined)?.category;
  return CATEGORIES.includes(category as StartCategory) ? category as StartCategory : 'error';
}

/**
 * The result of the sign-in task's last run, from Task Scheduler's last run time and this record. A record counts only
 * when it was written during that run (at or after its start, within the task's one-minute limit), so an older record
 * is never shown as the current result.
 */
export type TaskStartResult =
  | { state: 'not_run' | 'running' | 'no_result'; last_run: string | null }
  | { state: StartRecord['outcome']; last_run: string; at: string; exit_code: 0 | 1; category?: StartCategory };
export const TASK_RUN_WINDOW_MS = 70_000;
export function taskStartResult(lastRun: string | null, running: boolean, record: StartRecord | undefined): TaskStartResult {
  const started = lastRun ? Date.parse(lastRun) : NaN;
  if (!Number.isFinite(started)) return { state: 'not_run', last_run: null };
  const at = record ? Date.parse(record.at) : NaN;
  // Task Scheduler stores the run time in whole seconds; a record from the same run can be up to a second "earlier".
  if (record && at >= started - 1000 && at - started <= TASK_RUN_WINDOW_MS) {
    return { state: record.outcome, last_run: new Date(started).toISOString(), at: record.at, exit_code: record.exit_code, ...(record.category ? { category: record.category } : {}) };
  }
  return { state: running ? 'running' : 'no_result', last_run: new Date(started).toISOString() };
}
