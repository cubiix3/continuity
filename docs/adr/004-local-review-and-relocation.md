# 004 — Explicit local review, relocation and bounded reporting

Status: accepted.

The next vertical slice keeps the project-bound agent contract and adds trusted
host operations instead of granting more agent authority. Free memory proposals
need a local reviewer; project relocation needs the previous identity/path and a
verified destination. Neither operation is an MCP/HTTP tool. Arbitrary same-user
shell execution remains outside this application capability boundary.

SQLite schema v2 adds an append-only rebind audit and creation timestamps needed
for retention previews. No automatic deletion is enabled. The six retention
classes retain different lifetimes; important memory revision history remains
explicit-review-only. Existing v1 records receive migration-time timestamps.

The byte budget remains authoritative. An optional host-provided estimator reports
tokens for selected items, without adding a provider library or changing packing
policy. The report's own metadata consumes bytes too. The first measured lexical
baseline is preserved, including misses and contradictory matches.

Runtime integration uses the same MCP server for Claude Code and Codex. Windows
sandbox setup is a host concern, not a Core provider branch. Live fixtures are
opt-in and store raw evidence outside project roots; deterministic contract and
packaging checks run in Linux/Windows CI.
