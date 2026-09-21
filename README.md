# Continuity

**Persistent continuity for interchangeable agents.**

Continuity is a local continuity layer for projects and AI agents. Keep project
identity, isolated workspaces, reviewed durable memory and structured handoffs
between sessions. Inspect where context came from and whether local state is healthy.

Agents are replaceable. Project continuity is not.

![Continuity Dashboard showing structured handoffs and pending memory review](docs/screenshots/dashboard.png)

*Actual local Dashboard, with an explicitly labeled demo project. No hosted service or model account.*

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
continuity dashboard
```

Open `http://127.0.0.1:4783`. Inspect projects, workspaces, handoffs, pending memory
review, source freshness and historical context selection. The browser does not
open automatically. See [Dashboard operation and security](docs/dashboard.md).

Agents can record structured state and continue it in another session:

```sh
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
| Memory | Source-backed knowledge or an explicitly reviewed free-form claim. Conflicts require attention. |
| Handoff | Structured work state that another agent can retrieve. |
| Context bundle | A budgeted selection with an inspectable explanation. |

## Architecture

```text
CLI / Dashboard / generic adapter / MCP / localhost HTTP
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

## Optional retrieval

Native Read/Grep/Git tools remain the default for coding-agent investigation.
Continuity search is optional and works offline with SQLite FTS5. Optional semantic
adapters help some queries but are not consistently superior. Project isolation and policy enforcement
remain inside Continuity. See [setup and limits](docs/retrieval.md) and the
[measured comparison](docs/retrieval-evaluation.md), including extra false positives.

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
continuity dashboard
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
project rebind <id>           Explicit move with --from and --to
sync                         Refresh source index and invalidate old versions
search <query>               Up to 10 current source excerpts (16 KB total)
context <task>               Build a bounded context bundle
inspect <context-id>         Read a historical bundle
explain <context-id>         Explain its selection
memory list | show <id>      Inspect proposals and durable memories
memory remember <text>       Propose with --key and --source
memory forget <id>           Deactivate a memory; preserve revision history
memory pending               List proposals awaiting human review
memory approve | reject <id>  Local review with --by <reviewer>
retention status             Show retention classes and eligibility
prune --dry-run               Preview only; never deletes data
handoff create --file <path> Save structured JSON (use - for stdin)
handoff latest | show <id>   Retrieve a handoff
mcp                          Serve project-bound tools over stdio
serve                        Start a local authenticated HTTP API
dashboard                    Start the local human Dashboard on 127.0.0.1:4783
```

Global flags: `--project <directory>`, `--home <directory>`, `--json`.
`CONTINUITY_HOME` overrides the default `~/.continuity` state directory.

## Security and local-first operation

- No network requests in the default operation. Explicitly enabled semantic adapters
  contact local services; memory and handoff operations remain local.
- Identity, canonical paths, the database, and context history stay outside Git.
- Retrieval refreshes source hashes before selecting context. Deleted or changed
  sources cannot silently support an old memory.
- Symlinks, hard-linked files, nested registered projects, and nested Git
  repositories are excluded. Secret filenames, generated directories, and
  recognizable credentials are excluded independently of `.gitignore`.
- MCP and HTTP cannot select another project. The host fixes the project at startup.
- `serve` binds to `127.0.0.1`; a bearer token and browser-origin rejection protect
  the agent API. The separate Dashboard uses same-origin assets, an in-memory
  browser capability, explicit protected writes and a restrictive CSP.

Repository text remains untrusted input for an agent. An `authoritative` label
means authoritative **within the project**, never permission to change Continuity
policy. Secret detection is heuristic; local data is not encrypted. Read the
[security model and limits](docs/security.md) before indexing sensitive projects.

## Integrations

| Integration | Status |
| --- | --- |
| CLI and generic TypeScript adapter | Implemented and integration-tested |
| MCP stdio | Six tools; tested using the official SDK client and real agents |
| Local HTTP v1 | Implemented; token, origin, and scope boundaries tested |
| Claude Code | Verified on Windows 2.1.278; [setup](docs/integrations/claude-code.md) |
| Codex | Verified on Windows CLI 0.155.1; [setup and sandbox findings](docs/integrations/codex.md) |
| RIVET | Experimental Draft/Shadow integration; legacy remains authoritative |
| Command Code, Grok | Unverified; Grok structured-result compatibility remains unresolved |
| Ollama / OpenViking | Optional local retrieval; [tested versions and limits](docs/retrieval.md) |

See [adapter contracts and configuration](docs/adapters.md).
The [real cross-agent fixture](docs/integrations/cross-agent.md) passes structured
work between fresh Claude and Codex sessions, without sharing chat transcripts.
The [lexical baseline](docs/retrieval-baseline.md) documents successful retrieval
and failures before any semantic retrieval dependency is introduced.

## Roadmap

The [v0.1 product scope](docs/product-scope.md) centers on local continuity and
inspection. The [RIVET dogfood conclusion](docs/research/rivet-dogfood.md) records
what was and was not proven. Further retrieval research is paused.

Agent orchestration, cloud accounts, team sync, automatic repair, source editing
and a RIVET cutover are outside this release. Release publication still requires review.

## Development

```sh
pnpm build
pnpm typecheck
pnpm test
pnpm lint
# Or all four, in order:
pnpm check
pnpm exec playwright install chromium
pnpm test:ui
```

Build before running the compiled CLI integration tests. CI runs the same checks
on Linux and Windows. See [contributing](CONTRIBUTING.md), [agent guidance](AGENTS.md),
and the [security reporting policy](SECURITY.md).
`pnpm test:pack` builds a whitelisted tarball, installs it into a fresh temporary
project and exercises its real bin and packaged Dashboard without a semantic backend.
`pnpm baseline` reruns the eight lexical cases.
See [local operations](docs/operations.md) for rebind, review and retention previews.

Licensed under [Apache-2.0](LICENSE).
