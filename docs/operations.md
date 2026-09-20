# Local administration

These are trusted local operator operations. They are not MCP or HTTP tools.
The local CLI is not an authentication boundary against an agent with arbitrary
OS execution privileges; restrict that agent's OS permissions if necessary.

## Move versus clone

Clones and copies always receive a new identity when initialized. Copying a
`.continuity` folder does not transfer identity; such content is excluded from
indexing. For an actual move, retain the old project ID and canonical path from
`continuity project list`, move the directory, then run:

```sh
continuity project rebind prj_<id> --from <previous-root> --to <new-root>
continuity --project <new-root> sync
```

The old directory must no longer exist. The ID and previous canonical path must
match the local registry; the new path must resolve to an existing directory and
must not already be registered. An atomic update preserves identity and records
the old root, new root and timestamp in `project_rebindings`. Existing bound
clients fail after relocation and must reconnect. The operator is responsible
for selecting the intended destination; matching names/remotes do not grant identity.

## Human memory review

```sh
continuity memory remember "Preserve request identifiers across reconnect attempts." --key retry-id --kind experience
continuity memory pending
continuity memory approve mem_<id> --by operator
continuity memory reject mem_<id> --by operator
```

Free-form candidates are `proposed`. Source-backed exact excerpts retain the
existing `persist` policy path. Unsupported claimed evidence is `needs_attention`;
routine output remains `reject`. Human review changes a pending record to
`accepted` or `rejected`, records reviewer/time/decision, and appends a revision.
Approval never invents source evidence or silently overwrites an active claim key.
Review and explicitly forget a conflicting active claim before approving another.

Current sources rank above accepted memories. Evidence-bound memories still
require the same current source hash after human approval. Free-form approval is
an operator decision, not automatic contradiction detection or source authority.
There is deliberately no agent-accessible `approve`, `reject`, or `rebind` tool.

## Retention preview

```sh
continuity retention status
continuity prune --dry-run
```

Both report counts and eligible records for the current project only. They never
delete anything. Calling `prune` without `--dry-run` is rejected.

| Class | Preview policy |
| --- | --- |
| Sources | Inactive versions older than 30 days; retain current sources |
| Context history | Older than 30 days |
| Observations | Older than 14 days |
| Handoffs | Older than 90 days; always retain latest |
| Memory revisions | No automatic eligibility; explicit review required |
| Sessions | Older than 90 days and unreferenced by handoffs/observations |

Existing contexts/sessions receive migration-time timestamps because v1 did not
record creation timestamps separately. They are not immediately made eligible.
These previews are not secure deletion and do not change backup/WAL retention.

## Diagnostics

`doctor` checks SQLite integrity, schema version, FTS availability/references,
foreign-key and provenance orphans, embedded project IDs, source hashes/paths,
root accessibility/canonical identity, MCP dependency availability, Continuity
version and Node runtime. Problems cause a nonzero CLI exit status. An unreadable
or physically corrupt database can prevent startup; that also produces a nonzero
error rather than a healthy result. No repair or deletion happens automatically.

Node 24's built-in SQLite API is pre-stable; patch versions may print an
ExperimentalWarning. The existing storage port remains the isolation layer.
