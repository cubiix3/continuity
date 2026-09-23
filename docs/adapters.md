# Adapters and local API

The trusted host calls `openContinuity().project(directory)` and gives the adapter
a project-bound client. An adapter never receives a database handle. Tool payloads
cannot select a project, namespace, trust level, or active memory overwrite.

The generic contract supports `context`, `search`, `propose`, `createHandoff`, and
`latestHandoff`, and `observe`. Providers normalize their input into these contracts. They do not
implement policy, retrieval, or synchronization independently.

`context`, `search`, and host `sync` are asynchronous in the hybrid retrieval
slice. Await their promises in SDK integrations. Optional `mode` selects lexical,
semantic, or hybrid candidates; it never selects a project or namespace.
Search retains resource `id`, `project_id`, `hash`, `state` and `path`; added
`passage_id`, line ranges and ranking reasons identify the selected excerpt.

## MCP stdio

After `continuity init`, configure a compatible host to launch:

```json
{
  "mcpServers": {
    "continuity": {
      "command": "node",
      "args": [
        "/path/to/continuity/dist/packages/cli/src/index.js",
        "--project", "/path/to/your/project",
        "mcp"
      ]
    }
  }
}
```

Replace the paths locally; never commit a machine-specific configuration. The
outer configuration key is host-specific; this is the common `mcpServers` shape,
not a claim that every runtime accepts it. Project selection belongs in host
configuration and must not be synthesized from tool arguments.

Seven tools are available:

| Tool | Input |
| --- | --- |
| `continuity_context` | `task`, optional `role`, `mode`, `budget` in bytes |
| `continuity_search` | `query`, optional `mode` |
| `continuity_memory_propose` | `key`, `text`, `kind`, optional `source_path`; `from.agent` and `from.session` for automatic agent-learned memory |
| `continuity_handoff_create` | [handoff fields](handoffs.md) |
| `continuity_bootstrap` | Empty object; read-only startup index ([agent bootstrap](agent-bootstrap.md)) |
| `continuity_handoff_latest` | Empty object |
| `continuity_observe` | `text`, `agent`, `session`; never auto-promoted to memory |

Results contain JSON text and structured data under `result`. MCP framing is
outside the Core bundle budget. stdout is reserved for protocol traffic; diagnostics
use stderr. The adapter uses the official [MCP TypeScript SDK v1](https://ts.sdk.modelcontextprotocol.io/server).

## HTTP v1

```sh
continuity --project /path/to/project serve --port 4783
```

Bind address is always `127.0.0.1`. Supply `CONTINUITY_API_TOKEN` (at least 32
characters) or use the randomly generated session token printed to stderr.
Send `Authorization: Bearer <token>` on every request and `Content-Type:
application/json` on POST. Browser origins are rejected.

| Method | Endpoint | Body / result |
| --- | --- | --- |
| POST | `/v1/context` | `{ "task": "fix reconnect", "role": "implementation", "budget": 6000 }` |
| POST | `/v1/memory/propose` | Memory candidate; returns policy result |
| GET | `/v1/memory/:id` | Project-owned memory or 404 |
| POST | `/v1/handoffs` | Handoff input; returns 201 |
| GET | `/v1/handoffs/latest` | Handoff or null |
| POST | `/v1/sync` | Empty object |
| GET | `/v1/projects` | Only the server's bound project, without its local path |
| GET | `/v1/health` | API schema version and liveness |
| GET | `/v1/diagnostics` | SQLite integrity, migration, and FTS5 status |

Roles: `implementation`, `reviewer`, `planning`. Budget: integer 512–32,000,
default 6,000. Request bodies: maximum 64 KiB. Unknown schema fields and query
parameters are rejected. Failures use an `error` field; 400 indicates invalid
input, 401 missing/invalid token, 403 forbidden origin/host, 404 unknown resource,
413 oversized body, 415 wrong content type, and 500 a local operation failure.

Runtime schemas live in `packages/core/src/contracts.ts`. Context and handoff
objects carry `schema_version: 1`; HTTP contracts are versioned by URL. There is
no remote transport support or provider-specific data model.
