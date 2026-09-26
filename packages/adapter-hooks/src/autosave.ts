import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectClient } from '../../core/src/index.js';
import { looksSensitive } from '../../core/src/security/sensitive.js';
import type { HookProviderName } from './index.js';

/**
 * Model-aware session autosave without an extra visible turn. After the first file edit of a turn, the PostToolUse hook
 * gives the same model the save contract as additional context, which neither provider displays. The model ends its
 * final answer with one Markdown link reference definition that carries the save as JSON. CommonMark renderers do not
 * display such a definition: Codex hides it, while Claude Code 2.1 shows it as one raw line. Stop reads only that final
 * answer (`last_assistant_message`), never the transcript, and Core policy decides what becomes durable. If the line is
 * missing, Stop asks once through a provider continuation instead. `SessionEnd` cannot involve the model.
 */
export const AGENT_NAME: Record<HookProviderName, string> = { claude: 'Claude Code', codex: 'Codex' };
export const SAVE_LABEL = 'continuity-save';
/** Earlier releases asked for a `<continuity-save>{...}</continuity-save>` block; an answer in that form is still read. */
export const SAVE_TAG = SAVE_LABEL;
/** A continuation request (the fallback, which the user sees) at most this often per session. */
export const PROMPT_INTERVAL_MS = 15 * 60 * 1000;
const STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_MEMORIES = 5;
const MAX_LIST = 10;
const MAX_ITEM = 500;

const SAVE_LINE = `[${SAVE_LABEL}]: <{"memories":[],"handoff":null}>`;
const SAVE_FIELDS = [
  'memories: 0-3 durable, non-obvious lessons or decisions (including decisions the user stated) that a future agent in this project must know, each {"key":"area.topic","kind":"decision|experience|memory","text":"one factual sentence"}; add "source_path" only if that project file contains the text verbatim. Never: test/build results, changed-file lists, generic advice, guesses, secrets, chat. Empty is normal.',
  'handoff: only if meaningful work is left unfinished (including parts deferred to a later session), {"goal":"...","status":"in_progress|blocked","remaining":["..."],"decisions":["..."],"risks":["..."],"next":"one concrete next action"}; otherwise null.',
  'Keep the JSON on that one line; write < and > inside strings as \\u003c and \\u003e.',
];
/**
 * The contract. `append`: given with the first edit of a turn; the line ends the final answer. `reply`: the fallback
 * request when no contract was given this turn (for example after a sub-agent's edit); the reply is only the line.
 */
