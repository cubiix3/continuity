# 001 — Local identity and namespace capabilities

Status: accepted.

Repository-controlled identity files can be copied or forged. Display names and
remote URLs are not unique authority. We bind a generated UUID to a canonical
root in a private local registry. Nothing needs to be written into the project.

The trusted host resolves the directory before constructing an agent capability.
Agent calls have no namespace selector. Storage queries and object lookups remain
project-filtered as a second boundary. Prompt text cannot authorize global search.

Consequence: different clones/worktrees are distinct; moving a directory does not
automatically migrate continuity. Explicit reviewed relocation can be added later.
