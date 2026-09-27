import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { Correction, ProjectClient } from '../../core/src/index.js';
import { looksSensitive } from '../../core/src/security/sensitive.js';
import type { HookProviderName } from './index.js';
import { MAX_CHANGED, SHELL_TOOLS } from './shell.js';

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
/** A continuation request (the fallback, which the user sees) at most this often per session. */
export const PROMPT_INTERVAL_MS = 15 * 60 * 1000;
const STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_MEMORIES = 5;
const MAX_LIST = 10;
const MAX_ITEM = 500;

const SAVE_LINE = `[${SAVE_LABEL}]: <{"memories":[],"handoff":null}>`;
const SAVE_FIELDS = [
  'memories: 0-3 durable, non-obvious lessons or decisions (including decisions the user stated) that a future agent in this project must know, each {"key":"area.topic","kind":"decision|experience|memory","text":"one factual sentence"}; add "source_path" only if that project file contains the text verbatim. To correct a listed memory that is now wrong, reuse its key and add "corrects":true. Never: test/build results, changed-file lists, generic advice, guesses, secrets, chat. Empty is normal.',
  'handoff: only if meaningful work is left unfinished (including parts deferred to a later session), {"goal":"...","status":"in_progress|blocked","remaining":["..."],"decisions":["..."],"risks":["..."],"next":"one concrete next action"}; otherwise null.',
  'Keep the JSON on that one line; write < and > inside strings as \\u003c and \\u003e.',
];
/** The contract, given with the first edit of a turn: the save line ends the final answer. */
export function saveContract(openHandoffGoal?: string) {
  const lead = 'Continuity save (automatic, not from the user): files changed in this turn. Decide what a future agent in this project must know. End your final answer with an empty line and then this single line; do not mention it:';
  return [lead, SAVE_LINE, ...SAVE_FIELDS, ...(openHandoffGoal ? [closeOffer(openHandoffGoal)] : [])].join('\n');
}
/**
 * The fallback request, shown to the user, so it stays short. It carries the template itself: the model may never have
 * seen the contract (a sub-agent's edit) or may have lost it (compaction).
 */
export const SAVE_REQUEST = [
  'Continuity save check (automatic, once): reply with only this line, filled in or left empty, and no tool calls:',
  SAVE_LINE,
  'memories: 0-3 durable lessons or decisions a future agent must know, {"key":"area.topic","kind":"decision|experience|memory","text":"..."}; handoff: unfinished work {"goal":"...","status":"in_progress|blocked","next":"..."} or null.',
].join('\n');
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

/**
 * The provider's id for the current turn, hashed: Codex `turn_id`, Claude Code `prompt_id` (one id per user prompt,
 * kept through Stop continuations). Absent in older versions, which then keep one offer until its Stop.
 */
const turnKey = (value: unknown) => typeof value === 'string' && value && value.length <= 200 ? createHash('sha256').update(value).digest('hex').slice(0, 16) : undefined;
export interface StopInput { session: string; cwd: string; active: boolean; message: string; turn?: string }
/** Official Stop input (Claude Code and Codex): session_id, cwd, stop_hook_active, last_assistant_message, turn id. */
export function stopInput(stdin: string): StopInput | undefined {
  try {
    const input = JSON.parse(stdin) as Record<string, unknown>;
    const session = typeof input.session_id === 'string' ? input.session_id.trim() : '';
    const cwd = input.cwd, turn = turnKey(input.turn_id ?? input.prompt_id);
    if (!session || session.length > 100 || typeof cwd !== 'string' || !cwd || cwd.length >= 4096) return undefined;
    return { session, cwd, active: input.stop_hook_active === true, message: typeof input.last_assistant_message === 'string' ? input.last_assistant_message : '', ...(turn ? { turn } : {}) };
  } catch { return undefined; }
}
/** What a shell tool call reported: the changed paths (absolute) and its duration, nothing else. */
export interface ShellReport { tool: string; changed: string[]; more: number; duration?: number }
/**
 * PostToolUse input: only session id, cwd, the turn id, whether a sub-agent made the edit (both providers add
 * `agent_id` inside a sub-agent) and the tool's name are used. For a shell tool, also the changed paths of the
 * provider's own edit report and the duration (#34). The command, its output and file contents are never read or stored.
 */