export function saveContract(mode: 'append' | 'reply', openHandoffGoal?: string) {
  const lead = mode === 'append'
    ? 'Continuity save (automatic, not from the user): files changed in this turn. Decide what a future agent in this project must know. End your final answer with an empty line and then this single line; do not mention it:'
    : 'Continuity save check (automatic, once). Decide what a future agent in this project must know, then reply with only this single line and no tool calls:';
  return [lead, SAVE_LINE, ...SAVE_FIELDS, ...(openHandoffGoal ? [closeOffer(openHandoffGoal)] : [])].join('\n');
}
/** The fallback request after a turn whose contract was given but whose final answer has no save line. */
export const SAVE_REMINDER = `Continuity save check (automatic, once): reply with only the [${SAVE_LABEL}] line described earlier in this turn, and no tool calls.`;
/** With an open handoff, the model may close it; it never names an id, and a finished task is never a new handoff. */
function closeOffer(openHandoffGoal: string) {
  const goal = Array.from(openHandoffGoal.replace(/\s+/g, ' ').replace(/"/g, "'").trim()).slice(0, 160).join('');
  return `Open handoff in this project: "${goal}". Add "close_handoff":true only if its work is now finished or your new handoff fully replaces it; never create a handoff just to say work is done.`;
}

/**
 * Codex 0.157 hosts interactive TUI sessions in a shared app-server daemon, and their hooks run in that daemon's
 * process tree, which carries this variable. `codex exec` has no daemon mode and runs its hooks in-process without it.
 */
export const CODEX_DAEMON_MARKER = 'CODEX_DAEMON_SHUTDOWN_SOCKET';
/** Set by Codex for commands it runs as tools. A `codex exec` started from such a command inherits the daemon marker. */
export const CODEX_TOOL_MARKERS = ['CODEX_CI', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID'] as const;

/**
 * Autosave adds a line to the provider's final answer (and may add a save turn), so it runs by default only in sessions
 * the provider reports as interactive. CONTINUITY_AUTOSAVE=1 forces it on; any other non-empty value forces it off.
 * Claude Code sets CLAUDE_CODE_SESSION_ATTENDED (1 interactive, 0 for -p/SDK) and CLAUDE_CODE_ENTRYPOINT (cli vs
 * sdk-*) for its hooks. Codex hook input is identical in the TUI and `codex exec`; only the daemon host differs.
 * Every signal is verified but undocumented, so anything unknown means off.
 */
export function autosaveEnabled(provider: HookProviderName, env: NodeJS.ProcessEnv = process.env): boolean {
  // Only the documented 1 enables; 0 and anything unrecognized (off, false, true, ...) fail safe to off.
  if (env.CONTINUITY_AUTOSAVE === '1') return true;
  if (env.CONTINUITY_AUTOSAVE !== undefined && env.CONTINUITY_AUTOSAVE !== '') return false;
  if (provider === 'codex') return !!env[CODEX_DAEMON_MARKER] && !CODEX_TOOL_MARKERS.some(name => env[name]);
  const attended = env.CLAUDE_CODE_SESSION_ATTENDED;
  return attended === '1' || (attended === undefined && env.CLAUDE_CODE_ENTRYPOINT === 'cli');
}

/** The open handoff's goal for the save request, unless the handoff looks sensitive (bootstrap withholds those too). */
export function offerableGoal(handoff: { from: { agent: string }; task: { goal: string }; recommended_next_action: string; remaining: readonly string[] }) {
  const fields = [handoff.from.agent, handoff.task.goal, handoff.recommended_next_action, ...handoff.remaining];
  return [fields.join('\n'), ...fields].some(looksSensitive) ? undefined : handoff.task.goal;
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
/**
 * PostToolUse input: only session id, cwd and whether a sub-agent made the edit (both providers add `agent_id` inside a
 * sub-agent) are used; tool input/output is never read or stored.
 */
export function toolUseInput(stdin: string): { session: string; cwd: string; subagent: boolean } | undefined {
  try {
    const { session_id: session, cwd, agent_id: agent } = JSON.parse(stdin) as { session_id?: unknown; cwd?: unknown; agent_id?: unknown };
    return typeof session === 'string' && session.trim() && session.length <= 100 && typeof cwd === 'string' && cwd && cwd.length < 4096 ? { session: session.trim(), cwd, subagent: typeof agent === 'string' && agent !== '' } : undefined;
  } catch { return undefined; }
}

/**
 * Ephemeral per-session flags, no content: edits not yet covered by an offer (`dirty`), an outstanding offer or request
 * (`pending`; `asked` when it is a continuation request), when the last request was made, and a hash of the
 * project/workspace the edits and the offer belong to (`mixed` when edits spanned several).
 */
export interface SessionState { dirty: boolean; pending: boolean; asked?: boolean; prompted_at?: number; scope?: string; close?: string }
export const scopeKey = (projectId: string, workspaceId = '') => createHash('sha256').update(`${projectId}\0${workspaceId}`).digest('hex').slice(0, 24);
const stateDir = (home: string) => join(home, 'hooks', 'autosave');
const stateFile = (home: string, provider: HookProviderName, session: string) => join(stateDir(home), `${createHash('sha256').update(`${provider}\0${session}`).digest('hex').slice(0, 40)}.json`);
export function readSessionState(home: string, provider: HookProviderName, session: string): SessionState {
  try {
    const value = JSON.parse(readFileSync(stateFile(home, provider, session), 'utf8')) as Partial<SessionState>;
    return { dirty: value.dirty === true, pending: value.pending === true, ...(value.asked === true && value.pending === true ? { asked: true } : {}), ...(typeof value.prompted_at === 'number' ? { prompted_at: value.prompted_at } : {}), ...(typeof value.scope === 'string' && /^([0-9a-f]{24}|mixed)$/.test(value.scope) ? { scope: value.scope } : {}), ...(typeof value.close === 'string' && /^handoff_[0-9a-f-]{36}$/.test(value.close) ? { close: value.close } : {}) };
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

/**
 * A file edit of this session in `scope`. The first edit of a turn gets the contract; later edits of the turn are covered
 * by it. An outstanding offer keeps its scope: an edit elsewhere makes the answer unusable, never redirects it. A
 * sub-agent's edit is only recorded: an offer would reach the sub-agent, not the model that ends the turn.
 */
export function editDecision(state: SessionState, scope: string, subagent: boolean): { offer: boolean; state: SessionState } {
  if (state.pending) return { offer: false, state: state.scope && state.scope !== scope ? { ...state, scope: 'mixed' } : state };
  const next: SessionState = { ...state, dirty: true, scope: state.dirty && state.scope && state.scope !== scope ? 'mixed' : scope };
  if (subagent || next.scope === 'mixed') return { offer: false, state: next };
  return { offer: true, state: { dirty: false, pending: true, scope, ...(state.prompted_at !== undefined ? { prompted_at: state.prompted_at } : {}) } };
}

export type StopDecision = { action: 'apply'; state: SessionState } | { action: 'request'; offered: boolean; state: SessionState } | { action: 'none'; state: SessionState };
/**
 * `answered`: the final answer carries a save. Only an answer to Continuity's own outstanding offer or request is
 * applied. A continuation stop (`stop_hook_active`) is never blocked, so Continuity cannot loop; an unanswered request
 * expires. Without a save line, Stop asks once through a continuation, at most every PROMPT_INTERVAL_MS.
 */
export function stopDecision(state: SessionState, active: boolean, answered: boolean, now = Date.now()): StopDecision {
  // The offered handoff id lives only as long as its offer or request.
  const settle = (): SessionState => { const next: SessionState = { ...state, pending: false }; delete next.asked; delete next.close; return next; };
  if (state.pending && answered) return { action: 'apply', state: settle() };
  if (active) return state.asked ? { action: 'none', state: settle() } : { action: 'none', state };
  if (state.asked) return { action: 'none', state: settle() };
  const offered = state.pending;
  if (!offered && !state.dirty) return { action: 'none', state };
  if (state.prompted_at !== undefined && now - state.prompted_at < PROMPT_INTERVAL_MS) return { action: 'none', state: settle() };
  return { action: 'request', offered, state: { dirty: false, pending: true, asked: true, prompted_at: now, ...(state.scope ? { scope: state.scope } : {}), ...(state.close ? { close: state.close } : {}) } };
}

export type Outcome = { item: string; outcome: string };
interface SaveReply { memories: unknown[]; handoff: unknown; close_handoff?: boolean }
/**
 * Only the last save in the model's answer: a `[continuity-save]: <json>` definition line or a legacy tagged block,
 * whichever comes last. Anything else means "no save".
 */
export function parseSaveReply(message: string): SaveReply | undefined {
  const lines = [...message.matchAll(new RegExp(`^ {0,3}\\[${SAVE_LABEL}\\]:[ \\t]*<(.*)>[ \\t]*\\r?$`, 'gm'))];
  const blocks = [...message.matchAll(new RegExp(`<${SAVE_TAG}>([\\s\\S]*?)</${SAVE_TAG}>`, 'g'))];
  const last = [lines.at(-1), blocks.at(-1)].filter(m => m !== undefined).sort((x, y) => y.index - x.index)[0];
  const body = last?.[1]?.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
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
    // A replacement that was not saved must not take the open work away.
    else if (reply.handoff && typeof reply.handoff === 'object' && !created) outcomes.push({ item: 'handoff close', outcome: 'skipped: the replacement handoff was not saved' });
    else {
      try { outcomes.push({ item: 'handoff close', outcome: client.closeHandoff({ id: offered, from, ...(created ? { replaced_by: created } : {}) }).outcome }); }
      catch (error) { outcomes.push({ item: 'handoff close', outcome: `failed: ${error instanceof Error && error.name !== 'ZodError' ? error.message.slice(0, 120) : 'invalid close'}` }); }
    }
  }
  return outcomes;
}
/**
 * Silent unless something failed. Policy outcomes (rejected, quarantined, skipped) are normal and stay silent; conflicts
 * surface in the next startup context and the Dashboard. A failure is one short line without item text.
 */
export function saveReport(outcomes: readonly Outcome[]) {
  const failed = outcomes.filter(o => o.outcome.startsWith('failed'));
  if (!failed.length) return undefined;
  return `Continuity: save incomplete — ${failed.length} of ${outcomes.length} not saved (${failureReason(failed[0]!.outcome.replace(/^failed:\s*/, ''))}).`;
}
/** A short reason for the one-line report; a busy database is the common case. */
export function failureReason(message: string) {
  return /database is locked|SQLITE_BUSY|busy/i.test(message) ? 'database busy' : message.replace(/\s+/g, ' ').slice(0, 80);
}
/** PostToolUse output: the contract as additional context for the model (same shape for Claude Code and Codex). */
export const saveOffer = (openHandoffGoal?: string) => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: saveContract('append', openHandoffGoal) } });
/**
 * The fallback continuation. Claude Code: Stop additionalContext, shown as hook feedback rather than a hook error.
 * Codex has no Stop additionalContext and uses decision:block.
 */
export function stopRequest(provider: HookProviderName, offered: boolean, openHandoffGoal?: string) {
  const text = offered ? SAVE_REMINDER : saveContract('reply', openHandoffGoal);
  return JSON.stringify(provider === 'claude' ? { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: text } } : { decision: 'block', reason: text });
}
/** Stop output shared by both providers (Codex requires JSON or nothing on stdout). */
export const stopMessage = (message: string) => JSON.stringify({ systemMessage: message });
