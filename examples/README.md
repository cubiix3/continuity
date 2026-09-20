# Try the complete slice

Create an empty directory for a disposable project, enter it, and add `AGENTS.md`:

```text
Reconnect uses bounded retry attempts.
```

With the built CLI on your PATH:

```sh
continuity init
continuity sync
continuity search "reconnect"
continuity context "implement reconnect" --budget 6000
continuity memory remember "Reconnect uses bounded retry attempts." --key reconnect --source AGENTS.md --kind rule
continuity memory list
```

Copy [handoff.json](handoff.json) into the project and run:

```sh
continuity handoff create --file handoff.json
continuity handoff latest
continuity doctor
```

Open another session in the same project and retrieve the handoff. Change the rule
in `AGENTS.md`, then request context again: source refresh is automatic and the old
memory's evidence hash no longer qualifies it for retrieval.

Create a second project in a sibling directory and repeat with different text.
Request context from the first project with a query mentioning both. Only the
first project's namespace is accessible. This workflow is also exercised in
`tests/core.test.ts` and `tests/interfaces.test.ts`.
