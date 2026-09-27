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

`bashEditDiff` and the top-level `duration_ms` are verified with Claude Code 2.1.283 but not documented by Anthropic.

## Decision

- **Matcher.** Claude Code's `PostToolUse` matcher also covers `Bash|PowerShell`.
- **Provider signal first.**
  - Bash in a Git tree: the report's `changedFiles` decide.
  - No report means nothing changed, and the CLI entry answers that case before the CLI loads.
  - Continuity reads only the changed paths and `duration_ms`, never the command, its output or file contents.
  - Hook input up to 16 MiB is read (the report carries every hunk). Larger input is read to the end and ignored.
- **Bounded fallback** where the provider reports nothing (PowerShell, or Bash outside Git). The source adapter
  checks the indexed files and their folders; a full-tree walk and Git processes are not used.
  - An indexed file counts when it was modified during the command.
  - A new file beside indexed ones counts when the scanner would index it. The scanner's own rules decide: excluded
    names, `.gitignore`, the source scope and extensions. Tool output such as caches, build info, source maps and
    swap files does not count.
  - Every folder passes the scanner's checks from the root, one component at a time: no links, junctions, nested
    checkouts or registered child projects. Nothing is listed or examined through a link.
  - Files this session's own earlier edits changed are not counted again.
  - Names and one `lstat` come first; only files that changed meet the ignore and selection rules. On the largest
    registered projects here (379 and 631 indexed files in 45 and 40 folders) the check takes 18–20 ms, plus 21–26 ms
    to read the index. Files outside the index's folders and deletions are not seen.
- **What counts.**
  - Each path binds by its real folder, like a session directory. A deleted path binds through its nearest existing
    ancestor, at most 32 levels up. One report binds at most 50 paths.
  - Paths outside every registered project, in a nested checkout, or with a denied component of their real path do
    not count. The denied components are the source scanner's rule, now shared from Core: dependencies, build output,
    VCS and Continuity state, and secret-looking names.
  - The local source scope is not a filter for reported paths: an edit outside it is still project work.
  - A command that changed another project or workspace than the session's own makes the turn `mixed`, so nothing is
    offered. A save could never be applied there: `Stop` binds to the session's own directory.
- **Attribution.**
  - Every attributed edit (edit tools, `apply_patch` and shell edits) records a timestamp per scope and session. A
    shell edit records every scope it touched, including in a `mixed` turn.
  - A scope in a shell report is ambiguous, and counts for nothing, when another session recorded an edit of it
    after the command started or up to 1.5 s before (the command's duration plus a margin for the hook's own delay).
    Without a valid duration the window is 60 s.
  - Entries expire after an hour, and entries dated in the future (the clock was set back) are ignored.
- **Same state machine.** The resulting scope goes through the existing offer state machine: turns, interruption,
  sub-agents, `mixed`, and one offer per turn.

## Alternatives

- **Git status as the sensor:** rejected. It is slow on large trees and fails outside Git, and it is exactly what the
  provider report already does.
- **Parsing command strings** (`sed`, `>`, `python`): rejected. It is unreliable and reads the command.
- **Every Bash call counts as an edit:** rejected. `ls`, `git status` and test runs would draw an offer every turn.
- **A full-tree scan before and after every command:** rejected. It is O(repository) per shell call, and even the
  scanner's own traversal takes 14 ms on this repository and exceeds its 20,000-entry limit on a large project without
  a source scope.
- **The background runtime's watchers:** not used. Autosave must work with the runtime stopped.
- **A `PreToolUse` marker per command**, so an overlapping session could see a command in flight: rejected for now.
  It doubles the hook cost of every shell call, and without knowing who wrote a file it can only turn both
  overlapping sessions ambiguous.

## Consequences

- **Auto-mode shell edits** now draw the same quiet offer as edit tools.
- **Cost per call.**
  - A read-only Bash call in a Git tree costs about 43 ms; bare Node is 24 ms (Windows, medians of 9).
  - Other hook calls load less of the CLI than before: about 124 ms instead of about 190 ms.
- **Limits.**
  - A PowerShell call pays the full hook (about 124 ms on a small project; the bounded check and index read add up to
    about 45 ms on the largest registered projects here).
  - **Concurrent writers.** A change made at the same moment by a human editor, by an agent without Continuity's
    hooks, or by a Codex shell command outside `apply_patch` can still count for the command. No file provenance is
    recorded. In the session's own workspace the change can only trigger the offer, and the model decides what to
    save. In another registered scope of the same Git tree (a nested project, for example), it makes the turn
    `mixed`: that fails closed, even when the turn's offer is already pending, so the save is skipped. The session
    that sees it also journals that scope, so another session's real edit there during the command is ambiguous.
  - **Parallel sub-agents.** The bounded check starts after the session's last journaled edit, and sub-agents share
    the session. A sub-agent's edit that lands while a PowerShell command runs hides that command's earlier writes;
    the session stays dirty, so `Stop` asks through the visible fallback instead.
  - **Case-only renames.** A folder renamed only by case (`src` to `Src`) fails the scanner's real-path check, so
    the bounded check misses edits in it until the next sync. This fails closed.
  - **Overlapping commands: the first hook wins.** Session B's read-only command overlaps session A's edit, and B's
    hook runs first. B's report lists A's file, so B is offered, and A's report is ambiguous. The model in B usually
    saves nothing, as in any turn without a lesson, and A's lesson for that command is lost.
  - **The margin.** Another session's edit less than 1.5 s before a command started also makes that command's report
    ambiguous. Measured with Claude Code 2.1.283 in a 10,000-file Git tree, the hook arrived 224–241 ms after a
    command that changed a file ended (82–88 ms without changes). `duration_ms` covers Claude Code's own work around
    the command, so the hook time minus `duration_ms` fell 0.1–0.7 s *before* the command's own start in all six
    runs. The margin is slack on top of that, not the only cover.
  - **Edit tools** journal the session's own workspace, not the edited file's: a cross-project `Write` is on record
    for the wrong workspace.
  - **Timestamps.** Where a file system reports no creation time (Linux without `statx` may report the change time
    instead), a `chmod` or rename of a new file beside indexed ones can count. File systems with 2 s timestamps (FAT)
    can place a change before the window.
  - **Codex** shell edits outside `apply_patch` are not detected: Codex offers no report to read.
  - **Undocumented fields.** If Claude Code changes `bashEditDiff` or `duration_ms`, Bash edits in Git look read-only
    again (no offer), and durations fall back to the 60 s window.
  - A journal that cannot be written (for example, one replaced by a link) disables offers for edit tools too: this
    fails closed.
- **Installation.** Existing installs report `stale` until `integrate claude install` runs again.
