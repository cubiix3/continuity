# 007 — Separate host delivery from the local audit

Status: experimental; no default or migration.

Offline replay demonstrates substantial repeated metadata cost in audited v1
context. Use an additive, host-only `agentContext()` contract with the explicit
`continuity.agent-context/1` JSON representation. Its byte limit covers exactly
the serialized delivery object. Keep v1 `context()` behavior and limits intact.

Reuse candidate generation, identity, workspace checks, freshness, policy and
the existing context/selection store. No second retrieval engine or context DB.
Preserve full provenance and reasons in bounded local audit records. Resolve
per-context short references through those records. Required source rules and
explicit same-workspace lifecycle handoffs must fit without truncation.

Self-describing JSON strings provide unambiguous structural framing. They do not
grant policy authority to repository content or prevent all model prompt
injection. Backends, adapters and prompts cannot change authorization.

The choice is based on representation savings, not a cutover claim. Flat order
remains unchanged; diversity and retrieval tuning are outside this decision.
See [evaluation and compatibility](../compact-agent-context.md).
