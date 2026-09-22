# Continuity v0.1 scope

Continuity is a local continuity layer for projects and AI agents. It preserves project identity, isolated workspaces, structured handoffs, durable memory with explicit trust, provenance, context audit, source freshness and diagnostics. The unreleased automatic-memory policy activates attributed agent lessons without routine approval; human review remains optional.

The CLI, host API and local Dashboard are first-class clients of the same Core. Coding agents remain responsible for investigation using their own Read, Grep, Git and test tools. Search is optional; offline FTS is the default experience. No semantic service is required.

## Dashboard

The local Dashboard makes registrations, handoffs, memory review and context selection inspectable. It serves local assets and a dedicated browser API from one loopback process. It does not replace the existing non-browser HTTP API. Lists are bounded, source previews are read-only, and historical context is explicitly historical. Memory approval/rejection uses the trusted host review capability, never an agent tool.

## Outside v0.1

Agent orchestration, a code editor, Git management, cloud hosting, accounts, teams, telemetry, automatic repair, source editing, model downloads and retrieval research are outside scope. RIVET remains an experimental Draft/Shadow integration with legacy authority. There is no cutover commitment.

Compact delivery remains independently reviewable in PR #7. Source diversity in PR #6 did not demonstrate a robust general default; the experimental PR was closed without merging after this scope review. Its evidence remains in Git and the original PR. Neither is a Dashboard dependency.
