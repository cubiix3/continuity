# Agent session lifecycle: load, work, save, close

Continuity closes the loop around an agent session without reading its transcript:

1. **Load.** `SessionStart` injects the read-only [bootstrap index](agent-bootstrap.md),
   including the latest open handoff.
2. **Work.** Native tools do the work. A `PostToolUse` hook on file-edit tools records
   only that this session edited files, and in which project or workspace. On the
   first edit of a turn it also gives the model the save contract as additional
   context, which neither provider displays.
3. **Save.** The model decides what future sessions must know and ends its final
   answer with one save line. The turn's `Stop` hook applies it through Core's
   existing memory and handoff APIs. There is no extra turn. Only if the line is
   missing does `Stop` ask once through a continuation.
4. **Close.** If the offer named an open handoff and the session finished its work,
   the save closes that handoff instead of creating a "task complete" handoff.

What the user sees after an edited turn:

| Provider | Normal case | Fallback (save line missing) |
| --- | --- | --- |
| Codex 0.157 TUI | Only the normal answer: the save line is a Markdown link reference definition, which Codex does not display | `Blocked by hook` with a three-line request, then nothing |
| Claude Code 2.1.280 | The normal answer plus the save line as one raw line at its end | A three-line `Stop hook feedback` request, then the save line |

Claude Code renders every assistant text, including link reference definitions and
HTML comments, and its Stop `suppressOutput` does not hide the continuation. Its
`MessageDisplay` hook was parsed but not applied to the screen in 2.1.280 (all tested on
Windows, 2026-09-26). One raw line is therefore the least Claude Code can show.

`continuity integrate claude install` and `continuity integrate codex install`
install all three hooks. Use `--no-autosave` to keep startup context only.

## When autosave runs

The save line becomes part of the provider's final answer (and the fallback save turn
replaces it), so autosave must not run in scripts that read that answer. It therefore
runs by default only in sessions the provider reports as interactive:

| Session | Default | Signal in the hook's environment |
| --- | --- | --- |
| Interactive `claude` | on | `CLAUDE_CODE_SESSION_ATTENDED=1` (or, without it, `CLAUDE_CODE_ENTRYPOINT=cli`) |
| `claude -p`, Agent SDK | off | `CLAUDE_CODE_SESSION_ATTENDED=0`, `CLAUDE_CODE_ENTRYPOINT=sdk-*` |
| Claude Code without either variable | off | — |
| Interactive `codex` (shared app-server daemon, the default) | on | `CODEX_DAEMON_SHUTDOWN_SOCKET`, and none of `CODEX_CI`, `CODEX_THREAD_ID`, `CODEX_SESSION_ID` |
| `codex exec`, and a `codex exec` an agent runs as a command | off | no daemon marker, or Codex's tool-command markers |
| `codex --no-daemon`, embedded fallback server | off | none: indistinguishable from `codex exec` |
| `codex exec` started by your own Codex hook or `notify` program | on (set `CONTINUITY_AUTOSAVE=0` there) | inherits the daemon marker without tool markers |

Claude Code sets both variables for its hooks (verified with 2.1.280 in interactive
and print sessions). They are not part of the documented hook contract, so an unknown
or missing value means off.

Codex hook input is identical in `codex exec` and the interactive TUI (verified with
0.156.1 and 0.157.0): no field names the mode, and `permission_mode` follows the
approval policy, not the mode. Since 0.157 the TUI runs its sessions in a shared
app-server daemon, and their hooks run in that daemon's process tree. `codex exec`
has no daemon mode and runs its hooks in its own process. The daemon's processes
carry `CODEX_DAEMON_SHUTDOWN_SOCKET`. Commands that Codex runs as tools inherit it
as well, so a `codex exec` started by an agent sees it too. Codex also gives those
commands `CODEX_CI`, `CODEX_THREAD_ID` and `CODEX_SESSION_ID`, which none of the traced
hooks had. These variables are verified with 0.157.0 but undocumented. If Codex stops
setting the daemon marker, Codex autosave turns off. If it stopped setting all three
tool markers, a `codex exec` run by an agent would count as interactive. Re-verify
with each Codex version that changes the daemon or the hook environment.

