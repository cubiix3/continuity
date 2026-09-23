import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectClient } from '../../core/src/index.js';
import { looksSensitive } from '../../core/src/security/sensitive.js';
import type { HookProviderName } from './index.js';

/**
 * Model-aware session autosave. Provider `Stop` hooks can return `decision: block` so the same model continues one
 * turn; `SessionEnd` cannot involve the model. The model deliberately answers a save request with one tagged JSON
 * block, and only that answer is read — never the transcript. Core policy decides what becomes durable.
 */
export const AGENT_NAME: Record<HookProviderName, string> = { claude: 'Claude Code', codex: 'Codex' };
export const SAVE_TAG = 'continuity-save';
/** One save request per session at most this often, and only after file edits since the previous request. */
export const PROMPT_INTERVAL_MS = 15 * 60 * 1000;
const STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_MEMORIES = 5;
const MAX_LIST = 10;
const MAX_ITEM = 500;

export const SAVE_INSTRUCTION = [
  'Continuity save check (automatic, once). Decide what a future agent in this project must know, then reply with only this block and no tool calls:',
  `<${SAVE_TAG}>{"memories":[],"handoff":null}</${SAVE_TAG}>`,
  'memories: 0-3 durable, non-obvious lessons or decisions, each {"key":"area.topic","kind":"decision|experience|memory","text":"one factual sentence"}; add "source_path" only if that project file contains the text verbatim. Never: test/build results, changed-file lists, generic advice, guesses, secrets, chat. Empty is normal.',
  'handoff: only if meaningful work is left unfinished (including parts deferred to a later session), {"goal":"...","status":"in_progress|blocked","remaining":["..."],"decisions":["..."],"risks":["..."],"next":"one concrete next action"}; otherwise null.',
].join('\n');
/** With an open handoff, the model may close it; it never names an id, and a finished task is never a new handoff. */
export function saveInstruction(openHandoffGoal?: string) {
  if (!openHandoffGoal) return SAVE_INSTRUCTION;
  const goal = Array.from(openHandoffGoal.replace(/\s+/g, ' ').replace(/"/g, "'").trim()).slice(0, 160).join('');
  return `${SAVE_INSTRUCTION}\nOpen handoff in this project: "${goal}". Add "close_handoff":true only if its work is now finished or your new handoff fully replaces it; never create a handoff just to say work is done.`;
}

/**
 * Autosave replaces the provider's final answer with a save turn, so it runs by default only in sessions the provider
 * reports as attended and interactive. CONTINUITY_AUTOSAVE=1|0 forces it on or off; other values are ignored.
 * Claude Code sets CLAUDE_CODE_SESSION_ATTENDED (1 interactive, 0 for -p/SDK) and CLAUDE_CODE_ENTRYPOINT (cli vs
 * sdk-*) for its hooks. Codex exposes no such signal to hooks, so Codex autosave needs CONTINUITY_AUTOSAVE=1.
 */
export function autosaveEnabled(provider: HookProviderName, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CONTINUITY_AUTOSAVE === '1') return true;
  if (env.CONTINUITY_AUTOSAVE === '0') return false;
  if (provider !== 'claude') return false;
  const attended = env.CLAUDE_CODE_SESSION_ATTENDED;
  return attended === '1' || (attended === undefined && env.CLAUDE_CODE_ENTRYPOINT === 'cli');
}

/** The open handoff's goal for the save request, unless the handoff looks sensitive (bootstrap withholds those too). */
export function offerableGoal(handoff: { task: { goal: string }; recommended_next_action: string; remaining: readonly string[] }) {
  return [handoff.task.goal, handoff.recommended_next_action, ...handoff.remaining].some(looksSensitive) ? undefined : handoff.task.goal;
}

export interface StopInput { session: string; cwd: string; active: boolean; message: string }
/** Official Stop input (Claude Code and Codex): session_id, cwd, stop_hook_active, last_assistant_message. */
export function stopInput(stdin: string): StopInput | undefined {
  try {
    const input = JSON.parse(stdin) as Record<string, unknown>;
    const session = typeof input.session_id === 'string' ? input.session_id.trim() : '';
    const cwd = input.cwd;
    if (!session || session.length > 100 || typeof cwd !== 'string' || !cwd || cwd.length >= 4096) return undefined;
    return { session, cwd, active: input.stop_hook_active === true, message: typeof input.last_assistant_message === 'string' ? input.last_assistant_message : '' };
  } catch { return undefined; }
}
/** PostToolUse input: only session id and cwd are used; tool input/output is never read or stored. */
export function toolUseInput(stdin: string): { session: string; cwd: string } | undefined {
  try {
    const { session_id: session, cwd } = JSON.parse(stdin) as { session_id?: unknown; cwd?: unknown };
    return typeof session === 'string' && session.trim() && session.length <= 100 && typeof cwd === 'string' && cwd && cwd.length < 4096 ? { session: session.trim(), cwd } : undefined;
  } catch { return undefined; }
}

/**
 * Ephemeral per-session flags, no content: whether edits happened, whether a save request is outstanding, and a hash of
 * the project/workspace the edits and the request belong to (`mixed` when edits spanned several).
 */
export interface SessionState { dirty: boolean; pending: boolean; prompted_at?: number; scope?: string; close?: string }
export const scopeKey = (projectId: string, workspaceId = '') => createHash('sha256').update(`${projectId}\0${workspaceId}`).digest('hex').slice(0, 24);
const stateDir = (home: string) => join(home, 'hooks', 'autosave');
const stateFile = (home: string, provider: HookProviderName, session: string) => join(stateDir(home), `${createHash('sha256').update(`${provider}\0${session}`).digest('hex').slice(0, 40)}.json`);
export function readSessionState(home: string, provider: HookProviderName, session: string): SessionState {
  try {
    const value = JSON.parse(readFileSync(stateFile(home, provider, session), 'utf8')) as Partial<SessionState>;
    return { dirty: value.dirty === true, pending: value.pending === true, ...(typeof value.prompted_at === 'number' ? { prompted_at: value.prompted_at } : {}), ...(typeof value.scope === 'string' && /^([0-9a-f]{24}|mixed)$/.test(value.scope) ? { scope: value.scope } : {}), ...(typeof value.close === 'string' && /^handoff_[0-9a-f-]{36}$/.test(value.close) ? { close: value.close } : {}) };
  } catch { return { dirty: false, pending: false }; }
}
export function writeSessionState(home: string, provider: HookProviderName, session: string, state: SessionState, now = Date.now()) {
  const dir = stateDir(home), file = stateFile(home, provider, session);
  // Never follow a linked state directory (cleanup deletes files there); checked before anything is created in it.
  const linked = (path: string) => { try { return lstatSync(path).isSymbolicLink(); } catch { return false; } };
  if (linked(join(home, 'hooks')) || linked(dir)) throw new Error('Autosave state directory is a link.');
  mkdirSync(dir, { recursive: true });
  if (!state.dirty && !state.pending && state.prompted_at === undefined) { try { unlinkSync(file); } catch { /* absent */ } }
  else { const temporary = `${file}.${process.pid}.tmp`; writeFileSync(temporary, JSON.stringify(state)); renameSync(temporary, file); }
  // Abandoned sessions leave only flags; drop them after a week.
  for (const name of readdirSync(dir)) {
    try { if (now - statSync(join(dir, name)).mtimeMs > STATE_TTL_MS) unlinkSync(join(dir, name)); } catch { /* concurrent cleanup */ }
  }
}

export type StopDecision = { action: 'prompt'; state: SessionState } | { action: 'apply'; state: SessionState } | { action: 'none'; state: SessionState };
/**
 * Never blocks a stop that is already a continuation (`stop_hook_active`), so Continuity cannot loop. A request is
 * answered on the next stop; an unanswered one expires. Save requests follow file edits and are rate limited.
 */
export function stopDecision(state: SessionState, active: boolean, now = Date.now()): StopDecision {
  // The offered handoff id lives only as long as its request.
  const settle = (): SessionState => { const next = { ...state, pending: false }; delete next.close; return next; };
  if (active) return state.pending ? { action: 'apply', state: settle() } : { action: 'none', state };
  const cleared = settle();
  if (!cleared.dirty || (cleared.prompted_at !== undefined && now - cleared.prompted_at < PROMPT_INTERVAL_MS)) return { action: 'none', state: cleared };
  return { action: 'prompt', state: { dirty: false, pending: true, prompted_at: now } };
}

export type Outcome = { item: string; outcome: string };
interface SaveReply { memories: unknown[]; handoff: unknown; close_handoff?: boolean }
/** Only the last tagged block of the model's answer to the save request; anything else means "no save". */
export function parseSaveReply(message: string): SaveReply | undefined {
  const blocks = [...message.matchAll(new RegExp(`<${SAVE_TAG}>([\\s\\S]*?)</${SAVE_TAG}>`, 'g'))];
  const body = blocks.at(-1)?.[1]?.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  if (body === undefined) return undefined;
  try {
    const value = JSON.parse(body) as Record<string, unknown>;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    return { memories: Array.isArray(value.memories) ? value.memories : [], handoff: value.handoff ?? null, ...(value.close_handoff === true ? { close_handoff: true } : {}) };
  } catch { return undefined; }
}
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const list = (value: unknown) => (Array.isArray(value) ? value : []).map(text).filter(Boolean).slice(0, MAX_LIST);
const clip = (items: string[]) => items.map(v => Array.from(v).slice(0, MAX_ITEM).join(''));

/**
 * Applies a parsed reply through the existing Core APIs. Only key/kind/text/source_path and handoff text are taken
 * from the model; attribution comes from the provider session, and trust, status, scope and provenance from Core.
 */
export function applySave(client: ProjectClient, provider: HookProviderName, session: string, reply: SaveReply, offered?: string): Outcome[] {
  const from = { agent: AGENT_NAME[provider], session };
  const outcomes: Outcome[] = [], proposals: { at: number; candidate: Record<string, unknown> }[] = [];
  let created: string | undefined;
  reply.memories.forEach((raw, index) => {
    const m = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const key = text(m.key), source = text(m.source_path), item = key && !looksSensitive(key) ? `memory ${key.slice(0, 60)}` : `memory ${index + 1}`;
    if (index >= MAX_MEMORIES) { outcomes.push({ item, outcome: 'skipped: too many memories' }); return; }
    if (m.kind === 'rule') { outcomes.push({ item, outcome: 'skipped: project rules come from project files' }); return; }
    // Each raw field separately: serialization would escape quotes and hide `key = "value"` patterns.
    if ([key, text(m.text), source].some(looksSensitive)) { outcomes.push({ item, outcome: 'skipped: looks like a secret' }); return; }
    proposals.push({ at: outcomes.length, candidate: { key, kind: m.kind, text: text(m.text), ...(source ? { source_path: source } : {}), from } });
    outcomes.push({ item, outcome: 'pending' });
  });
  if (proposals.length) {
    const results = client.proposeAll(proposals.map(p => p.candidate));
    proposals.forEach((p, i) => {
      const result = results[i]!;
      outcomes[p.at]!.outcome = result instanceof Error ? `failed: ${result.name !== 'ZodError' ? result.message.slice(0, 120) : 'invalid memory'}` : result.outcome;
    });
  }
  if (reply.handoff && typeof reply.handoff === 'object') {
    const h = reply.handoff as Record<string, unknown>;
    const remaining = list(h.remaining), decisions = list(h.decisions), risks = list(h.risks);
    const handoff = { from, task: { goal: text(h.goal), status: h.status }, completed: [], remaining: clip(remaining), decisions: clip(decisions), files_changed: [], risks: clip(risks), recommended_next_action: text(h.next ?? h.recommended_next_action) };
    // Checked before clipping, so a cut cannot leave an undetectable fragment of a secret.
    const fields = [handoff.task.goal, handoff.recommended_next_action, ...remaining, ...decisions, ...risks];
    if (h.status !== 'in_progress' && h.status !== 'blocked') outcomes.push({ item: 'handoff', outcome: 'skipped: only unfinished work is handed off' });
    else if (!handoff.task.goal || !handoff.recommended_next_action) outcomes.push({ item: 'handoff', outcome: 'skipped: goal and next action are required' });
    else if (fields.some(looksSensitive)) outcomes.push({ item: 'handoff', outcome: 'skipped: looks like a secret' });
    else {
      try { created = client.createHandoff(handoff).id; outcomes.push({ item: 'handoff', outcome: 'created' }); }
      catch (error) { outcomes.push({ item: 'handoff', outcome: `failed: ${error instanceof Error && error.name !== 'ZodError' ? error.message.slice(0, 120) : 'invalid handoff'}` }); }
    }
  }
  // Only the open handoff the host named in its request can be closed; the model never supplies an id. A handoff created
  // in the same answer is recorded as its replacement.
  if (reply.close_handoff) {
    if (!offered) outcomes.push({ item: 'handoff close', outcome: 'skipped: no open handoff was offered' });
    else {
      try { outcomes.push({ item: 'handoff close', outcome: client.closeHandoff({ id: offered, from, ...(created ? { replaced_by: created } : {}) }).outcome }); }
      catch (error) { outcomes.push({ item: 'handoff close', outcome: `failed: ${error instanceof Error && error.name !== 'ZodError' ? error.message.slice(0, 120) : 'invalid close'}` }); }
    }
  }
  return outcomes;
}
/** Silent on success; anything not saved as requested is reported in one line. */
export function saveReport(outcomes: readonly Outcome[]) {
  const notable = outcomes.filter(o => !['persisted', 'duplicate', 'superseded', 'created', 'closed', 'already_closed'].includes(o.outcome));
  if (!notable.length) return undefined;
  const saved = outcomes.length - notable.length;
  return `Continuity autosave: ${saved} of ${outcomes.length} saved; ${notable.map(o => `${o.item}: ${o.outcome}`).join('; ')}.`.replace(/\s+/g, ' ').slice(0, 600);
}
/** Stop output shared by both providers (Codex requires JSON or nothing on stdout). */
export const stopBlock = (openHandoffGoal?: string) => JSON.stringify({ decision: 'block', reason: saveInstruction(openHandoffGoal) });
export const stopMessage = (message: string) => JSON.stringify({ systemMessage: message });
