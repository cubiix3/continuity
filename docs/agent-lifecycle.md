# Agent session lifecycle: load, work, save

Continuity closes the loop around an agent session without reading its transcript:

1. **Load.** `SessionStart` injects the read-only [bootstrap index](agent-bootstrap.md).
2. **Work.** Native tools do the work. A `PostToolUse` hook on file-edit tools records
   only that this session edited files, and in which project or workspace.
3. **Save.** When a turn that edited files ends, a `Stop` hook asks the same model
   once to decide what future sessions must know. The model answers with one tagged
   JSON block. The next `Stop` applies that block through Core's existing memory and
   handoff APIs.

`continuity integrate claude install` and `continuity integrate codex install`
install all three hooks. Use `--no-autosave` to keep startup context only.

## Why `Stop`

Only one official hook in each provider can still involve the model at the end of
work. This was verified against Claude Code 2.1.280 and Codex 0.156.1.

| Hook | Model-aware | Use |
| --- | --- | --- |
| `Stop` (Claude Code, Codex) | Yes: `{"decision":"block","reason":…}` makes the same model continue with the reason as its next instruction; `stop_hook_active` marks that continuation | Save request |
| `SessionEnd` (both) | No: runs after the model is gone, cannot block, short budget | Not used |
| `PreCompact` (both) | Not reliably: no documented way to give the model a turn | Follow-up |
| `PostToolUse` (both) | No: structured tool metadata only | Edit flag |

`Stop` fires after every turn, so the request is gated:

- only after file-edit tools ran in this session since the last request (Claude Code:
  `Edit|Write|MultiEdit|NotebookEdit`; Codex reports edits as `apply_patch`);
- only when the stop binds to the same project or workspace as the edits (a session that
  edited several, or moved elsewhere with `cd`, is not asked);
- at most once per 15 minutes per session;
- never on a stop that is already a continuation (`stop_hook_active`). Continuity can
  therefore not loop, and it never re-blocks another hook's continuation.

A question-only or read-only session sees nothing and writes nothing.

## The save request

The request is the `Stop` reason: about 790 bytes, fixed, with no project data. It
asks for this and nothing else:

```text
<continuity-save>{"memories":[],"handoff":null}</continuity-save>
```

- `memories`: 0–3 durable, non-obvious lessons or decisions
  (`key`, `kind` of `decision|experience|memory`, one-sentence `text`, and
  `source_path` only if that file contains the text verbatim). Never test or build
  results, changed-file lists, generic advice, guesses, secrets or chat. Empty is
  normal.
- `handoff`: only for meaningful unfinished work, including parts deferred to a later session
  (`goal`, `status` of `in_progress|blocked`, `remaining`, `decisions`, `risks`, `next`).
  Otherwise `null`.

The model answers without tool calls. Only the last tagged block in the answer to
Continuity's own request is read; an untagged or unsolicited block is ignored.

## What the hook enforces

The model supplies claims, not policy. The hook takes only key, kind, text and
`source_path` for memories and the listed handoff fields. Attribution is fixed:
`agent` is `Claude Code` or `Codex`, and `session` is the provider's `session_id`.
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
- anything that looks like a secret.

Handoffs never carry `completed` or `files_changed` from autosave.

A successful save is silent. If anything was rejected, quarantined, skipped or failed,
the hook reports it in one `systemMessage` line, for example
`Continuity autosave: 1 of 3 saved; memory 2: skipped: looks like a secret.`

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
blocks a provider exit. Missing Continuity state, an unregistered directory,
unreadable input, input over 1 MiB or `CONTINUITY_AUTOSAVE=0|off|false` all mean no
output.

The per-session flag is written before any database work, so a timeout or crash
cannot cause a second request. If the database is locked past SQLite's busy timeout
while a save is applied, the hook reports that the save did not complete. The `Stop`
hook timeout is 60 seconds.

Saving is best effort. A session interrupted with Ctrl+C, closed while the model is
still answering, or crashed may end without a save. Edits made only through shell
commands (for example `Move-Item`, `sed -i`) do not flag the session. Detecting them
would mean treating every shell command as an edit, or running Git inside
repositories on every stop. Neither is done.

## Privacy and state

Autosave does not archive chats:

- The transcript and `transcript_path` are never opened, and tool inputs and outputs
  are never read.
- The only text read is `last_assistant_message` on the stop that answers
  Continuity's request.
- There are no session tables, event logs or telemetry.

Per session, the hook keeps one small file under
`<continuity home>/hooks/autosave/`, named by a hash of provider and session id. It
contains `{"dirty":…,"pending":…,"prompted_at":…,"scope":…}` (the scope is a hash of
project and workspace ids) and nothing else. A linked state directory is never
written. Files older than
seven days are removed.

In `claude -p` or `codex exec`, the answer to the save request becomes the final
message of the run. Set `CONTINUITY_AUTOSAVE=0` for scripted runs whose final
message is consumed, or install with `--no-autosave`.

## Installer

`install` adds or repairs exactly one Continuity entry per event and keeps foreign
hooks and their order. An older bootstrap-only install shows as `partial` and is
upgraded by `install`. `install --no-autosave` removes Continuity's `PostToolUse` and
`Stop` entries; `status --no-autosave` checks that shape. `remove` deletes all
Continuity entries and nothing else.

Entries are recognized by their fixed marker (`integrate <provider> session-start|tool-use|stop`)
and the Continuity CLI path, and compared exactly. Any change in a later version
shows as `stale` until `install` runs again. Codex requires trusting the new hooks
once in `/hooks`.

## Measurements

Windows, Node 24, 401-source project, 7 runs each, medians:

| Hook | Runtime stopped | Runtime running |
| --- | --- | --- |
| `PostToolUse` edit flag | 220 ms | 206 ms |
| `Stop`, nothing to do | 216 ms | 201 ms |
| `Stop`, save request | 213 ms | 208 ms |
| `Stop`, apply 2 memories + handoff | 459 ms (max 504) | 433 ms (max 522) |

Almost all of the fast paths is Node start-up and opening the store. Applying a save
refreshes the source snapshot once (`ProjectClient.proposeAll`), which is how exact
source claims are verified. No
sync, Doctor, semantic backend, network or external model is involved.

## Live evidence

Opt-in runs, not CI:

- **Claude Code 2.1.280**, fresh `-p` sessions without any Continuity prompt:
  - A completed edit saved one lesson and no handoff.
  - An unfinished migration saved a handoff, which the next session start showed.
  - A read-only question produced no request and no writes.
  - For a task containing an API key, the model saved nothing, and the key is not in
    the store.
- **Codex 0.156.1**, `codex exec`:
  - An edit session was asked once. The model deliberately answered with nothing to
    save, because the lesson was already a code comment.
  - An unfinished task saved a handoff that the next Claude Code session start
    showed. Before the instruction named work deferred to a later session, one run
    answered with no handoff for the same task.
  - A read-only question was not asked.
  - In one earlier run the model renamed a file only through the shell, and no
    request was made.
- **Cross-provider:** after Claude Code sessions saved a lesson and a handoff, fresh
  Codex sessions asked "What should I know before continuing here?" answered with
  that lesson and handoff.
