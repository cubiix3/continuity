# Claude Code

Verified on Windows with Claude Code 2.1.278: project-bound context, search,
memory proposals, structured handoff creation/retrieval, and observation submission.
The real fixture starts fresh sessions without session persistence. No transcript
is supplied to the next runtime.

## Reproduce the fixture

Authenticate the installed Claude Code CLI normally. From the Continuity checkout:

```sh
pnpm build
pnpm test:agents setup
pnpm test:agents claude-start
pnpm test:agents codex
pnpm test:agents claude-return
pnpm test:agents verify
```

This is an opt-in live test using your existing model account. It is not part of
CI. The runner creates sibling synthetic projects A and B and a separate state
directory under the OS temporary directory. Local run coordinates are written to
ignored `.continuity/real-run.json`. Logs remain outside both projects and are
never passed to either agent. Remove the temporary fixture manually when finished.

The runner uses the installed Windows npm launcher target. `CLAUDE_BIN` can select
another Claude executable. Non-Windows live-agent operation has not been verified.

## The actual MCP launch

`scripts/real-agents.mjs` writes the following JSON with resolved local paths:

```json
{
  "mcpServers": {
    "continuity": {
      "command": "node",
      "args": ["<built-cli>", "--home", "<private-state>", "--project", "<project-a>", "mcp"]
    }
  }
}
```

Claude is launched in project A with `-p --no-session-persistence
--strict-mcp-config --mcp-config <file> --setting-sources project
--permission-mode acceptEdits --allowedTools
"Read,Edit,Write,Bash(node *),mcp__continuity__*"
--output-format stream-json --verbose`. The prompt is supplied on stdin.

The `--project` value is host configuration, not model input. The adapter exposes
no namespace selector or review/approval tool. Keep real host configuration outside
shared repository content. See [official Claude MCP documentation](https://code.claude.com/docs/en/mcp).

## Evidence

Claude implemented the retry limit in the existing manager and recorded a decision
and handoff. The return session independently inspected Codex's handoff and code.
See [the cross-agent report](cross-agent.md) for successful checks and the initial
blocked Codex run; exit code zero alone is not treated as integration success.

## Automatic startup context

`continuity integrate claude install` adds one `SessionStart` hook to the user
settings (exec form: absolute Node executable and CLI path, no shell). Fresh
sessions in registered projects receive the [bootstrap index](../agent-bootstrap.md);
other directories stay silent. Verified with Claude Code 2.1.280 on Windows: fresh
`-p` sessions with all tools disabled described the project's in-progress handoff
and memories with their trust labels, and did not mention the other fixture project.

## Project detail tools

The same install adds a user-scope MCP server `continuity` to `.claude.json` (or
`$CLAUDE_CONFIG_DIR/.claude.json`). Claude Code starts it for each session in the
project, and it serves `continuity_context`, `continuity_search` and
`continuity_handoff_latest`, bound to that project. The tools are marked `alwaysLoad`,
so Claude Code calls them without a tool search. The startup index then lists the keys of
memories it did not show.

Verified with Claude Code 2.1.283 on Windows, in an isolated config, with prompts that
did not mention Continuity:
- "What should we continue?" with only a closed handoff: one `continuity_context` call
  and two Git reads, no tool search, no CLI, 15 s. Before: 9 calls, 6 of them Continuity
  CLI, 47 s.
- A question needing a memory the index did not show: `continuity_context` found it
  directly.

See [ADR 015](../adr/015-provider-detail-tools.md).