A sub-agent's edit reaches `PostToolUse` with the parent's `session_id` (plus
`agent_id`, in both providers), so it counts toward the parent session. It gets no
offer, which would reach the sub-agent rather than the model that ends the turn. A
sub-agent ends with `SubagentStop`, which Continuity does not install, so only the
parent is asked: its own offer covers the turn, or the short fallback request follows.
A Codex sub-agent runs under its own `turn_id` (traced with 0.157), so a sub-agent's edit
never expires the parent's offer.

Codex documents that the daemon shares the environment it started with across all
of its sessions. A variable set when you launch `codex` reaches daemon-hosted hooks
only if that launch starts the daemon, and then for every session until the daemon
restarts. Parsing the parent process's command line was rejected as brittle.

Precedence, from strongest:

1. **Installed hooks.** `install --no-autosave` removes the autosave hooks, and
   nothing can turn autosave on.
2. **`CONTINUITY_AUTOSAVE`.** `1` forces autosave on. `0`, or any other non-empty
   value such as `off` or `true`, forces it off. It applies where the hook inherits
   it: Claude Code, `codex exec`, `codex --no-daemon`, and a Codex daemon only if the
   variable was set when the daemon started.
3. **The provider default** above.

Interactive Codex needs no setting. If you added `CONTINUITY_AUTOSAVE=1` for Codex
before Codex 0.157 support, remove it. A daemon started from that environment would
also force autosave for every `codex exec` that an agent runs. To autosave in a
`--no-daemon` Codex session,
start it with `CONTINUITY_AUTOSAVE=1`. Every provider started from that environment
inherits the variable, including `codex exec` and `claude -p`, whose final answers
then carry a save line. Scripts there should set `CONTINUITY_AUTOSAVE=0`. A forced
headless run (`CONTINUITY_AUTOSAVE=1 claude -p …`) ends its final message with the
save line, or with the fallback save answer.

With autosave off, both hooks exit right after dispatch. This costs about 5 ms over
starting the CLI, and they write no files.

## Why `PostToolUse` context and `Stop`

Two official hooks in each provider can still reach the model during work. This was
verified against Claude Code 2.1.280, and Codex 0.156.1 and 0.157.0.

| Hook | Model-aware | Use |
| --- | --- | --- |
| `PostToolUse` (both) | Yes: `hookSpecificOutput.additionalContext` reaches the model before it continues the turn; neither provider displays it | Edit flag and save offer |
| `Stop` (Claude Code, Codex) | Yes: a continuation (Claude Code: Stop `additionalContext`, since 2.1.163; Codex: `{"decision":"block","reason":…}`) makes the same model continue; `stop_hook_active` marks it | Applies the save; fallback request |
| `SessionEnd` (both) | No: runs after the model is gone, cannot block, short budget | Not used |
| `PreCompact` (both) | Not reliably: no documented way to give the model a turn | Follow-up |

Any continuation is visible. Codex 0.157's `Stop` output offers `decision`,
`continue`, `stopReason`, `suppressOutput` and `systemMessage`; its `suppressOutput`
hides neither the `Blocked by hook` line nor the continuation. Claude Code shows a
blocking reason as a red `Stop hook error`, and Stop `additionalContext` as a
`Stop hook feedback` line. That is why the contract comes with the edit, and the save
travels in the answer the user reads anyway.

The offer is gated:

