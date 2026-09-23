# Automatic project memory (unreleased)

Agents submit candidates; Core determines activation and trust. Normal durable
lessons do not need approval. Handoffs remain temporary structured work state;
observations never become durable memories automatically.

## Candidate contract

```json
{
  "key": "provider.reconnect-budget",
  "kind": "experience",
  "text": "Reconnect cancellation releases the registry lease before provider replacement.",
  "from": { "agent": "generic", "session": "session-123" }
}
```

Kinds are `rule`, `decision`, `memory`, `experience`. Text is 10–2,000 characters;
keys are bounded to 120 and agent/session labels to 100. An optional `source_path`
requests source-backed validation. Unknown fields, including project IDs, trust,
review metadata and overwrite targets, are rejected. The host chooses the project.
Agent/session labels record attribution, not an authenticated human identity.

| Candidate | Stored state / trust | Normal action |
| --- | --- | --- |
| Exact excerpt from current authorized source | `persist` / `derived` | Automatically active, source path and hash retained |
| Durable free-form claim with agent/session | `persist` / `agent_observation` | Automatically active, lower priority |
| Routine execution, temporary state or explicit speculation | `reject` | Not used in context |
| Unproven claimed source | `needs_attention` / `untrusted` | Quarantined; no downgrade into an active agent claim |
| Missing free-form attribution | `proposed` / `untrusted` | Inactive compatibility path; supply attribution or optionally review |

The deterministic filter rejects recognizable test/build reports, modification
reports, temporary debug state, TODOs, explicit guesses and common generic advice.
It does **not** prove that arbitrary prose is true or universally detect generic
knowledge. Agents should submit stable repository decisions, constraints, non-obvious
behavior, fix rationales, recurring pitfalls and relevant tool quirks. Never submit
secrets. There is no LLM classifier or generated summary in Core.

## Conflicts and replacement

The stable key defines a claim. Different texts under the same key conflict:

- Two agent-learned claims quarantine both. Repeating either claim does not make it
  active; another newer agent opinion cannot resolve the conflict.
- A weaker agent observation cannot displace an active source-backed or explicitly
  accepted human-reviewed memory. Only the observation is quarantined.
- An exact current source excerpt replaces same-key agent claims (including
  quarantined claims) and stale/unproven source claims. Old rows become `superseded`
  with `superseded_by`; the new/current source-backed row becomes active.
- Two contradictory excerpts that both remain in current sources are quarantined,
  not resolved by timestamp. A human-reviewed conflicting claim is never silently
  replaced. Correct the sources or use the optional trusted override workflow.
- One workspace cannot declare another workspace's source stale. Its conflicting
  candidate is quarantined without replacing or deactivating the other source claim.

All changes and their revisions occur in one existing storage transaction. Duplicate
active/agent-quarantined facts return the existing ID without another revision.
Re-proving an active source claim can resolve weaker conflicting observations.

Tool responses preserve the memory object and add `outcome`: `persisted`, `duplicate`,
`rejected`, `quarantined`, or `superseded` (the returned claim is active; replaced IDs
are listed). `pending` is reserved for missing attribution. No normal complete
agent candidate waits for a human approval inbox.

## Context and trust

Current rules and source passages retain their existing order. Relevant memory
follows: human-reviewed, fresh source-backed, then agent-learned. Agent lessons
require meaningful task-token overlap and are explicitly described as observations,
not source truth or project policy. Memory records categorized as `rule` are delivered
as memories; only actual source rules occupy the project-rule context kind. The stored
category remains intact. No source retrieval/ranking policy is changed.

Only `persist` and `accepted` are eligible. Quarantined, rejected, forgotten and
superseded rows are excluded. A source-bound memory must still match the current
source path/hash even after human approval. An active **stored status** is not a
freshness guarantee; Dashboard counts describe policy state, while context rechecks
actual current source evidence.

## Compatibility and optional human control

No database migration or bulk activation. Existing `accepted`/`persist` rows stay
eligible under the existing freshness checks. Historical `proposed`, `rejected`
and `needs_attention` rows retain their state and history. New complete candidates
use the automatic policy. The existing schema stores optional attribution and
supersession fields in record JSON.

The Dashboard shows Active, Source-backed, Agent-learned, Conflicts/unresolved,
Superseded, Forgotten, legacy/incomplete and Rejected records. Detail exposes trust,
attribution, evidence and history. Forget is an explicit protected write with
confirmation; manual review remains an optional detail/CLI action.

## Provider-neutral session contract

At session start: read the latest handoff and request task context. During or at
the end of work: propose **zero or more** durable lessons with agent/session
attribution; create a structured handoff if another session needs work state.
Inspect proposal outcomes; use current source evidence to resolve conflicts when
available. Do not keep rewording a claim to bypass quarantine. Do not turn every
handoff, observation, test result or chat message into memory.

There are no Claude/Codex/ORCA hooks in Core and no automatic transcript extraction. Provider
[autosave](agent-lifecycle.md) asks the model itself for this decision at the end of an
editing turn and submits its answer through the same policy.
