# Agent session lifecycle: load, work, save, close

Continuity closes the loop around an agent session without reading its transcript:

1. **Load.** `SessionStart` injects the read-only [bootstrap index](agent-bootstrap.md),
   including the latest open handoff.
2. **Work.** Native tools do the work. A `PostToolUse` hook on file-edit tools records
   only that this session edited files, and in which project or workspace.
3. **Save.** When a turn that edited files ends, a `Stop` hook asks the same model
   once to decide what future sessions must know. The model answers with one tagged
   JSON block. The next `Stop` applies that block through Core's existing memory and
   handoff APIs.
4. **Close.** If the request named an open handoff and the session finished its work,
   the answer closes that handoff instead of creating a "task complete" handoff.

`continuity integrate claude install` and `continuity integrate codex install`
install all three hooks. Use `--no-autosave` to keep startup context only.

## When autosave runs

The save turn becomes the provider's final answer, so it must not run in scripts
that read that answer. Autosave therefore runs by default only in sessions the
provider reports as interactive:

| Session | Default | Signal in the hook's environment |
| --- | --- | --- |
| Interactive `claude` | on | `CLAUDE_CODE_SESSION_ATTENDED=1` (or, without it, `CLAUDE_CODE_ENTRYPOINT=cli`) |
| `claude -p`, Agent SDK | off | `CLAUDE_CODE_SESSION_ATTENDED=0`, `CLAUDE_CODE_ENTRYPOINT=sdk-*` |
| Claude Code without either variable | off | — |
| Interactive `codex` (shared app-server daemon, the default) | on | `CODEX_DAEMON_SHUTDOWN_SOCKET`, and none of `CODEX_CI`, `CODEX_THREAD_ID`, `CODEX_SESSION_ID` |
| `codex exec`, and a `codex exec` an agent runs as a command | off | no daemon marker, or Codex's tool-command markers |
| `codex --no-daemon`, embedded fallback server | off | none: indistinguishable from `codex exec` |

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
commands `CODEX_CI`, `CODEX_THREAD_ID` and `CODEX_SESSION_ID`, which its hooks never
get. These variables are verified with 0.157.0 but undocumented. If Codex changes
them, Codex autosave turns off; it never takes over a `codex exec` answer.

Codex documents that the daemon shares the environment it started with across all
of its sessions. A variable set when you launch `codex` therefore does not reach the
hooks of a daemon-hosted session. Parsing the parent process's command line was
rejected as brittle.

Precedence, from strongest:

1. **Installed hooks.** `install --no-autosave` removes the autosave hooks, and
   nothing can turn autosave on.
2. **`CONTINUITY_AUTOSAVE`.** `1` forces autosave on. `0`, or any other non-empty
   value such as `off` or `true`, forces it off. It applies where the hook inherits
   it: Claude Code, `codex exec`, `codex --no-daemon`, and a Codex daemon only if the
   variable was set when the daemon started.
3. **The provider default** above.

Interactive Codex needs no setting. To autosave in a `--no-daemon` Codex session,
start it with `CONTINUITY_AUTOSAVE=1`. Every provider started from that environment
inherits the variable, including `codex exec` and `claude -p`, whose final answers
then become save answers. Scripts there should set `CONTINUITY_AUTOSAVE=0`. A forced
headless run (`CONTINUITY_AUTOSAVE=1 claude -p …`) ends with the save answer as its
final message.

With autosave off, both hooks exit right after dispatch. This costs about 5 ms over
starting the CLI, and they write no files.

## Why `Stop`

Only one official hook in each provider can still involve the model at the end of
work. This was verified against Claude Code 2.1.280, and Codex 0.156.1 and 0.157.0.
Codex 0.157's `Stop` output offers `decision`, `continue`, `stopReason`,
`suppressOutput` and `systemMessage`; none of them gives the model a turn without a
visible continuation.

| Hook | Model-aware | Use |
| --- | --- | --- |
| `Stop` (Claude Code, Codex) | Yes: `{"decision":"block","reason":…}` makes the same model continue with the reason as its next instruction; `stop_hook_active` marks that continuation | Save request |
| `SessionEnd` (both) | No: runs after the model is gone, cannot block, short budget | Not used |
| `PreCompact` (both) | Not reliably: no documented way to give the model a turn | Follow-up |
| `PostToolUse` (both) | No: structured tool metadata only | Edit flag |

