# Cross-agent validation

The live test uses `scripts/real-agents.mjs`. It creates a small existing reconnect
manager in project A, with the rule **Do not introduce a second reconnect manager**.
Project B uses similar reconnect terminology but contains a distinct canary and
the opposite instruction. Both are registered in one isolated Continuity store.

1. Claude gets context, search results and latest handoff through MCP. It implements
   bounded retry, records an architectural decision, proposes memory, and leaves
   success reset unfinished in a structured handoff.
2. A new Codex process reads repository files and Continuity. It implements the
   reset, writes six executable tests, updates the decision, proposes memory and
   leaves a handoff for independent verification.
3. A new Claude process reads that handoff and current context, inspects the code,
   runs tests, and records its own handoff.
4. A deterministic verifier checks retry exhaustion and reset, runs the fixture
   tests, checks the final handoff status, validates project ownership/provenance
   and the byte budget, and searches the agent logs for the project B canary.

There is no transcript passed between these processes. Logs are test evidence
outside the project roots, not retrieval inputs. Each invocation is a fresh session.
Provider-internal training or unrelated prior knowledge is not a testable claim;
the fixture's task state is carried by project files and Continuity only.

The first Codex run was genuinely blocked by local filesystem policy. Both Codex
and the return Claude recorded that failure accurately. This is retained in the
local evidence, and described in the Codex guide. The later run explicitly selects
the host's existing Windows sandbox mode, without removing workspace isolation.

The verifier writes a small path-free `real-agent-result.json` only after all
assertions pass. Full logs, local identities, account details, and machine paths
are deliberately not committed. Live model tests are opt-in; CI validates the
transport, contracts, failure boundaries and packed CLI without model credentials.
