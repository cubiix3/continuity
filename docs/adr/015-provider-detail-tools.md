# 015: Project detail tools installed with the provider integration

Amends [ADR 011](011-agent-auto-bootstrap.md) (issue #25).

## Context

The startup index is bounded: up to eight memories and the latest open handoff. It
ended with "Fetch details with Continuity context/search/handoff tools or the
continuity CLI". `integrate` installed hooks only, so no such tools existed.

Reproduced on post-#30 main (2026-09-26, isolated homes, Claude Code 2.1.283, Codex
0.157.1, prompts without the word Continuity):

| Session | Calls | Outcome |
| --- | --- | --- |
| Claude Code, "What should we continue?", one closed handoff | 9 Bash, 6 of them Continuity CLI (help, then records read through a guessed home) | correct, 47 s |
| Claude Code, question needing a memory not in the index | 2 Bash | missed the project rule |
| Codex, same first question | 6 exec, 4 Continuity CLI | chased "1 older handoff" (it was closed), invented work, 61 s |
| Codex, same memory question | 3 exec and a web search | "this project has no plural convention yet" (wrong) |

Findings, verified with a probe MCP server:
- **Claude Code.** A user-scope stdio server (`.claude.json`, or
  `$CLAUDE_CONFIG_DIR/.claude.json`) starts once per session. Its working directory is
  the project, it receives `CLAUDE_PROJECT_DIR`, and `roots/list` returns the launch
  directory. It needs no approval prompt, and the process ends with the session. Tools
  are deferred behind a tool search unless they carry `_meta["anthropic/alwaysLoad"]`.
- **Codex.** A `[mcp_servers.*]` server in `config.toml` starts once per session in that
  session's working directory, with a minimal environment and no roots. A second session
  in another directory gets its own process, and the daemon ends it one to two minutes
  after the session. `codex mcp list` parses the entry this integration writes.
- **Config ownership.** Claude Code re-reads `.claude.json` before saving its own state,
  so an entry written while a session runs survives. ORCA mirrors `~/.codex/config.toml`
  into its own `CODEX_HOME`, as it does `hooks.json`.
- **No console windows.** A daemon-started server opens no window.

## Decision

- `integrate claude|codex install` also registers one MCP server named `continuity`
  that runs `continuity integrate <provider> mcp`, with absolute paths and no project.
  `--no-mcp` leaves it out. `remove` deletes only this entry.
- That command binds once, at start, through the host resolver:
  - Claude Code: `CLAUDE_PROJECT_DIR`, else the working directory;
  - Codex: the working directory.

  It never registers anything. It serves three tools that write no memories or handoffs:
  `continuity_context`, `continuity_search` and `continuity_handoff_latest`. Context and
  search refresh the source index and record a context audit like any retrieval, so
  only the handoff read carries `readOnlyHint`. For Claude Code they also carry
  `alwaysLoad`. Unbound sessions (unregistered, detached worktree, no state) get a
  server with no tools and no output.
- The startup hook names the tool only when this session really has it: this
  integration's entry is current, not turned off (Codex `enabled = false`, Claude Code
  per-project `disabledMcpServers`), and the server binds this directory. A nested
  unregistered checkout shows its parent's index, but its server binds nothing. With
  the tool, the hook lists up to ten keys of the memories it did not show. Otherwise it
  names no tool and no CLI.
- The Codex editor refuses what it could misread, and then writes nothing:
  multi-line strings, quoted or inline `mcp_servers`, array tables, and unbalanced
  brackets. Table headers count only outside arrays. Only `command` and `args` are the
  integration's own: other keys and sub-tables under `[mcp_servers.continuity]` (a
  timeout, tool approvals) are kept, and a disabled server stays disabled. Comments
  before the next table and a byte order mark are kept.
  Backups of `.claude.json` and `config.toml` roll: one private copy each.
- Closed and finished handoffs no longer count as "more available". The index says
  `No open handoff.` when no handoff is offered for continuation: all are closed, or
  the newest remaining one was created as done, which ends the chain.

## Alternatives

- **Remove the hint only (capability-aware text without tools):** it stops the tool
  hunt, but the memory not in the index is unreachable. Both agents answered the detail
  question wrongly.
- **A precise CLI command in the index:** it needs a shell, quoting and the right home,
  and the CLI's project binding is by `--project`. A structured tool avoids all of that.
- **A global server that takes a project or path argument:** rejected. The model must
  never choose the project, root, workspace or database.
- **The provider CLIs (`claude mcp add-json`, `codex mcp add`):** they would need
  resolving `.cmd` shims and passing JSON through a Windows shell. Direct atomic writes
  follow the same file formats; both CLIs read the result.
- **Write tools in the installed server:** rejected. Autosave through the hooks is the
  one write path.
- **A server that exits outside registered projects:** rejected. Providers report
  failed servers, which is noise in every other project.

## Consequences

- Zero user commands after `install`. The detail case works in both providers: the agent
  called `continuity_context` directly, with no tool search and no CLI. Codex found the
  memory once the index named its key.
- Every provider session starts one more Node process: about 80 MB and 0.2 s, in
  parallel with session start. This includes idle sessions in unregistered directories.
- `status` is `installed` only when hooks and MCP entry are both current.
  `partial` means startup context works but autosave or the detail tools are missing, or
  a foreign `continuity` server exists. `stale` means an entry points to another CLI or
  home, as after moving the package; `install` repairs it.
- Codex hook trust is still not visible to `status`. `/hooks` trust is stored in Codex's
  config under hashed keys, and `status` does not claim it.
- Upgrading Continuity in place keeps the CLI path, and the entries stay current.
  Installs from before this change report `partial` (exit code 1) until `install` runs
  again.
- Known limits:
  - the read-modify-rename has no lock, so a provider write in the same moment can be
    lost; install is rare;
  - Codex `enabled_tools`/`disabled_tools` lists are not read, so the hint may name a
    tool the user hid;
  - a project- or local-scope Claude Code server named `continuity` shadows ours without
    the hook knowing;
  - a session started before the project was registered keeps a server without tools
    until it restarts, even though `/clear` may then show the hint.
