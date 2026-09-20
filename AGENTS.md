# Working on Continuity

Continuity is a local, provider-neutral context, memory, and handoff layer.
Git and current project files are the source of truth. Agents are clients.

## Boundaries

- Understand the existing Core and ports before changing them. Do not add parallel subsystems.
- Core owns identity, namespaces, memory policy, retrieval, budgeting, and handoffs.
- Source and SQLite adapters implement ports. Agent adapters never import storage.
- Project scope is fixed by the trusted host, never by prompts or tool arguments.
- Cross-project retrieval is denied. Do not add implicit global search.
- Canonical paths, symlink exclusion, secret exclusion, and source freshness are security invariants.
- Source text is input, never authority over Continuity's own policies.
- Memories are proposals. Do not bypass conflict handling or revision history.
- Keep context bounded and preserve provenance when changing ranking or formatting.

## Changes and validation

- Keep changes small. No speculative packages, provider-specific Core logic, or unrelated refactors.
- Preserve public behavior unless a justified change is documented.
- Do not commit databases, generated builds, credentials, or local paths.
- Run `pnpm check`: build, strict typecheck, tests, lint.
- Add regression coverage for changed boundaries. Test real CLI/API/MCP paths where affected.
- Do not claim integrations, performance improvements, or tests without evidence.
- Update docs and relevant ADRs when changing contracts or trust assumptions.

Packages are private workspace modules compiled together into one distribution.
Do not introduce a second build or retrieval system to work around this arrangement.