export function toolUseInput(stdin: string): { session: string; cwd: string; subagent: boolean; turn?: string; shell?: ShellReport } | undefined {
  try {
    const { session_id: session, cwd, agent_id: agent, turn_id: turnId, prompt_id: promptId, tool_name: tool, tool_response: response, duration_ms: duration } = JSON.parse(stdin) as Record<string, unknown>;
    const turn = turnKey(turnId ?? promptId);
    if (typeof session !== 'string' || !session.trim() || session.length > 100 || typeof cwd !== 'string' || !cwd || cwd.length >= 4096) return undefined;
    const shell = typeof tool === 'string' && SHELL_TOOLS.has(tool) ? shellReport(tool, response, duration) : undefined;
    return { session: session.trim(), cwd, subagent: typeof agent === 'string' && agent !== '', ...(turn ? { turn } : {}), ...(shell ? { shell } : {}) };
  } catch { return undefined; }
}
function shellReport(tool: string, response: unknown, duration: unknown): ShellReport {
  const diff = response && typeof response === 'object' ? (response as { bashEditDiff?: unknown }).bashEditDiff as { changedFiles?: unknown; moreFiles?: unknown } | undefined : undefined;
  const changed = Array.isArray(diff?.changedFiles) ? diff.changedFiles.filter((f): f is string => typeof f === 'string' && f.length > 0 && f.length < 4096 && isAbsolute(f)).slice(0, MAX_CHANGED) : [];
  const more = typeof diff?.moreFiles === 'number' && diff.moreFiles > 0 ? diff.moreFiles : 0;
  return { tool, changed, more, ...(typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 ? { duration } : {}) };
}

/**
 * Ephemeral per-session flags, no content: edits not yet covered by an offer (`dirty`); an outstanding offer (`pending`
 * with `offered`, and the hashed `turn` it was made in) or continuation request (`pending` with `asked`); when the last
 * request was made; and a hash of the project/workspace the edits and the offer belong to (`mixed` for several).
 */
export interface SessionState { dirty: boolean; pending: boolean; offered?: boolean; asked?: boolean; turn?: string; prompted_at?: number; scope?: string; close?: string }
export const scopeKey = (projectId: string, workspaceId = '') => createHash('sha256').update(`${projectId}\0${workspaceId}`).digest('hex').slice(0, 24);
const stateDir = (home: string) => join(home, 'hooks', 'autosave');
const stateFile = (home: string, provider: HookProviderName, session: string) => join(stateDir(home), `${createHash('sha256').update(`${provider}\0${session}`).digest('hex').slice(0, 40)}.json`);
export function readSessionState(home: string, provider: HookProviderName, session: string): SessionState {
  try {
    const value = JSON.parse(readFileSync(stateFile(home, provider, session), 'utf8')) as Partial<SessionState>;
    return { dirty: value.dirty === true, pending: value.pending === true, ...(value.offered === true && value.pending === true ? { offered: true } : {}), ...(value.asked === true && value.pending === true ? { asked: true } : {}), ...(typeof value.turn === 'string' && /^[0-9a-f]{16}$/.test(value.turn) ? { turn: value.turn } : {}), ...(typeof value.prompted_at === 'number' ? { prompted_at: value.prompted_at } : {}), ...(typeof value.scope === 'string' && /^([0-9a-f]{24}|mixed)$/.test(value.scope) ? { scope: value.scope } : {}), ...(typeof value.close === 'string' && /^handoff_[0-9a-f-]{36}$/.test(value.close) ? { close: value.close } : {}) };
  } catch { return { dirty: false, pending: false }; }
}
/** The state directory, never through a link (cleanup deletes files there); checked before anything is created in it. */
function stateDirectory(home: string) {
  const dir = stateDir(home);
  const linked = (path: string) => { try { return lstatSync(path).isSymbolicLink(); } catch { return false; } };
  if (linked(join(home, 'hooks')) || linked(dir)) throw new Error('Autosave state directory is a link.');
  mkdirSync(dir, { recursive: true });
  return dir;
}
const replace = (file: string, text: string) => { const temporary = `${file}.${process.pid}.tmp`; writeFileSync(temporary, text); renameSync(temporary, file); };
/** Abandoned sessions leave only flags and ids; drop them after a week. */
function cleanup(dir: string, now: number) {
  for (const name of readdirSync(dir)) {
    try { if (now - statSync(join(dir, name)).mtimeMs > STATE_TTL_MS) unlinkSync(join(dir, name)); } catch { /* concurrent cleanup */ }
  }
}

/**
 * Edit journal (#34): when each session last edited each scope, one small file per scope and session next to the
 * session flags (timestamps only). A shell report covers everything that changed while the command ran, so it is
 * ambiguous when another session edited the same scope meanwhile.
 */
