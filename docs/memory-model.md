# Memory model

Not everything an agent says is memory. The versioned Core contracts distinguish
`source`, `rule`, `decision`, `memory`, `experience`, `working_context`, `handoff`,
and `observation`. Working context is not a public ingestion API. Observations can
be submitted through the generic adapter/MCP and are never auto-promoted to memory.

A candidate contains `key`, `text`, `kind`, and optional `source_path`. It cannot provide a
project ID, trust level, or overwrite target. The host-bound Core resolves those.

```text
validate and classify → deduplicate → check current source
                     → detect key conflict → persist / reject / needs_attention
```

The first policy is deliberately extractive: text must occur verbatim in a current
indexed project source. This makes source precedence enforceable without an LLM
or unreliable semantic contradiction detector. Agents can propose broader claims,
without evidence; those enter `proposed` for explicit local human review. Claims
with unsupported source evidence remain `needs_attention`. To curate knowledge, write it
into the appropriate project document, sync, then propose its exact excerpt.

Routine test/build success and temporary modification reports are `reject`.
Duplicate active claims with the same key, text, source, and source version return
the existing ID. Different active text under a claim key becomes
`needs_attention`; nothing is silently overwritten. To replace an active claim,
review and explicitly forget it before proposing the replacement.

Every state change appends a revision. Proposals and revisions are local records,
not a Git replacement. Forgotten and rejected records are not retrieved as context.
Active memories are also suppressed whenever their source path/hash no longer
matches a current resource, even if their stored policy status remains `persist`.
Free-form candidates can be explicitly accepted/rejected by the trusted local CLI,
with review metadata and append-only revisions. Accepted free-form knowledge ranks
below current sources. See [the review workflow](operations.md).

The policy detects structural conflicts by claim key. It does not claim to detect
arbitrary contradictions between natural-language sources or across different
keys. If sources disagree, curate the source documents. Current sources always
rank before derived memories.
