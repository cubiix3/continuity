# 010: Local per-project source scope

Project identity must remain stable when a repository exceeds bounded indexing
limits. Store versioned filters in the Continuity home, keyed by registered
project ID. Never write repository configuration or infer new project identities.

The trusted SDK resolves the filter at the FileSources composition point on each
scan. Existing include/exclude semantics are reused, with local patterns anchored
to the bound root and selection layers intersected. CLI preview runs that same
bounded selection without updating the index. Source previews and workspace
clients cannot bypass it. Limits and mandatory exclusions remain unchanged.

Invalid configuration fails closed. Doctor can open the installation and report
the error without scanning. Writes are serialized by an exclusive lock and commit
through a flushed temporary file and atomic rename. No database migration is needed.

Runtime/watch integration remains in PR #9. Its watcher must consume these same
selection layers and refresh its plan after config changes. No runtime code is
copied into this change. See [source-scope operation and limits](../source-scope.md).