const SCOPE = /^[0-9a-f]{24}$/;
const journalDir = (home: string) => join(stateDir(home), 'edits');
const sessionKey = (provider: HookProviderName, session: string) => createHash('sha256').update(`${provider}\0${session}`).digest('hex').slice(0, 40);
export function recordEdit(home: string, provider: HookProviderName, session: string, scope: string, now = Date.now()) {
  if (!SCOPE.test(scope)) return;
  stateDirectory(home);
  const dir = journalDir(home);
  try { if (lstatSync(dir).isSymbolicLink()) throw new Error('Autosave edit journal is a link.'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  mkdirSync(dir, { recursive: true });
  replace(join(dir, `${scope}-${sessionKey(provider, session)}`), String(now));
  cleanup(dir, now);
}
/** Whether a session other than this one recorded an edit of `scope` at or after `since`. */
export function editedByOthers(home: string, provider: HookProviderName, session: string, scope: string, since: number): boolean {
  if (!SCOPE.test(scope)) return false;
  const dir = journalDir(home), own = `${scope}-${sessionKey(provider, session)}`;
  let names: string[];
  try { names = readdirSync(dir); } catch { return false; }
  return names.some(name => {
    if (!name.startsWith(`${scope}-`) || name === own || name.endsWith('.tmp')) return false;
    try { return Number(readFileSync(join(dir, name), 'utf8')) >= since; } catch { return false; }
  });
}
export function writeSessionState(home: string, provider: HookProviderName, session: string, state: SessionState, now = Date.now()) {
  const dir = stateDirectory(home), file = stateFile(home, provider, session);
  if (!state.dirty && !state.pending && state.prompted_at === undefined) { try { unlinkSync(file); } catch { /* absent */ } }
  else replace(file, JSON.stringify(state));
  cleanup(dir, now);
}

/**
 * The memory ids this session was shown in its startup context: the only memories an explicit correction from this
 * session may replace. Ids only, never content; kept next to the session flags, for as long.
 */
const MAX_SEEN = 64;
const MEMORY_ID = /^mem_[0-9a-f-]{36}$/;
const seenFile = (home: string, provider: HookProviderName, session: string) => stateFile(home, provider, session).replace(/\.json$/, '.seen.json');
export function readSeen(home: string, provider: HookProviderName, session: string): Set<string> {
  try {
    const value = JSON.parse(readFileSync(seenFile(home, provider, session), 'utf8')) as unknown;
    return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && MEMORY_ID.test(id)).slice(-MAX_SEEN) : []);
  } catch { return new Set(); }
}
/** Adds this startup's ids (startup, resume, clear and compact each show the index again), the newest kept. Ids of a session idle past the TTL are dropped first. */
export function recordSeen(home: string, provider: HookProviderName, session: string, ids: readonly string[], now = Date.now()) {
  const shown = ids.filter(id => MEMORY_ID.test(id));
  if (!shown.length) return;
  const dir = stateDirectory(home);
  cleanup(dir, now);
  const seen = [...readSeen(home, provider, session)].filter(id => !shown.includes(id));
  replace(seenFile(home, provider, session), JSON.stringify([...seen, ...shown].slice(-MAX_SEEN)));
}

/** Ends an offer or request; `dirty` keeps its edits for the next offer. The offered handoff id lives only as long. */
const settled = (state: SessionState, dirty: boolean, keepScope = true): SessionState => ({ dirty, pending: false, ...(keepScope && state.scope ? { scope: state.scope } : {}), ...(state.prompted_at !== undefined ? { prompted_at: state.prompted_at } : {}) });
/**
 * An offer from a turn that ended without its Stop (interrupted, failed) no longer covers the current turn, and a
 * request left by an earlier release was never an offer; their edits wait for the next offer.
 */
const expired = (state: SessionState, turn?: string) => state.pending && !state.asked && (!state.offered || (turn !== undefined && state.turn !== undefined && state.turn !== turn));
/**
 * A file edit of this session in `scope`. The first edit of a turn gets the contract; later edits of the turn are covered
 * by it. An outstanding offer keeps its scope: an edit elsewhere makes the answer unusable, never redirects it. A
 * sub-agent's edit is only recorded: an offer would reach the sub-agent, not the model that ends the turn.
 */
export function editDecision(state: SessionState, scope: string, subagent: boolean, turn?: string): { offer: boolean; state: SessionState } {
  // A sub-agent runs its own turn (Codex gives it another turn_id) inside the parent's turn: it never expires an offer.
  const current = !subagent && expired(state, turn) ? settled(state, false, false) : state;
  if (current.pending) return { offer: false, state: current.scope && current.scope !== scope ? { ...current, scope: 'mixed' } : current };
  const next: SessionState = { ...current, dirty: true, scope: current.dirty && current.scope && current.scope !== scope ? 'mixed' : scope };
  if (subagent || next.scope === 'mixed') return { offer: false, state: next };
  return { offer: true, state: { dirty: false, pending: true, offered: true, ...(turn ? { turn } : {}), scope, ...(state.prompted_at !== undefined ? { prompted_at: state.prompted_at } : {}) } };
}

