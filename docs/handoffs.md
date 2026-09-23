# Structured handoffs

A handoff is an immutable, project-owned record of work. It is an agent observation,
not authoritative project policy. The Core adds the ID, schema version, project,
capture time, and provenance. The agent provides:

```json
{
  "from": { "agent": "generic-agent", "session": "session-1" },
  "task": { "goal": "Fix reconnect", "status": "blocked" },
  "completed": ["Read retry policy"],
  "remaining": ["Add a bounded retry test"],
  "decisions": [],
  "files_changed": [],
  "risks": ["Avoid retry storms"],
  "recommended_next_action": "Add a failing regression test"
}
```

Task status is `in_progress`, `blocked`, or `done`. Lists and individual text fields
are bounded and validated. Unknown top-level fields, including a forged project
ID, are rejected.

```sh
continuity handoff create --file handoff.json
continuity handoff latest
continuity handoff show handoff_<id>
continuity handoff close handoff_<id> --agent <name> --session <ref>
```

The next session can use a different agent and retrieve the same project record.
Latest is ordered by capture time and insertion order. Handoff creation also
registers the originating local session. Agent/session names are caller-supplied
labels, not authenticated identities.

## Closing a handoff

When a handoff's work is finished, close it rather than creating a "done"
handoff. A closure is lifecycle metadata stored next to the handoff: `status: done`,
`closed_at`, `closed_by` and, if a newer handoff took over, `replaced_by`. The
handoff itself is not changed, and reads return it with its `closure`.

- Closing twice is a no-op.
- A close is bound to the caller's project and workspace.
- Session start offers only the latest open handoff: not created as `done` and not
  closed.

[Autosave](agent-lifecycle.md#handoff-closure) closes the handoff it offered when the
agent reports that work finished.

Handoffs are retrieved explicitly, rather than silently mixed into every context
query. Re-check files and tests before relying on a previous agent's claims.