`Stop` fires after every turn, so the request is gated:

- only after file-edit tools ran in this session since the last request (Claude Code:
  `Edit|Write|MultiEdit|NotebookEdit`; Codex reports edits as `apply_patch`, including
  `tools.apply_patch(…)` calls from code mode's `exec` tool, which Codex 0.157 reports
  under the nested tool's name);
- only when the stop binds to the same project or workspace as the edits (a session that
  edited several, or moved elsewhere with `cd`, is not asked);
- at most once per 15 minutes per session;
- never on a stop that is already a continuation (`stop_hook_active`). Continuity can
  therefore not loop, and it never re-blocks another hook's continuation.

A question-only or read-only session sees nothing and writes nothing.

## The save request

The request is the `Stop` reason, about 790 bytes and fixed. It asks for this and
nothing else:

```text
<continuity-save>{"memories":[],"handoff":null}</continuity-save>
```

- `memories`: 0–3 durable, non-obvious lessons or decisions
  (`key`, `kind` of `decision|experience|memory`, one-sentence `text`, and
  `source_path` only if that file contains the text verbatim). Never test or build
  results, changed-file lists, generic advice, guesses, secrets or chat. Empty is
  normal.
- `handoff`: only for meaningful unfinished work, including parts deferred to a later
  session (`goal`, `status` of `in_progress|blocked`, `remaining`, `decisions`,
  `risks`, `next`). Otherwise `null`.

If the workspace has an open handoff, the request adds one line naming its goal (at
most 160 characters, no id). The answer may then add `"close_handoff":true`, but
only if that work is finished or a new handoff in the same answer fully replaces it.
If that replacement is not saved (invalid, or looks like a secret), the open
handoff stays open and the hook reports it.
An open handoff that looks sensitive is not offered.

The model answers without tool calls. Only the last tagged block in the answer to
Continuity's own request is read; an untagged or unsolicited block is ignored.

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
- anything that looks like a secret, checked per raw field.

Handoffs never carry `completed` or `files_changed` from autosave.

A close applies only to the handoff id the host recorded when it sent the request.
The model never supplies an id. Closing a handoff that is already closed is a quiet
no-op.

A successful save is silent. If anything was rejected, quarantined, skipped or failed,
the hook reports it in one `systemMessage` line, for example
`Continuity autosave: 1 of 3 saved; memory 2: skipped: looks like a secret.`

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

The edit flag records a hash of the bound project and workspace. The answer is
applied only if the answering stop binds to that same scope; otherwise the hook
reports that nothing was saved.

Unregistered directories are silent and never written. Project, workspace and trust
fields in the model's answer are ignored.

## Failure behaviour

Hooks always exit 0 and block only with the explicit JSON decision. Continuity never
blocks a provider exit. No output is produced when:

- Continuity state is missing;
- the directory is unregistered;
- the input is unreadable or over 1 MiB;
- autosave is off for the session.

The per-session flag is written before any database work, so a timeout or crash
cannot cause a second request. If the database is locked past SQLite's busy timeout
while a save is applied, the hook reports that the save did not complete. The edit
hook opens the store to bind the edit. If the store is locked past the busy timeout,
that edit is not flagged; this is an accepted residual, because provider
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
- The only text read is `last_assistant_message` on the stop that answers
  Continuity's request.
- Autosave adds no tables, event logs or telemetry. A saved handoff records its
  author session (id, agent, time) like any other handoff.

Per session, the hook keeps one small file under `<continuity home>/hooks/autosave/`,
named by a hash of provider and session id. It contains
`{"dirty":…,"pending":…,"prompted_at":…,"scope":…,"close":…}` and nothing else:

- `scope` is a hash of the project and workspace ids;
- `close` is the id of the offered handoff while a request is outstanding.

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

With an open handoff offered, the save request is about 1.1 KB at most.

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

**Headless default.** A `claude -p` and a `codex exec` session each edited a file and
were asked to reply `DONE-EDIT`:

- Both final answers were exactly `DONE-EDIT`, and nothing was saved.
- Forced with `CONTINUITY_AUTOSAVE=1`, both final answers were the save block, as
  documented.

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
Its hooks saw the daemon marker and Codex's tool-command markers.

**Earlier runs.**

- For a task containing an API key, the model saved nothing, and the key is not in the
  store.
- A read-only question produced no request.
- In one Codex run the model changed a file only through the shell, and no request
  was made.
