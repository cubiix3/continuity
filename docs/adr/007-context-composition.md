# Opt-in source diversity for context composition

Status: experimental; flat composition remains the default.

Phase 4B found 20/22 lexical and 21/22 hybrid labelled files before packing,
but only 1/22 and 4/22 afterward. Retrieval and freshness are unchanged.

On fixed Phase 4C lexical candidate snapshots, a first passage per source followed
by additional passages improves file-level recall from 1 to 4 of 22 at 16 KiB,
3 to 9 at 24 KiB, and 5 to 13 at 32 KiB. All supplied rule text remains present.
The 32-KiB measurement is offline: the current request limit is 32,000 bytes.
These are file hits, not proof of complete task information. Ollama was unavailable
during this experiment; hybrid requests degraded to lexical and are not hybrid
quality evidence. Existing holdouts were not consulted during policy selection.

The trusted SDK host may select `composition: 'source-diversity'` when opening
Continuity. This is not a context request field or MCP argument. Composition keeps
all rules first, followed by explicit path matches, the highest-ranked passage per
remaining source, then additional passages in their original order. Candidate
scores, search results, model, trust and source authorization do not change.

Insufficient space for mandatory rules fails explicitly under the opt-in policy.
It never silently removes a rule. The total serialized bundle remains the byte
budget unit. `explain(id, true)` adds control/evidence and primary/additional pass
information to the local selection audit, without repeating it in the agent bundle.

Explicit lifecycle handoffs still use the existing project-bound handoff primitive.
This experiment does not add a mandatory-handoff context API or promise that a
retrieved handoff always fits. Hosts must account for separately rendered handoffs
in their total prompt budget. No compact wire format or new host-hint API is added.

Do not enable this policy by default before hybrid, holdout, passage-level noise and
live agent validation. No RIVET production cutover is authorized by this experiment.
