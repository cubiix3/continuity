# 009 — Automatic activation with explicit agent-observation trust

## Decision

Automatically activate bounded durable agent candidates that have agent/session
attribution and pass deterministic checks. Reuse `persist` and `agent_observation`;
do not invent source or human review provenance. Exact current source excerpts
remain `persist`/`derived`. New response outcomes explain duplicates, rejection,
quarantine and replacement without changing the stored v0.1 status vocabulary.

Core owns the transition inside the existing atomic storage operation. Different
agent claims under one key quarantine each other. An exact current source excerpt
can supersede agent claims and stale source claims with preserved revisions.
Unresolved current-source disagreements and human-reviewed conflicts do not use
latest-wins. A lower-trust observation cannot deactivate a stronger active claim.

Context keeps current source ranking intact, then orders relevant human-reviewed,
source-backed and agent-learned memories. Agent lessons require meaningful token
overlap; they are explicitly observations, including when their kind is `rule`.
All source-backed memories retain source-hash freshness checks.

Admission to the byte budget follows the same order. There is one bounded exception:
after current rules, a memory that covers at least half of the meaningful task terms
may be admitted before lower-ranked source passages, within 25% of the budget. Without
this, a crowded source context dropped every memory, however relevant. Presentation
order is unchanged, and without such a memory the bundle is identical.

## Compatibility and trust

No migration, new tables, bulk activation, provider hook or LLM summary. Existing
pending records remain inactive. Missing agent/session attribution uses the same
inactive compatibility path. Review/forget remain trusted local human operations;
the Dashboard adds protected POST forget through the existing Core method.
No agent tool accepts project, trust, status, revision or review overrides.

Attribution is self-reported, not attestation. Deterministic phrase filters cannot
prove arbitrary prose or detect all semantic contradictions. The stable key is
the conflict boundary. Downstream agents must treat learned observations as lower
trust, verify important claims against current sources, and avoid storing secrets.

## Alternatives

Mandatory approval remains safe but creates a routine inbox for normal solo work.
Latest-wins removes the inbox but invents a truth rule. Automatic lower-trust
activation with quarantine preserves useful continuity without either requirement.
