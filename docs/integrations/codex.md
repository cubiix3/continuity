# Codex

Verified on Windows with codex-cli 0.155.1: project-bound MCP context, search,
source-backed memory proposals, and structured handoffs. A fresh Codex session
continued a task left by Claude using repository files and Continuity.

## Reproduce

Use the [fixture sequence](claude-code.md) with an already authenticated Codex CLI.
The runner starts a new `codex exec` invocation; it never uses `resume` or `fork`.
`--ephemeral` disables persisted session output. `--ignore-user-config` isolates the
test's configuration while preserving existing authentication.

Actual arguments (the script handles OS quoting):

```text
codex exec --ignore-user-config --ephemeral --sandbox workspace-write --json
  -c windows.sandbox="unelevated"
  -c mcp_servers.continuity.command="<node-executable>"
  -c mcp_servers.continuity.args=["<built-cli>","--home","<private-state>","--project","<project-a>","mcp"]
  -
```

The Windows setting is omitted on other platforms. The fixture runs the installed
npm Codex entry point with Node; `CODEX_ENTRY` can select another installed entry.
The runner does not copy credentials or alter global configuration. Its prompt is
sent on stdin and contains the task, not another agent's chat.

## Windows failure found in the real test

The first run omitted the Windows sandbox setting while ignoring user config.
MCP worked, but filesystem command execution was rejected by local policy and
Codex reported a read-only environment. It correctly saved a blocked handoff.
Claude's next session recognized the incomplete implementation and reported the
failure instead of claiming success.

Repeating the test with the existing host's `unelevated` Windows sandbox selected
explicitly allowed workspace edits. No full-access/bypass flag was used. Node's
default test subprocess isolation then hit `spawn EPERM` inside that sandbox;
Codex ran the same six fixture tests with `--test-isolation=none`. The fixture's
final verifier also runs the normal `node --test` command outside that sandbox.

Follow your organization's allowed sandbox configuration. A policy rejection is
not a reason to grant an agent arbitrary filesystem access. See the official
[Codex MCP guide](https://developers.openai.com/codex/mcp/) and
[Windows sandbox guide](https://developers.openai.com/codex/windows/).

Claude Code and Codex share the same adapter. No provider-specific logic is added
to the Core. Command Code, Grok, and RIVET remain unverified.

## Automatic startup context

`continuity integrate codex install` adds one `SessionStart` hook to
`~/.codex/hooks.json` (or `CODEX_HOME`). Codex runs hook commands through a shell:
PowerShell on Windows (`commandWindows` with the `&` call operator and single-quoted
paths), `sh` elsewhere. Plain stdout becomes developer context. Codex skips
user hooks until they are trusted once in `/hooks`. Verified with Codex 0.156.1 on
Windows using the installer's exact command strings (trust bypassed for the
test run only). See [agent bootstrap](../agent-bootstrap.md).

The same install adds `[mcp_servers.continuity]` to `config.toml`. Codex starts that
server once per session in the session's directory; it serves
`continuity_context`, `continuity_search` and `continuity_handoff_latest` for that
project, and no tools elsewhere. The daemon ends a session's server one to two minutes
after the session. ORCA mirrors `~/.codex/config.toml` into its own `CODEX_HOME` as it
does `hooks.json`. For a separate `CODEX_HOME` that is not mirrored, run the install
once with that `CODEX_HOME` set.

Verified with Codex 0.157.1 on Windows, in an isolated `CODEX_HOME`:
- the closed-handoff question used two structured Continuity calls and no CLI; before,
  it made four CLI calls and chased a closed handoff;
- the memory question found the note once the index listed its key.

Codex's `/new` can move the session into a new Git worktree under `CODEX_HOME`. That
checkout is not a registered Continuity workspace, so Continuity stays silent there. A
`CODEX_HOME` path longer than about 100 characters breaks Codex's daemon socket.

## Session autosave (Codex 0.157)

The same install adds the `PostToolUse` (`apply_patch`) and `Stop` hooks. Interactive
`codex` saves by default; nothing needs to be set:

- After an edit, the model ends its final answer with a `[continuity-save]: <…>` line.
  Codex renders it as a Markdown link reference definition and does not display it, so
  an edited turn looks like any other turn. Only if the line is missing does a
  short `Blocked by hook` request follow (see [ADR 014](../adr/014-autosave-in-the-final-answer.md)).
- Codex 0.157 runs interactive sessions in a shared app-server daemon, and their hooks
  run there. `codex exec` runs its hooks in its own process. Continuity offers a
  save only in the daemon, so scripted `codex exec` answers stay unchanged.
- Code mode (`exec` tool) edits are reported to hooks as `apply_patch`. Sub-agent
  edits count toward the parent session, and only the parent is asked.
- On Windows, Codex's daemon opens a console window for each command it starts,
  including its own `git` calls and every hook command (observed with 0.157.1 when
  Windows Terminal is the default terminal). This is Codex behaviour; each Continuity
  hook call adds one such window.
- `codex --no-daemon` looks exactly like `codex exec` to hooks and does not autosave
  unless started with `CONTINUITY_AUTOSAVE=1`.
- The daemon keeps the environment of the launch that started it, for every session
  until it restarts. A `CONTINUITY_AUTOSAVE` set on a later `codex` launch does not
  reach its hooks. Use `install --no-autosave` to turn autosave off for interactive
  Codex. Remove a `CONTINUITY_AUTOSAVE=1` that was set up for Codex before 0.157
  support.
- A `codex exec` started by your own Codex hook or `notify` program inherits the
  daemon environment and counts as interactive; set `CONTINUITY_AUTOSAVE=0` for it.

Verified live on Windows with Codex 0.157.0: an edit session saved a decision,
an unfinished task saved a handoff, Claude Code started with both, and `codex exec`
answers stayed exact. See [agent lifecycle](../agent-lifecycle.md) and
[ADR 013](../adr/013-codex-daemon-autosave.md).

ORCA launches Codex with its own `CODEX_HOME`. As observed with ORCA's Codex runtime
home on 2026-09-25, ORCA copies the `~/.codex/hooks.json` entries into that home and
trusts them itself, so no second install was needed. An ORCA-launched Codex received
Continuity's startup context.
