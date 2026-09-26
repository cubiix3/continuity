# 012: Agent session autosave

Amended by [ADR 014](014-autosave-in-the-final-answer.md): the save now travels in
the edited turn's final answer, and the `Stop` continuation below is the fallback.

Follows [ADR 011](011-agent-auto-bootstrap.md). Sessions should end with the
durable lessons and unfinished work that the next agent needs. The model decides
what to save, and Continuity's policy stays final.

## Decision

The provider `Stop` hook is the save point. In Claude Code and Codex it is the only
official hook that can still hand the same model a turn:

- `decision: block` with a reason makes the model continue;
- `stop_hook_active` marks that continuation.

`SessionEnd` runs after the model is gone and is not used. `PreCompact` is a
follow-up.

`Stop` fires every turn, so a request is made only after file-edit tools ran in
the session (flagged by `PostToolUse` from structured tool names), at most every
15 minutes. A continuation is never blocked again. The request asks for one
tagged JSON block (0–3 memories, an optional unfinished-work handoff) and no tool
calls. The next `Stop` parses only that block from `last_assistant_message` and
calls the existing memory policy and `createHandoff()`. `ProjectClient.proposeAll()`
submits several proposals against one source refresh.

Edits, request and answer must bind to the same project or workspace (a hashed scope
in the session flag). A Git checkout nested below the resolved root gets no writes.

Attribution comes from the provider (`agent`, `session_id`). Trust, status,
scope and provenance come from Core. The hook additionally drops:

- rule-kind memories;
- finished-task handoffs;
- oversized batches;
- anything that looks like a secret.

The trusted host binds the directory with the same resolver as bootstrap
(`session(path)`, lexical, never registering).

Per-session state is a content-free flag file under the Continuity home. Hooks exit
0, are silent on success and report anything not saved in one line. The installer
owns one entry per event and supports `--no-autosave`.

### Attended sessions only by default

The save turn replaces the provider's final answer, which breaks scripts that read
it. Autosave therefore runs by default only when the provider reports an attended
interactive session. Claude Code sets `CLAUDE_CODE_SESSION_ATTENDED` and
`CLAUDE_CODE_ENTRYPOINT` for its hooks. These are verified but undocumented, so an
unknown value means off.

Codex gives hooks no signal that separates `exec` from the TUI, so Codex autosave
is opt-in. `CONTINUITY_AUTOSAVE=1` forces autosave on, and any other non-empty value forces it off. `--no-autosave`
outranks everything, because the hooks are then absent. (Superseded for Codex 0.157
by [ADR 013](013-codex-daemon-autosave.md): daemon-hosted interactive sessions save by
default.)

### Handoff closure

An unfinished handoff stayed the latest work to continue forever. Closure is
lifecycle metadata in its own table (`status: done`, `closed_at`, `closed_by`,
optional `replaced_by`). The handoff record is never rewritten.

`ProjectClient.closeHandoff()` is bound to the client's project and workspace and is
idempotent. Bootstrap and the save request use the latest open handoff. The request
names that handoff's goal, and the answer's `close_handoff` can close only the id
the host recorded. There is no new MCP tool; people close handoffs through
`continuity handoff close`.

## Alternatives

- **Transcript mining at `SessionEnd`:** rejected. It is not the model's decision,
  it bypasses the conservative policy, and it reads chats.
- **Asking the model to call `continuity_memory_propose` /
  `continuity_handoff_create` over MCP:** rejected for this boundary. It needs an
  MCP server registration in another user config file (`~/.claude.json`,
  `config.toml`). It needs a directory-resolving server (the current
  `continuity mcp` binds one project root, not worktrees). It needs pre-approved
  tool permissions, or a permission prompt at every stop. Codex tool approvals and
  sandboxes also apply. The structured answer reaches the same Core calls with none
  of these. The MCP tools remain for agents that save explicitly.
- **A new `continuity_autosave` tool:** not needed.
- **Asking after every turn, or on any shell command:** rejected. Every chat turn
  would get an extra answer.
- **Detecting shell edits with `git status`:** rejected. It runs Git with
  repository-controlled configuration on every stop. Neither provider reports file
  mutations for shell commands, so shell-only edits are a documented gap.
- **Detecting `codex exec` from the parent process's command line or from
  `permission_mode`:** rejected. Command-line parsing is brittle. `permission_mode`
  reads `bypassPermissions` in interactive sessions with `approval_policy = "never"`,
  and `default` in `exec --approve-for-me`.
- **Rewriting a handoff's status in place, or a new `closed` status:** rejected.
  History stays immutable, and `done` is the existing terminal status.
- **Letting the model name handoff ids to close:** rejected. The host names the one
  handoff it offered.
- **Session summaries or changed-file lists:** rejected by policy.

## Consequences

- Scripted runs keep their final answer by default. A forced headless run
  (`CONTINUITY_AUTOSAVE=1`) ends with the save answer.
- Interactive Codex users opt in with `CONTINUITY_AUTOSAVE=1`. Headless runs of either
  provider started from that environment inherit it and should set `CONTINUITY_AUTOSAVE=0`.
  Since Codex 0.157, see ADR 013.
- Schema version 5 adds `handoff_closures`. Older Continuity versions refuse the
  upgraded database, as with every schema change.
- Saving is best effort. Interruptions and crashes can skip it.
- Codex users trust the new hooks once in `/hooks`.
- No session tables, telemetry or transcripts are stored.
