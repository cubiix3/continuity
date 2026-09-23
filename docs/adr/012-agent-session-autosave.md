# 012: Agent session autosave

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
owns one entry per event and supports `--no-autosave`. `CONTINUITY_AUTOSAVE=0` is
a runtime kill switch.

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
  repository-controlled configuration on every stop. Shell-only edits are a
  documented gap.
- **Session summaries or changed-file lists:** rejected by policy.

## Consequences

- In `-p`/`exec` runs with edits, the save answer is the final message. Scripts
  that consume it set `CONTINUITY_AUTOSAVE=0` or install `--no-autosave`.
- Saving is best effort. Interruptions and crashes can skip it.
- Codex users trust the new hooks once in `/hooks`.
- No session tables, telemetry or transcripts are stored.