export type StopDecision = { action: 'apply' | 'request' | 'none'; state: SessionState };
/**
 * `answered`: the final answer carries a save. Only an answer to Continuity's own outstanding offer or request is
 * applied. A continuation stop (`stop_hook_active`) is never blocked, so Continuity cannot loop; an unanswered request
 * expires. Without a save line, Stop asks once through a continuation, at most every PROMPT_INTERVAL_MS; a stale
 * offer on a turn that made no edit of its own is never asked about.
 */
export function stopDecision(state: SessionState, active: boolean, answered: boolean, turn?: string, now = Date.now()): StopDecision {
  // Only an answer to the offer of this same turn, or to Continuity's own request, is applied: a save line in a later
  // turn's answer never revives the offer of an interrupted one.
  if (state.pending && answered && (state.offered || state.asked) && !expired(state, turn)) return { action: 'apply', state: settled(state, false) };
  // A continuation stop never asks; it ends Continuity's request, and an expired offer, so neither survives into later stops.
  if (active) return { action: 'none', state: state.asked ? settled(state, state.dirty) : expired(state, turn) ? settled(state, false, false) : state };
  if (state.asked) return { action: 'none', state: settled(state, state.dirty) };
  if (expired(state, turn)) return { action: 'none', state: settled(state, false, false) };
  if (!state.pending && !state.dirty) return { action: 'none', state };
  // Rate limited: these edits are dropped, scope included, so a kept `mixed` scope cannot block later offers.
  if (state.prompted_at !== undefined && now - state.prompted_at < PROMPT_INTERVAL_MS) return { action: 'none', state: settled(state, false, false) };
  return { action: 'request', state: { dirty: false, pending: true, asked: true, prompted_at: now, ...(state.scope ? { scope: state.scope } : {}), ...(state.close ? { close: state.close } : {}) } };
}

export type Outcome = { item: string; outcome: string };
interface SaveReply { memories: unknown[]; handoff: unknown; close_handoff?: boolean }
/**
 * The message's lines (split once on CRLF, CR or LF), with lines inside fenced code blanked: quoted content, never the
 * model's own save. CommonMark fences: ``` or ~~~, at most three spaces in; a backtick fence's info string has no
 * backtick (``` x ``` is inline code); it closes on the same character, at least as long, with nothing after it.
 */
