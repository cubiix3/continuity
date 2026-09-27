# Changelog

## Unreleased (main)

- Automatic-first durable memory: source-backed facts and attributed agent lessons activate automatically with provenance and trust; conflicts are quarantined; human review is optional.
- Local per-project source scope (`continuity sources`) to narrow the source index of large projects without changing project identity.
- Refreshed Dashboard: visual system and information hierarchy, then a denser desktop shell, project-first Overview, automatic-memory filters, handoff-first detail views and a read-only source view.
- New Continuity mark, favicon and brand assets.
- Optional background runtime: Windows current-user sign-in startup, loopback Dashboard and bounded automatic sync that follows the local source scope.
- Agent auto-bootstrap: read-only startup index (`continuity bootstrap`, `continuity_bootstrap` MCP tool) and explicit Claude Code and Codex `SessionStart` hook integrations.
- Provider-aware session autosave: after a turn that edited files, a gated `Stop` hook asks the same model once for 0–3 durable lessons and an optional unfinished-work handoff, applied through the existing memory policy. No transcripts are read. On by default only in interactive sessions (attended Claude Code, and daemon-hosted Codex since #24); `CONTINUITY_AUTOSAVE=1|0` overrides it, and `--no-autosave` keeps startup context only.
- Handoff closure: `continuity handoff close` and autosave record that a handoff's work is finished without rewriting it; session start shows the latest open handoff.
- Dashboard Overview no longer runs the full doctor (#16): it uses a cheap project health check that reads Git link files instead of running Git. The full doctor runs Git asynchronously, four workspaces at a time, so the Dashboard stays responsive during Diagnostics. `continuity doctor` output is unchanged. `host.health(projectId)` is new and display-only.
- Host API v2: `host.doctor()` is asynchronous and must be awaited. Doctor findings and output semantics are unchanged. v0.1.0 remains Host API 1.
- Codex 0.157 autosave (#24): interactive `codex` sessions, which Codex 0.157 hosts in its shared app-server daemon, now save by default with no setting. Launch-time `CONTINUITY_AUTOSAVE` cannot reach those hooks, so the previous opt-in never took effect there. `codex exec` (from a terminal, a script, or run by an agent as a command) and `codex --no-daemon` stay off, and their answers are unchanged. A `codex exec` started by your own Codex hook or `notify` program inherits the daemon environment and should set `CONTINUITY_AUTOSAVE=0`. Code-mode and sub-agent edits are detected as `apply_patch`. Remove any `CONTINUITY_AUTOSAVE=1` set up for Codex before this change: a daemon that captures it forces autosave for execs run by agents too. See ADR 013.
- Quiet autosave (#27): the save no longer takes an extra visible turn. After the first file edit of a turn, the `PostToolUse` hook gives the model the save contract as hidden context. The model ends its final answer with one `[continuity-save]: <…>` line (a Markdown link reference definition), which Codex does not display and Claude Code shows as one raw line. `Stop` applies it silently. Only if the line is missing does `Stop` ask once (a short, self-contained request, at most every 15 minutes, never on a continuation); an interrupted turn's offer expires instead of prompting a later turn. Rejected, quarantined, skipped or malformed items are no longer reported; only failures produce one short line such as `Continuity: save skipped — database busy.` Headless runs are unchanged. See ADR 014.
- Project detail tools with the provider integration (#25). `continuity integrate claude|codex install` now also registers a user-level MCP server, `continuity`. The provider starts it once per session, and it binds to that session's project through the same host resolver as the startup context: no project, root or workspace argument, and no tools outside registered projects. It serves `continuity_context`, `continuity_search` and `continuity_handoff_latest`, which write no memories or handoffs; autosave stays with the hooks. The startup context no longer ends with a hint about tools or the CLI that might not exist. It names `continuity_context`, with the keys of memories it did not list, only when the entry is installed. Closed and finished handoffs no longer count as "more available" (`older_handoffs` counts open work only, new `available.open_handoff` and `available.more_keys`), and the text says `No open handoff.` when none is open. `--no-mcp` keeps hooks only. The Codex editor reads `config.toml` as TOML does (strings, multi-line strings, comments, quoted keys), refuses forms it could still misread with the reason and a `--no-mcp` hint, and keeps Codex's own keys under the entry. Under the entry only an allowlist of user settings (enabled, timeouts, tool lists, approvals) is kept; a working directory, environment or any other key makes it stale, and `install` drops it. Existing installs report `partial` until `install` runs again. Each provider session runs one more Node process (about 80 MB). See ADR 015.
- Agent corrections without a command (#26):
  - **Explicit correction.** An autosave memory marked `"corrects":true` replaces the key's only claim, if it is an active agent observation of the same workspace that the session's startup listed in full. The old claim becomes `superseded`, with `superseded_at` and the correcting agent and session in its revision history.
  - **Never stronger claims.** Human-reviewed and source-backed memories, other workspaces and claims the session never saw are never replaced this way.
  - **Limits.** One call applies at most three corrections; only applied ones count. A key repeated within one autosave answer is skipped. MCP, HTTP and CLI `remember` reject the field.
  - **Forget.** Forgetting a live side of an agent-only conflict re-activates the lone remaining agent claim, unless the key carries a human decision or source evidence.
  - **Conflicts.** The startup index counts conflicts per key, and only when no claim is active. It says "no side is current truth" only then. Other quarantined claims are counted as `attention.held` and are not rendered.
  - **Contract.** `BootstrapBundle.attention.conflicts` changes meaning from records to keys. A stale, withheld source claim no longer hides a conflict.
  - **Dashboard.** Quarantined records and their filter are labelled "Needs review" instead of "Conflict(s)", and the time a record was superseded is shown. See ADR 016.
  - **Existing databases.** A correction already stuck next to a forgotten old claim stays quarantined. The startup index now counts it as held rather than as a conflict, so only the Dashboard ("Needs review") shows it: approve it or forget it there.
- Bracketless autosave replies (#35): `Stop` also accepts the save line without its angle brackets, `[continuity-save]: {…}`, which Claude Code sometimes writes. Such saves were silently dropped and prompted the fallback. The rule is:
  - the last line outside fenced code that starts with the label decides;
  - a malformed last line means no save, and an earlier line never stands in;
  - a later turn's answer no longer revives an interrupted turn's offer.

  The contract still asks for the bracketed form, and the fallback stays for answers without a save line.
- Shell-made edits start autosave (#34): Claude Code in auto mode often edits through its Bash tool, which never started a save.
  - **What counts.** A shell call now counts when Claude Code's own edit report lists a changed file in the session's registered project. Where there is no report (PowerShell, or no Git), the source scanner's own rules check the indexed files and new files beside them, never through a link. Dependencies, build output, VCS and Continuity state do not count, and an edit of another project makes the turn `mixed`. Another session's edit of the same workspace during the command makes the report ambiguous.
  - **Privacy.** Only the changed paths and the duration are read, never the command or its output.
  - **Speed.** A read-only Bash call is answered in about 43 ms before the CLI loads, and other hook calls load less of it (about 124 ms instead of 190 ms).
  - **Upgrade.** Existing installs report `stale` until `integrate claude install` runs again. See ADR 017.
- Hidden workspace Git checks on Windows (#31): the Git processes Continuity starts to verify a worktree now start with `windowsHide`. From a process without a console (the background runtime, or a detail server a daemon starts), each check used to open a visible console or Windows Terminal window, one per Git call; they open none now. Executable, arguments, `shell: false`, timeout, output limit, exit handling and results are unchanged. Windows that Codex's daemon opens for its own commands and hooks are Codex behaviour and remain.
- Context no longer starves strongly relevant memories: after current rules, a memory whose text covers at least half of the meaningful task terms may use up to 25% of the byte budget ahead of lower-ranked source passages. Trust order holds inside that share (a related higher-trust memory is always offered it first). Presentation order is unchanged, and contexts without such a memory are identical.

## 0.1.0 — 2026-09-22

- Local project identity and isolated Git workspaces.
- Structured agent handoffs, durable memory proposals, explicit human review and conflict handling.
- Source provenance, freshness checks and historical context audit.
- Local Dashboard for projects, workspaces, handoffs, memory review, sources and diagnostics.
- CLI, trusted host API, project-bound MCP and non-browser HTTP interfaces.
- Offline SQLite FTS retrieval; optional local semantic backends.
- Claude Code and Codex structured cross-agent flows verified in the documented Windows environments. RIVET remains experimental Draft/Shadow; Grok structured results remain unverified.

No cloud dependency, agent orchestration, telemetry, automatic model download or RIVET cutover. Publication requires a separate release review.
