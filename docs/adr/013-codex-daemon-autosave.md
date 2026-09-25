# 013: Codex autosave in daemon-hosted sessions

Amends [ADR 012](012-agent-session-autosave.md) for Codex 0.157 (issue #24).

## Context

ADR 012 made Codex autosave opt-in with `CONTINUITY_AUTOSAVE=1`, because hook input
does not separate the TUI from `codex exec`. Codex 0.157 broke that opt-in for the
TUI. Interactive sessions now run in a shared app-server daemon, and their hooks run
in the daemon's process tree. Codex documents that the daemon keeps the environment
it started with for all clients, so a variable set when launching `codex` does not
reach those hooks. Interactive Codex never saved, even when the user opted in.

A research tracer with Codex 0.157.0 on Windows recorded hook metadata and
environment names for the TUI, `codex exec`, and a `codex exec` run by an agent.
It recorded no content.

- Edits reach `PostToolUse` as `apply_patch` in both modes. That includes code mode
  (`exec` tool), whose nested `tools.apply_patch(...)` calls are reported under the
  nested name. The installed matcher was never the problem.
- Shell commands, including shell edits, reach `PostToolUse` as `Bash` with no
  mutation data.
- Hook input keys are identical in both modes. No field or hook output gives the
  model a turn without a visible continuation.
- Only daemon-hosted hooks carry `CODEX_DAEMON_SHUTDOWN_SOCKET`. `codex exec` has no
  daemon mode and runs hooks in-process without it.
- Commands that Codex runs as tools inherit that variable, so a nested `codex exec`
  sees it. Those commands, and only they, also carry `CODEX_CI`, `CODEX_THREAD_ID`
  and `CODEX_SESSION_ID`.
- `codex --no-daemon` (and the embedded fallback server) run hooks in-process with
  no marker. They are indistinguishable from `codex exec`.

## Decision

Codex autosave is on by default when the hook runs in the app-server daemon:
`CODEX_DAEMON_SHUTDOWN_SOCKET` is non-empty and none of Codex's tool-command markers
is set. Otherwise it stays off. The precedence of ADR 012 is unchanged
(`--no-autosave`, then `CONTINUITY_AUTOSAVE`, then the provider default).

Edit detection stays provider-native: the existing `apply_patch` `PostToolUse` flag,
keyed by provider and session id. Save policy, trust, scope binding and closure are
unchanged.

## Alternatives

- **Treat every `exec` or `Bash` call as an edit, or parse commands:** rejected.
  Guesswork, and a read-only session would be asked to save.
- **Git status or diff at `Stop`:** rejected (ADR 012). It adds latency, runs
  repository-controlled Git configuration and adds worktree complexity.
- **Watch the project directory during a session or a tool call:** rejected. A
  change cannot be attributed to this session rather than an editor, a build, the
  runtime, or another agent in the same workspace. Codex already reports its own
  edits.
- **Parent process command line (`codex exec` vs `codex app-server`):** rejected
  again. It is brittle, and on Windows each check costs a PowerShell/CIM call.
- **Ask at the next `UserPromptSubmit` instead of `Stop`:** rejected. The last task
  of a session would never be saved, and `exec resume` scripts would still be hit.
- **Keep Codex opt-in:** rejected. It does not work for daemon-hosted sessions and
  does not meet the zero-command goal.

## Consequences

- Plain interactive `codex` saves with no setting, like interactive Claude Code.
- `codex exec` output is unchanged, including an exec run by an agent inside an
  interactive session.
- `--no-daemon` sessions and app-server hosts without the daemon marker stay off.
  `CONTINUITY_AUTOSAVE=1` still works for them, because their hooks inherit the
  launch environment.
- The markers are verified with 0.157.0 but undocumented. If Codex renames them,
  Codex autosave turns off rather than touching `exec` output. If a future `codex exec`
  ran inside the daemon, this decision must be revisited.
- Shell-only edits remain a documented gap for both providers.
