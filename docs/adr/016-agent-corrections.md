# 016: Explicit agent corrections of agent observations

Amends [ADR 009](009-automatic-memory.md) (issue #26).

## Context

Agent observations have no source freshness check, so they go stale as code
changes. When an agent noticed a stale lesson, the only zero-command path was a new
save with the same key. The policy has no latest-wins, so that path quarantined both
claims. Reproduced on post-#25 main (2ca899f):

1. `service.token-location` was active as an agent observation.
2. A correction with the same key made both claims `needs_attention`. The startup
   index said `2 unresolved memory conflicts (service.token-location); no side is
   current truth.`, counting two records for one key.
3. After the stale claim was forgotten, the correction stayed `needs_attention`. Every
   start still said `1 unresolved memory conflict …; no side is current truth.`
4. Only `continuity memory approve|reject` cleared it, and an agent must not sign as
   a human reviewer.

## Decision

- **Explicit correction, host-validated.** A save may mark a memory
  `"corrects":true`. The flag is the model's intent only. The hook passes Core a
  `Correction` holding the memory ids that its `SessionStart` showed this session:
  the listed memories, plus the memories behind the listed keys when the detail tool
  is installed. They are stored as ids only, beside the session flags.
- **What Core replaces.** Core replaces the claim only if all of these hold:
  - the key has exactly one claim;
  - that claim is `persist`, `agent_observation`, has no source path and is not
    human-reviewed;
  - it is in the proposer's workspace;
  - it is among the shown ids.

  The new claim must be attributed, free-form and not routine. The old claim becomes
  `superseded`, with `superseded_by`, `superseded_at` and the correcting agent and
  session in its reason; both versions stay in revision history. The new claim is
  active with `agent_observation` trust.
- **Limits.** One proposal call applies at most three corrections. Anything else
  follows the unchanged conflict rules: quarantine, a human-reviewed or source-backed
  memory stands, and a current source excerpt supersedes. Source-backed corrections
  still resolve only through source evidence.
- **Not agent-facing.** `Correction` is not part of the candidate schema. MCP, HTTP
  and CLI `remember` reject a `corrects` field, and the model never supplies an id.
- **Forget re-evaluates.** Forgetting an agent observation re-evaluates its key. A
  single remaining quarantined agent observation, with no active claim, becomes
  active. Forgetting a human-reviewed or source-backed claim, including an accepted
  agent observation, releases nothing.
- **Conflicts follow the active topology.** A conflict is a key with two or more
  different quarantined claims and no active claim, and it is counted per key. Other
  quarantined claims are `attention.held`: beside an active memory (that memory
  stands) or alone. They are not rendered for agents. `no side is current truth` is
  said only when it is true.

## Alternatives

- **Latest agent claim wins:** rejected. Two sessions that learned different things
  would silently overwrite each other; the conflict is the signal.
- **The model names the id to replace:** rejected. Ids are not in the startup text,
  and a model-chosen id could target any record. The host resolves the key and checks
  that the session saw the claim.
- **Also correct quarantined claims shown only as a conflict key:** rejected. The
  session never saw their text, so it cannot knowingly correct them. Human review
  or forgetting one side resolves those.
- **Also correct memories found through `continuity_context` during the session:**
  not possible yet. The MCP server is not bound to the provider session, so the host
  cannot know what it showed. Such corrections are quarantined as before.

## Consequences

- A stale lesson that a session was shown is corrected in that session's save, with
  no command and no reviewer.
- A same-key save without the flag, or from a session that never saw the claim, is
  quarantined as before. Forgetting the stale side now resolves that conflict too.
- A manipulated model can replace an agent observation it was shown with another
  agent observation, never anything stronger, and the old version stays in history.
- The save contract grew by one sentence (the offer is 1,098 bytes). The fallback
  request is unchanged, since the model saw the rule in the offer.
- `BootstrapBundle.attention.conflicts` now counts keys, and `attention.held` is new.