function unfencedLines(message: string) {
  const kept: string[] = [];
  let fence: string | undefined;
  for (const line of message.split(/\r\n|\r|\n/)) {
    const marker = /^ {0,3}(`{3,}(?![^`]*`)|~{3,})/.exec(line)?.[1];
    if (fence) { if (marker && marker[0] === fence[0] && marker.length >= fence.length && !line.trim().slice(marker.length).trim()) fence = undefined; kept.push(''); }
    else if (marker) { fence = marker; kept.push(''); }
    else kept.push(line);
  }
  return kept;
}
/**
 * The last line outside fenced code that starts with the label decides (the label is case-insensitive, like any
 * CommonMark link label). The contract asks for `[continuity-save]: <json>`, a link reference definition that Codex
 * hides. Models sometimes drop the angle brackets, so the bare object, `[continuity-save]: {…}`, is accepted too. If
 * the rest of that last line is neither form, or not a JSON object, there is no save: an earlier line never stands in.
 * Each line is matched on its own, so a Unicode line separator inside a line never starts another one.
 */
export function parseSaveReply(message: string): SaveReply | undefined {
  const label = new RegExp(`^ {0,3}\\[${SAVE_LABEL}\\]:([\\s\\S]*)$`, 'i');
  const rest = unfencedLines(message).flatMap(line => label.exec(line)?.[1] ?? []).at(-1)?.trim();
  const body = rest?.startsWith('<') && rest.endsWith('>') ? rest.slice(1, -1) : rest?.startsWith('{') && rest.endsWith('}') ? rest : undefined;
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
 * Applies a parsed reply through the existing Core APIs. Only key/kind/text/source_path, a memory's "corrects" flag and
 * handoff text are taken from the model; attribution comes from the provider session, and trust, status, scope and
 * provenance from Core. A correction may replace only a memory whose id is in `seen` (shown to this session at startup).
 */
export function applySave(client: ProjectClient, provider: HookProviderName, session: string, reply: SaveReply, offered?: string, seen: ReadonlySet<string> = new Set()): Outcome[] {
  const from = { agent: AGENT_NAME[provider], session };
  const outcomes: Outcome[] = [], proposals: { at: number; candidate: Record<string, unknown>; correction?: Correction }[] = [];
  let created: string | undefined;
  const keys = new Set<string>();
  reply.memories.forEach((raw, index) => {
    const m = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const key = text(m.key), source = text(m.source_path), item = key && !looksSensitive(key) ? `memory ${key.slice(0, 60)}` : `memory ${index + 1}`;
    if (index >= MAX_MEMORIES) { outcomes.push({ item, outcome: 'skipped: too many memories' }); return; }
    // One claim per key and answer: a second one would only conflict with the first.
    if (keys.has(key)) { outcomes.push({ item, outcome: 'skipped: key repeated in this save' }); return; }
    keys.add(key);
    if (m.kind === 'rule') { outcomes.push({ item, outcome: 'skipped: project rules come from project files' }); return; }
    // Each raw field separately: serialization would escape quotes and hide `key = "value"` patterns.
    if ([key, text(m.text), source].some(looksSensitive)) { outcomes.push({ item, outcome: 'skipped: looks like a secret' }); return; }
    // "corrects" is the model's statement of intent; which memory it may replace is decided by the host and Core.
    proposals.push({ at: outcomes.length, candidate: { key, kind: m.kind, text: text(m.text), ...(source ? { source_path: source } : {}), from }, ...(m.corrects === true ? { correction: { visible: seen } } : {}) });
    outcomes.push({ item, outcome: 'pending' });
  });
  if (proposals.length) {
    const results = client.proposeAll(proposals.map(p => p.candidate), proposals.map(p => p.correction));
    proposals.forEach((p, i) => {
      const result = results[i]!;
      // A malformed item is the model's mistake, not a failure the user can act on.
      outcomes[p.at]!.outcome = result instanceof Error ? (result.name === 'ZodError' ? 'skipped: invalid memory' : `failed: ${result.message.slice(0, 120)}`) : result.outcome;
    });
  }
  if (reply.handoff && typeof reply.handoff === 'object') {
    const h = reply.handoff as Record<string, unknown>;
    const remaining = list(h.remaining), decisions = list(h.decisions), risks = list(h.risks);
    const handoff = { from, task: { goal: text(h.goal), status: h.status }, completed: [], remaining: clip(remaining), decisions: clip(decisions), files_changed: [], risks: clip(risks), recommended_next_action: text(h.next ?? h.recommended_next_action) || clip(remaining)[0] || '' };
    // Checked before clipping, so a cut cannot leave an undetectable fragment of a secret.
    const fields = [handoff.task.goal, handoff.recommended_next_action, ...remaining, ...decisions, ...risks];
    if (h.status !== 'in_progress' && h.status !== 'blocked') outcomes.push({ item: 'handoff', outcome: 'skipped: only unfinished work is handed off' });
    else if (!handoff.task.goal || !handoff.recommended_next_action) outcomes.push({ item: 'handoff', outcome: 'skipped: goal and next action are required' });
    else if (fields.some(looksSensitive)) outcomes.push({ item: 'handoff', outcome: 'skipped: looks like a secret' });
    else {
      try { created = client.createHandoff(handoff).id; outcomes.push({ item: 'handoff', outcome: 'created' }); }
      catch (error) { outcomes.push({ item: 'handoff', outcome: error instanceof Error && error.name !== 'ZodError' ? `failed: ${error.message.slice(0, 120)}` : 'skipped: invalid handoff' }); }
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
      catch (error) { outcomes.push({ item: 'handoff close', outcome: error instanceof Error && error.name !== 'ZodError' ? `failed: ${error.message.slice(0, 120)}` : 'skipped: invalid close' }); }
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
  return /database is locked|SQLITE_BUSY/i.test(message) ? 'database busy' : message.replace(/\s+/g, ' ').slice(0, 80);
}
/** PostToolUse output: the contract as additional context for the model (same shape for Claude Code and Codex). */
export const saveOffer = (openHandoffGoal?: string) => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: saveContract(openHandoffGoal) } });
/**
 * The fallback continuation. Claude Code: Stop additionalContext, shown as hook feedback rather than a hook error.
 * Codex has no Stop additionalContext and uses decision:block.
 */
export function stopRequest(provider: HookProviderName) {
  return JSON.stringify(provider === 'claude' ? { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: SAVE_REQUEST } } : { decision: 'block', reason: SAVE_REQUEST });
}
/** Stop output shared by both providers (Codex requires JSON or nothing on stdout). */
export const stopMessage = (message: string) => JSON.stringify({ systemMessage: message });