- only on file-edit tools of this session (Claude Code:
  `Edit|Write|MultiEdit|NotebookEdit`; Codex reports edits as `apply_patch`, including
  `tools.apply_patch(…)` calls from code mode's `exec` tool, which Codex 0.157 reports
  under the nested tool's name);
- once per turn: the first edit gets it, and later edits of the turn are covered by it.
  The offer remembers a hash of the turn (Codex `turn_id`, Claude Code `prompt_id`). An
  offer whose turn ended without a `Stop` (an interrupted turn) no longer counts: the
  next edit is offered again, and a turn without edits of its own is never asked. The
  next edited turn's save covers the session; if no edit follows, the interrupted
  turn's edits are not asked about;
- not for a sub-agent's edit, and not when edits span several projects or workspaces.

`Stop` fires after every turn. It reads a save only if an offer or request is
outstanding, and it applies the save only if the stop binds to the same project or
workspace as the offer. The fallback request is gated further:

- only when the offered turn's own answer has no save line, or edits happened without
  an offer (a sub-agent's);
- only when the stop binds to the same project or workspace as the edits (a session that
  edited several, or moved elsewhere with `cd`, is not asked);
- at most once per 15 minutes per session. Edits that fall into that window without a
  save are dropped, rather than asked about on a later turn;
- never on a stop that is already a continuation (`stop_hook_active`). Continuity can
  therefore not loop, and it never re-blocks another hook's continuation.

A question-only or read-only session sees nothing and writes nothing.

## The save contract

The offer is `PostToolUse` additional context, about 1 KB (1.4 KB at most with an
open handoff). It asks the model to
end its final answer with an empty line and then this line, and not to mention it:

```text
[continuity-save]: <{"memories":[],"handoff":null}>
```

CommonMark treats that line as a link reference definition, which is not displayed.
It must follow an empty line; otherwise it is a paragraph line and shows. The JSON stays
on the one line, with `<` and `>` inside strings written as `\u003c` and `\u003e`.
The parser also accepts a line without those escapes, which then renders visibly.

- `memories`: 0–3 durable, non-obvious lessons or decisions
  (`key`, `kind` of `decision|experience|memory`, one-sentence `text`, and
  `source_path` only if that file contains the text verbatim). Never test or build
  results, changed-file lists, generic advice, guesses, secrets or chat. Empty is
  normal.
- `handoff`: only for meaningful unfinished work, including parts deferred to a later
  session (`goal`, `status` of `in_progress|blocked`, `remaining`, `decisions`,
  `risks`, `next`). Otherwise `null`.

If the workspace has an open handoff, the offer adds one line naming its goal (at
most 160 characters, no id). The save may then add `"close_handoff":true`, but
only if that work is finished or a new handoff in the same save fully replaces it.
If that replacement is not saved (invalid, or looks like a secret), the open
handoff stays open.
An open handoff that looks sensitive is not offered.

Only the last save line in the final answer of an offered turn, or in the answer to
the fallback request, is read. A save line in any other answer is ignored, and so is
one inside fenced code (quoted content, such as an example). The label is
case-insensitive, as in CommonMark. The `<continuity-save>{…}</continuity-save>`
block of earlier releases is no longer read; a request left outstanding by an earlier
release expires silently.

**Fallback request.** If the offered turn's final answer has no save line, or a
sub-agent's edit was never offered, `Stop` asks once, in 396 bytes. The request
carries its own template, because the model may never have seen the offer or may
have lost it to compaction:

```text
Continuity save check (automatic, once): reply with only this line, filled in or left empty, and no tool calls:
[continuity-save]: <{"memories":[],"handoff":null}>
memories: 0-3 durable lessons or decisions a future agent must know, {"key":"area.topic","kind":"decision|experience|memory","text":"..."}; handoff: unfinished work {"goal":"...","status":"in_progress|blocked","next":"..."} or null.
```

The answering stop applies the save, with or without `stop_hook_active`.

## What the hook enforces

The model supplies claims, not policy. The hook takes only key, kind, text and
`source_path` for memories, the listed handoff fields, and the `close_handoff` flag.
Attribution is fixed: `agent` is `Claude Code` or `Codex`, and `session` is the
provider's `session_id`.

Core then decides trust, status, scope and provenance as for any other proposal:

- attributed lessons activate with `agent_observation` trust;
- routine output, generic advice and speculation are rejected;
- a `source_path` claim needs an exact excerpt in the current source snapshot
  (`derived`), otherwise it is quarantined;
- a conflicting key is quarantined. A human-accepted memory is never overridden, and
  the next session start reports the conflict;
- duplicates are not stored twice.

Before Core, the hook drops:

- `rule`-kind memories (project rules come from project files);
- `done` handoffs (a finished task is not a handoff);
- more than five memories;
- anything that looks like a secret, checked per raw field;
- items the model malformed (an unknown `kind`, an invalid handoff status).

A handoff without `next` uses its first `remaining` item as the next action.
Handoffs never carry `completed` or `files_changed` from autosave.

A close applies only to the handoff id the host recorded when it made the offer or
request. The model never supplies an id. Closing a handoff that is already closed is
a quiet no-op.

A save is silent, including an empty one. Policy outcomes are normal and also silent:
a rejected, quarantined, duplicate or skipped item (a secret, a `rule`, a `done`
handoff, a malformed item) is not reported, because the user cannot act on it. Conflicts appear in the next session start and in the
Dashboard. Only a failure produces one `systemMessage` line, without item text and
without a stack trace, for example:

- `Continuity: save skipped — database busy.`
- `Continuity: save incomplete — 1 of 2 not saved (database busy).`
- `Continuity: save skipped — the session moved to another project or workspace.`
- `Continuity: save skipped — this turn edited more than one project or workspace.`

## Handoff closure

Handoffs stay immutable history. Closing one records lifecycle metadata in a separate
table: `status` `done`, `closed_at`, `closed_by` (`agent`, `session`) and, when a new
handoff took over, `replaced_by`. The original goal, lists and provenance are never
rewritten.

- **Reads:** handoff reads (`handoff latest|show`, MCP `continuity_handoff_latest`,
  the Dashboard) include `closure`. The Dashboard shows a closed handoff as done.
- **Bootstrap and the save offer** use the latest *open* handoff in the workspace.
  Closed handoffs are skipped. If the newest remaining handoff was created as `done`,
  its work is finished and nothing older is offered. A closed or finished handoff stays inspectable but
  is no longer presented as work to continue.
- **Older open handoffs:** if the newest open handoff is closed, an older handoff that
  is still open is shown again. A replaced handoff is closed with `replaced_by`, so it
  does not come back.
- **Withheld handoffs:** a newest open handoff withheld as sensitive is never
  replaced by an older one.
- **Authorization:** a close is bound to the client's project and workspace. A
  replacement must be another handoff of the same workspace.
- **Manual close:** `continuity handoff close <id> --agent <name> --session <ref>`
  closes a handoff by hand.

There is no additional MCP tool. Agents close handoffs through the lifecycle, and
people close them through the CLI.

## Binding

The same resolver as bootstrap binds the hook's `cwd`:

- the nearest registered project or workspace root;
- a nested project resolves to itself;
- an attached Git worktree saves into its workspace;
- a registered worktree root that no longer links into the project gets nothing;
- a Git checkout nested below the resolved root (an unregistered worktree such as
  `.claude/worktrees/<name>`, a submodule or a nested repository) gets nothing, because
  its files and evidence are a different tree. Register it as a workspace instead.

The edit flag records a hash of the bound project and workspace. The save is
applied only if the stop binds to that same scope; otherwise the hook reports in one
line that nothing was saved.

Unregistered directories are silent and never written. Project, workspace and trust
fields in the model's answer are ignored.

## Failure behaviour

Hooks always exit 0 and continue a turn only through the documented JSON output.
Continuity never blocks a provider exit. No output is produced when:

- Continuity state is missing;
- the directory is unregistered;
- the input is unreadable or over 1 MiB;
- autosave is off for the session.

The per-session flag is written before the offer is shown and before a save is
applied, so a timeout or crash cannot cause a second request or apply an answer
twice. If the database is locked past SQLite's busy timeout while a save is applied,
the hook reports `Continuity: save skipped — database busy.` The edit hook opens the
store to bind the edit. If the store is locked past the busy timeout, that edit is
neither flagged nor offered; this is an accepted residual, because provider
responsiveness wins over a longer wait. The `Stop` hook timeout is 60 seconds.

Saving is best effort. A session interrupted with Ctrl+C, closed while the model is
still answering, or crashed may end without a save.

Edits made only through shell commands (for example `Move-Item`, `sed -i`) do not flag
the session. Neither provider reports file mutations for shell commands: Claude Code's
`FileChanged` watches named files only, and `PostToolUse` for `Bash` carries no
modified-file field. Codex 0.157 reports shell commands, including those run from code
mode, as `Bash` with no mutation data. Treating every shell command as an edit, parsing
commands, running Git on every stop, or watching the project directory during a
session was rejected. A watcher cannot tell whether an agent, an editor, a build or
another session changed a file. This remains a follow-up.

## Privacy and state

Autosave does not archive chats:

- The transcript and `transcript_path` are never opened, and tool inputs and outputs
  are never read.
- The only text read is `last_assistant_message`, and only on a stop that ends an
  offered turn or answers Continuity's request.
- Autosave adds no tables, event logs or telemetry. Saved memories and handoffs
  record their author (agent and session id) like any attributed write, and a
  handoff's author session is also a row in the existing `sessions` table.

Per session, the hook keeps one small file under `<continuity home>/hooks/autosave/`,
named by a hash of provider and session id. It contains
`{"dirty":…,"pending":…,"offered":…,"asked":…,"turn":…,"prompted_at":…,"scope":…,"close":…}` and nothing
else:

- `dirty`: edits not yet covered by an offer; `pending`: an offer (`offered`) or a
  fallback request (`asked`) is outstanding; `turn`: a hash of the turn id the offer
  was made in; `prompted_at`: the last request;
- `scope` is a hash of the project and workspace ids;
- `close` is the id of the offered handoff while the offer or request is outstanding.

A linked state directory is never written. Files older than seven days are removed.

## Installer

`install` adds or repairs exactly one Continuity entry per event and keeps foreign
hooks and their order.

- An older bootstrap-only install shows as `partial`, and `install` upgrades it.
- `install --no-autosave` removes Continuity's `PostToolUse` and `Stop` entries;
  `status --no-autosave` checks that shape.
- `remove` deletes all Continuity entries and nothing else.

The autosave defaults and the closure behaviour live in the CLI, not in the hook
entries. Upgrading Continuity therefore needs no reinstall unless the CLI path
changes.

Entries are recognized by their fixed marker
(`integrate <provider> session-start|tool-use|stop`) and the Continuity CLI path, and
compared exactly. Any change shows as `stale` until `install` runs again. Codex
requires trusting the new hooks once in `/hooks`; `status` cannot see that trust.
ORCA runs Codex with its own `CODEX_HOME`. It copies the hooks from `~/.codex/hooks.json`
into that home and trusts them itself (observed with ORCA's Codex runtime home on
2026-09-25). No second install is needed there.

## Measurements

Windows, Node 24, 401-source project, 7 runs each, medians:

| Path | Runtime stopped | Runtime running |
| --- | --- | --- |
| `PostToolUse` edit flag | 212 ms | 226 ms |
| `Stop`, save request | 214 ms | 227 ms |
| `Stop`, apply 2 memories + handoff | 426 ms (max 514) | 455 ms (max 479) |
| `Stop`, close the offered handoff | 228 ms | 237 ms |
| Autosave off, per hook | 207–208 ms | 219–220 ms |
| `continuity --version` (baseline) | 202 ms | 214 ms |

Almost all of the fast paths is Node start-up and opening the store. Applying a save
refreshes the source snapshot once (`ProjectClient.proposeAll`), which is how exact
source claims are verified. No sync, Doctor, semantic backend, network or external
model is involved.

These tables were measured with the earlier `Stop` request (ADR 012). The offer
(ADR 014) was measured against it on the same small fixture (Windows, Node 24, runtime
stopped, 7 runs each, medians and max):

| Path | Before (`Stop` request) | Offer in the answer |
| --- | --- | --- |
| `PostToolUse` | 200 ms (207), edit flag | 203 ms (204), edit flag + offer |
| `Stop` that asks | 204 ms (208), every edited turn | 200 ms (206), fallback only |
| `Stop`, apply an empty save | 200 ms (209) | 199 ms (202) |
| `PostToolUse`, autosave off | — | 195 ms (198) |
| `continuity --version` (baseline) | — | 189 ms (192) |

The offer reads the latest open handoff; the extra `Stop` round trip of every edited
turn is gone.

Codex paths, Windows, Node 24, 132-source project, 7 runs each, medians (max):

| Path | Runtime stopped | Runtime running |
| --- | --- | --- |
| Interactive (daemon): `PostToolUse` edit flag | 202 ms (206) | 205 ms (211) |
| Interactive: `Stop`, save request | 206 ms (209) | 202 ms (218) |
| Interactive: `Stop`, apply 2 memories + handoff | 285 ms (300) | 274 ms (286) |
| `codex exec`: edit hook, autosave off | 198 ms (206) | 195 ms (200) |
| `codex exec`: `Stop`, autosave off | 198 ms (202) | 195 ms (203) |
| `continuity --version` (baseline) | 192 ms (210) | 190 ms (197) |

The mode check reads only environment variables.

## Live evidence

Opt-in runs, not CI, with Claude Code 2.1.280, and Codex 0.156.1 and 0.157.0. None of
the prompts mentioned Continuity.

**Save in the answer (ADR 014, 2026-09-26).** Isolated fixture and Continuity home,
plain `claude` and plain `codex` (daemon), screens read, no transcripts:

| Session | What the user saw | Saved |
| --- | --- | --- |
| Claude Code: add a key, user states that keys stay sorted | Normal answer, then one raw `[continuity-save]: <…>` line | Decision, `agent_observation`, Claude Code |
| Claude Code: read-only question | Normal answer only | Nothing, no state file |
| Claude Code: rename one value | Normal answer and an empty save line | Nothing |
| `claude -p`, edit, reply `DONE-EDIT` | Exactly `DONE-EDIT` | Nothing, no state file |
| Codex: add a key, user states an ASCII rule | Normal answer only | Nothing: the model chose an empty save (before "decisions the user stated" was added to the contract) |
| Codex: add a key, user states snake_case keys | Normal answer only | Decision, `agent_observation`, Codex |
| `codex exec`, edit, reply `DONE-EDIT` (hooks trusted and running) | Exactly `DONE-EDIT` | Nothing, no state file |

No `Stop` continuation was needed in these runs. The fallback's rendering was checked
with a probe hook: Claude Code shows `Stop hook feedback: …` and Codex
`Blocked by hook └ …`, each followed by the reply.

**Headless default.** A `claude -p` and a `codex exec` session each edited a file and
were asked to reply `DONE-EDIT`:

- Both final answers were exactly `DONE-EDIT`, and nothing was saved.
- Forced with `CONTINUITY_AUTOSAVE=1`, both final answers were the save block, as
  documented (ADR 012 flow).

**Full lifecycle (Codex 0.156.1).** Scripted, with autosave forced on:

| Session | What happened |
| --- | --- |
| Claude Code A | Completed a locale edit; saved one lesson about the loader |
| Codex B | Started with that lesson; did half of a two-file task, as asked; saved a handoff for the deferred file |
| Claude Code C | Told only "Please finish the unfinished work in this project"; finished the work and answered with `close_handoff` and no new handoff; the handoff was closed |
| Codex D | Reported the lesson and no unfinished work; bootstrap had no open handoff |

**Codex 0.157.0, interactive, no override.** Plain `codex` in a fixture, hooks trusted
once in `/hooks`, no `CONTINUITY_AUTOSAVE` anywhere. A tracer confirmed that every hook
ran in the app-server daemon without that variable. The model used code mode, and its
nested `tools.apply_patch` calls reached the `apply_patch` hook.

| Session | What happened |
| --- | --- |
| Codex A | Merged two config files; asked automatically; answered with no memory and no handoff |
| Codex A2 | Applied a header convention the user had decided; saved it as a decision attributed to Codex |
| Claude Code B | Asked "What should I know before continuing?"; started with the Codex decision |
| Codex C | Did part 1 of a two-part task, as asked; saved a lesson and a handoff for part 2 |
| Claude Code D | Asked "What should I continue?"; started with the Codex handoff, finished it and closed it |
| Codex E | Renamed one label; asked; saved nothing |
| Codex F | Read-only question; no request, no state file |
| `codex exec` | Read-only and edit runs printed exactly `memory` and `DONE`; no request, no state file |

A `codex exec` that the interactive agent ran as a command printed exactly its answer.
Its hooks saw the daemon marker and Codex's tool-command markers. A traced sub-agent's
`apply_patch` arrived under the parent's session id. The sub-agent ended with
`SubagentStop`, and only the parent's `Stop` followed.

**Earlier runs.**

- For a task containing an API key, the model saved nothing, and the key is not in the
  store.
- A read-only question produced no request.
- In one Codex run the model changed a file only through the shell, and no request
  was made.
