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
