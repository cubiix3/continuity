# Compact host delivery (experimental)

The v1 context budget measures the entire audit bundle. Replaying the frozen
RIVET candidates shows that repeated provenance and selection metadata consume
more than 6 KiB of a 16 KiB bundle. Removing audit data is not acceptable.

Before implementation, three representations were evaluated offline: existing
JSON, compact self-describing objects, and arrays with a field dictionary. All
used identical candidates, flat/control/diversity ordering, and 12/16/20/24/32 KiB
budgets. Objects reduced mean metadata from 6,548 to 1,927 bytes at 16 KiB flat;
content increased from 9,406 to 14,113 bytes. Escaping is measured separately.
File hits increased from 1/22 to 4/22. Arrays saved more bytes but retained only
2/22 at that boundary. No retrieval settings changed.

Policy frozen before holdouts: self-describing JSON objects, flat order. Existing
holdout stayed 2/6; five new frozen holdouts improved from 3/5 to 4/5 at 16 KiB.
These snapshots used lexical retrieval, including requested-hybrid fallbacks.
They do not establish live hybrid quality or readiness for cutover. Diversity
remains an offline experiment in a separate draft PR.

## Contract and compatibility

The opt-in trusted-host `agentContext()` method uses the explicit
`continuity.agent-context/1` delivery schema and `delivery_budget` in UTF-8 bytes.
It returns a `delivery` object and separate accounting. Only compact
`JSON.stringify(result.delivery)` belongs in an agent prompt. Outer host/control
prompts and tasks require their own host budget; they are not secretly included.
Existing `context()`, CLI, HTTP and MCP responses and v1 byte semantics do not
change. No provider-specific rendering or new dependency is required.

Delivery has one project/workspace envelope and items with ref, kind, path,
lines, trust and text. Source text is a JSON string, not a delimiter protocol.
Quotes, fences, fake headers and closing tags cannot create additional fields.
This is structural framing, not a claim to eliminate model prompt injection.
Authorization, freshness and namespace checks still precede delivery.

The existing local context store retains complete selected ContextItems.
The selection audit retains candidate provenance, rank, reasons, ref, byte cost,
and inclusion/drop decisions. `inspect` returns the audit; `explain --verbose`
returns delivery accounting and the selection trace. Audit bundles identify
their representation explicitly and have a separate bounded local size limit.
Short refs are deterministic candidate ordinals within one context, not global
identifiers. They map to real item IDs in the selection audit.

An optional host-only `control.handoff_id` selects a complete structured handoff
from the same project and workspace. It is reserved alongside project rules,
retains agent-observation trust, and cannot widen scope. It is not an MCP input.
No explicit handoff is inferred from a query. Mandatory rules and this handoff
must fit in full or the request fails; text is never summarized or truncated.

Each item is encoded once for exact additive envelope/item/comma accounting.
Final serialization is checked against the hard limit. The full audit is not
charged to the delivery budget and is never sent implicitly.

No production default changes. No cutover, legacy removal or PR #6 merge.
