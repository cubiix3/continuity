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
