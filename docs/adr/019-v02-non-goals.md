# 019: v0.2 non-goals

## Context

Continuity is a local, project-bound context, memory and handoff layer. The pre-v0.2 work is to make the shipped behavior reliable and accurately documented. Adding another product surface would make that release harder to verify.

## Decision

- Continuity is not a transcript or tool-output archive, code-search replacement, editor, Git manager, agent orchestrator, or agent execution engine. Coding agents inspect, change and run code with their native tools.
- There is no cloud service, account system, team synchronization, telemetry, or cross-project global search. The trusted host keeps project scope fixed.
- No semantic model or network service is downloaded, installed or enabled automatically. Optional semantic backends remain within the existing authorized-project retrieval boundary.
- No automatic data erase or destructive retention is added. Existing retention commands preview eligible records; they do not delete them.
- The experimental RIVET draft/shadow integration does not become authoritative and has no cutover commitment.

These are v0.2 scope decisions, not claims that the excluded capabilities are impossible or planned for a later version. Revisit a boundary only with a concrete problem and evidence. [Stability boundaries](../../STABILITY.md) describe current behavior.
