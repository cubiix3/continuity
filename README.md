# Continuity

**Persistent context for interchangeable agents.**

Different agents forget each other's work. Continuity gives projects a local,
provider-neutral context layer: current sources, bounded retrieval, source-backed
memory proposals, and structured handoffs.

Agents are replaceable. Project continuity is not.

## Why

Switching agents should not mean explaining the repository again. Project rules
belong to the project; decisions need evidence; unfinished work needs a usable
handoff. Continuity keeps those connections locally, while Git and project files
remain the source of truth.

Continuity is developer infrastructure, not an agent, orchestrator, or replacement
for `AGENTS.md`. No model account, embedding service, or API key is required.

## A small, real workflow

After building and linking the CLI, run these commands inside a project:

```sh
continuity init
continuity sync
continuity search "reconnect"
continuity context "fix reconnect" --role implementation --budget 6000
continuity handoff create --file handoff.json

# In another agent's session, in the same project:
continuity handoff latest
```

Context includes source paths, SHA-256 versions, capture times, trust labels, and
selection reasons. `continuity explain <context-id>` exposes those reasons.
Budgets are **serialized UTF-8 bytes**, including metadata, not estimated tokens.
See the [runnable example](examples/README.md) for memory and handoff inputs.

## Core concepts

| Concept | Meaning |
| --- | --- |
| Project identity | Local UUID bound to a canonical project directory, independent of its display name. |
| Namespace | A project can read only its own data. Query text never grants access. |
| Source | A bounded text index of current project files, with hashes and provenance. |
| Memory | A proposed, source-backed claim. Conflicts require attention. |
| Handoff | Structured work state that another agent can retrieve. |
| Context bundle | A budgeted selection with an inspectable explanation. |

## Architecture

```text
CLI / generic adapter / MCP / localhost HTTP
                     │
          project-bound Core client
                     │
   identity · namespace guard · retrieval · budget
      memory policy · provenance · handoffs
                     │
               storage ports
               /           \
       SQLite + FTS5    filesystem sources
```

Policy lives in the Core. Adapters receive a scoped capability, never database
access. SQLite is the default storage adapter; FTS5 works entirely offline.
See [architecture](docs/architecture.md) and [decisions](docs/adr/README.md).

## Quickstart

Requirements: **Node.js 24 LTS** (24.13 or newer), **pnpm 10.30.1**, and Git.
Use the latest patched Node 24 release for normal operation.

```sh
git clone https://github.com/cubiix3/continuity.git
cd continuity
pnpm install --frozen-lockfile
pnpm check
pnpm link --global
```

If pnpm's global bin directory is not configured, run `pnpm setup` and open a new
terminal before linking. No global installation is required: from this checkout,
`pnpm continuity --project /path/to/project init` also works. On Windows use a
quoted Windows directory instead of `/path/to/project`.

Then, in your project:

```sh
continuity init
continuity sync
continuity context "understand project rules"
continuity doctor
```

This is a source checkout release; no npm package is published yet. Do not install
an unrelated package named `continuity` from npm.

### Commands

```text
init                         Register the current directory locally
status                       Project identity and last sync
doctor                       SQLite integrity, schema, and FTS5 checks
project status | list        Inspect local registrations
sync                         Refresh source index and invalidate old versions
search <query>               Up to 10 current source excerpts (16 KB total)
context <task>               Build a bounded context bundle
inspect <context-id>         Read a historical bundle
explain <context-id>         Explain its selection
memory list | show <id>      Inspect proposals and durable memories
memory remember <text>       Propose with --key and --source
memory forget <id>           Deactivate a memory; preserve revision history
handoff create --file <path> Save structured JSON (use - for stdin)
handoff latest | show <id>   Retrieve a handoff
mcp                          Serve project-bound tools over stdio
serve                        Start a local authenticated HTTP API
```

Global flags: `--project <directory>`, `--home <directory>`, `--json`.
`CONTINUITY_HOME` overrides the default `~/.continuity` state directory.

## Security and local-first operation

- No network requests in indexing, retrieval, memory, or handoff operations.
- Identity, canonical paths, the database, and context history stay outside Git.
- Retrieval refreshes source hashes before selecting context. Deleted or changed
  sources cannot silently support an old memory.
- Symlinks, hard-linked files, nested registered projects, and nested Git
  repositories are excluded. Secret filenames, generated directories, and
  recognizable credentials are excluded independently of `.gitignore`.
- MCP and HTTP cannot select another project. The host fixes the project at startup.
- HTTP binds to `127.0.0.1`; a local session token and browser-origin rejection
  protect against casual exposure and cross-site requests.

Repository text remains untrusted input for an agent. An `authoritative` label
means authoritative **within the project**, never permission to change Continuity
policy. Secret detection is heuristic; local data is not encrypted. Read the
[security model and limits](docs/security.md) before indexing sensitive projects.

## Integrations

| Integration | Status |
| --- | --- |
| CLI and generic TypeScript adapter | Implemented and integration-tested |
| MCP stdio | Five tools; tested using the official SDK client |
| Local HTTP v1 | Implemented; token, origin, and scope boundaries tested |
| Claude Code, Codex, Command Code, Grok, RIVET | Can be connected through compatible local clients; individual runtime setup is not yet verified |
| Semantic retrieval / OpenViking | Future optional adapters; not required or implemented |

See [adapter contracts and configuration](docs/adapters.md).

## Roadmap

The initial vertical slice is implemented. Next work is intentionally narrow:

- Verify and document Claude Code and Codex integrations with real runtimes.
- Explicit relocation/rebinding of local project identities.
- Better passage selection, source-specific rules, and diagnostic detail.
- An explicit human review workflow for free-form memory candidates.
- Retention, secure deletion guidance, and incremental indexing for larger projects.
- Optional semantic ranking after measuring the lexical baseline.

Cross-project sharing, autonomous agents, a hosted service, and a UI are outside
this release.

## Development

```sh
pnpm build
pnpm typecheck
pnpm test
pnpm lint
# Or all four, in order:
pnpm check
```

Build before running the compiled CLI integration tests. CI runs the same checks
on Linux and Windows. See [contributing](CONTRIBUTING.md), [agent guidance](AGENTS.md),
and the [security reporting policy](SECURITY.md).

Licensed under [Apache-2.0](LICENSE).
