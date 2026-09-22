# RIVET dogfood: product conclusion

The Continuity × RIVET experiments separated retrieval quality from identity, handoff and audit correctness. Detailed experiment artifacts remain with the dogfood work; this document records the product conclusion, not a new benchmark.

## Proven in the exercised flows

- Project isolation and Git workspace/worktree separation held.
- Fresh Claude → Codex → Claude sessions exchanged structured handoffs without chat transcripts. Crash/replacement flows also worked.
- Provenance and source freshness boundaries held in tested integrations.
- FTS remained a reliable offline fallback.
- Semantic retrieval improved some queries but was not consistently superior.
- Experimental compact delivery substantially reduced metadata overhead while preserving local audit records.
- Native coding-agent Read/Grep is the better established default for source investigation. The small live comparison did not show a reliable task-success advantage for Continuity search; this is not a claim that search can never help.

## Not proven

Continuity replacing native source investigation, semantic retrieval as a default, a production symbol-graph architecture, full RIVET cutover, and Grok structured-result compatibility remain unproven. Ranking, diversity, hints, expansion, contextual embeddings and model experiments did not justify production changes.

## Product conclusion

Continuity focuses on continuity **between agents**, not replacing their IDE/code tools: identity, workspaces, durable reviewed memory, structured handoffs, provenance, audit and diagnostics. Optional search remains available. RIVET remains Draft/Shadow with legacy authority; no cutover or legacy deletion follows from this conclusion.
