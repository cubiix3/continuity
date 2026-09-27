# 017: Shell-made edits start autosave

Amends [ADR 014](014-autosave-in-the-final-answer.md) (issue #34).

## Context

Autosave offers a save after the first file edit of a turn, and until now only Claude Code's edit tools counted.
Claude Code 2.1.283 defaults to auto mode, and in live runs it made every edit through its Bash tool: a shell write,
`sed -i`, a script. No offer was made, and the lesson the model had noticed was lost.

Traced with an isolated probe that logged only key names, types and sizes:
- **Bash in a Git tree.** Claude Code's `PostToolUse` input carries `tool_response.bashEditDiff`
  (`files[{ filePath, hunks }]`, `moreFiles`, `changedFiles` as absolute paths) only when files changed.
  - It covers indirect edits (a script) and new files.
  - It is a before/after comparison of the working tree over the command, so it also listed files that another
    process changed while a read-only command ran, including files the command never named.
- **Bash without Git.** The same edit carries no report.
- **PowerShell tool.** It carries no report either, even when files changed.
- **Turns.** `prompt_id` stays the same through a turn, even when the user sends a message while the agent works.

## Decision

- **Matcher.** Claude Code's `PostToolUse` matcher also covers `Bash|PowerShell`.
- **Provider signal first.**
  - Bash in a Git tree: the report's `changedFiles` decide.
  - No report means nothing changed, and the CLI entry answers that case before the CLI loads.
  - Continuity reads only the changed paths and `duration_ms`, never the command, its output or file contents.
- **Bounded fallback** where the provider reports nothing (PowerShell, or Bash outside Git):
  - it finds the workspace's indexed files modified during the command, and new files in their directories;
  - it takes no full-tree walk and no Git process: the source scope bounds it (631 files in 4 ms on the largest
    registered project here);
  - it does not see files outside the index or its directories, and it does not count deletions.
- **What counts.**
  - Each path binds like a session directory; a deleted path binds through its nearest existing ancestor.
  - Paths outside every registered project, in a nested checkout, or with a denied component do not count. The
    denied components are the source scanner's rule, now shared from Core: dependencies, build output, VCS and
    Continuity state, and secret-looking names.
  - The local source scope is not used as a filter: an edit outside it is still project work.
  - Paths in several scopes make the edit `mixed`, so nothing is saved.
- **Attribution.**
  - Every attributed edit (edit tools, `apply_patch` and shell edits) records a timestamp per scope and session.
  - A shell report is ambiguous, and counts for nothing, when another session recorded an edit of the same scope
    after the command started (its duration plus 1.5 s).
- **Same state machine.** The resulting scope goes through the existing offer state machine: turns, interruption,
  sub-agents, `mixed`, and one offer per turn.

## Alternatives

- **Git status as the sensor:** rejected. It is slow on large trees and fails outside Git, and it is exactly what the
  provider report already does.
- **Parsing command strings** (`sed`, `>`, `python`): rejected. It is unreliable and reads the command.
- **Every Bash call counts as an edit:** rejected. `ls`, `git status` and test runs would draw an offer every turn.
- **A full-tree scan before and after every command:** rejected. It is O(repository) per shell call.
- **The background runtime's watchers:** not used. Autosave must work with the runtime stopped.

## Consequences

- **Auto-mode shell edits** now draw the same quiet offer as edit tools.
- **Cost per call.**
  - A read-only Bash call in a Git tree costs about 37 ms; bare Node is 30 ms.
  - Other hook calls load less of the CLI than before: about 114 ms instead of about 190 ms.
- **Limits.**
  - A PowerShell call pays the full hook (about 115 ms).
  - A change by a human editor, or by an agent without Continuity hooks, at the same moment as a command can still
    count for that command. That only triggers the offer; no file provenance is recorded, and the model decides what
    to save.
  - Two sessions whose commands overlap, where the other session's hook has not run yet when this one ends, can
    still both count.
  - Codex shell edits outside `apply_patch` are not detected: Codex offers no report to read.
- **Installation.** Existing installs report `stale` until `integrate claude install` runs again.
