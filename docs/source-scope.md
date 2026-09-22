# Local project source scope

Project identity stays bound to its registered root. A local source filter can
narrow the files Continuity reads without splitting the project, changing Git
ignore rules, or writing files into the repository.

From an already registered project:

```sh
continuity sources show
continuity sources preview --include "docs/**" "tests/**" "README.md"
continuity sources set --include "docs/**" "tests/**" "README.md" --exclude "docs/archive/**"
continuity sources preview
continuity sync
continuity sources clear
```

`--project` and `--home` work as for other CLI commands. `preview` with patterns
evaluates a replacement candidate without writing configuration or updating the
index. Without patterns it previews the current selection. `set` replaces only
the current project's filter; `clear` removes only that entry. Neither registers,
rebinds, nor deletes a project. Sync explicitly applies the new selection to the
index. Existing clients also read the current filter on their next source scan.

Preview reports UTF-8 bytes, eligible files and skipped oversized files. When a
bound is reached it reports `limit_exceeded: true`, `complete: false`, a reason,
and exits nonzero. Those counts cover only the scan up to the first limit, not
the entire repository. The limits remain 2,000 files, 8 MiB total, 64 KiB per file
and 20,000 visited directory entries. Oversized files are skipped, not truncated.

## Local configuration

The file is `<CONTINUITY_HOME>/sources.json` (default home: `~/.continuity`).
It is owned by the trusted local host, never loaded from project files or accepted
as agent tool arguments.

```json
{
  "version": 1,
  "projects": {
    "prj_00000000-0000-0000-0000-000000000000": {
      "include": ["docs/**", "tests/**", "README.md"],
      "exclude": ["docs/archive/**"]
    }
  }
}
```

Use an existing ID from `continuity project list`. With no file or no entry for
a project, previous FileSources behavior is preserved. Unknown fields and versions
are rejected. The file is bounded to 64 KiB and 128 project entries. Each entry
has at least one nonempty include/exclude list, at most 64 patterns per list and
256 characters per pattern.

Patterns use `/` and are rooted at the registered project or bound worktree root.
`README.md` selects that root file; `docs/**` selects the subtree; `**/*.md` can
match at any depth. Supported wildcards are `*`, `?` and whole-segment `**`, using
the existing FileSources ignore engine. Spaces and Unicode names are supported.
Absolute paths, backslashes, empty/dot/parent segments, negation, comments, escapes
and bracket/brace syntax are rejected. Quote patterns to prevent shell expansion.

Local include lists intersect any trusted host include list. Exclusions from
either layer apply. Filters cannot override built-in secret/generated exclusions,
Git ignore rules, canonical root checks, nested registered projects, symlink or
hardlink protection, or the source limits. Filtered-out sources cannot be served
by current source previews. Historical audit records remain stored.

Writes use an exclusive local lock, a flushed same-directory temporary file and
atomic rename. Concurrent writers fail without overwriting another update. A
crash before rename leaves the old file intact; after a crash, inspect and remove
a leftover `sources.json.lock` only when no configuration writer is running.
Invalid or unreadable configuration blocks scans and previews, including previews
of proposed replacements. Correct the file rather than relying on a fallback.
`doctor` and Dashboard Diagnostics report the problem. Workspaces shows the filter
and the source count from the last successful sync; it does not scan on navigation.

## Background runtime

The SDK `sourceFor` is the composition point for every FileSources consumer. Its
selection callback reads the local filter for the bound project at scan time;
workspace clients, source previews, retrieval-health snapshots, manual sync and
the background runtime's automatic sync use it.

The runtime watch plan is the metadata-only mode of the same FileSources traversal.
Directory pruning and watch event acceptance use the same resolved selection
layers as the scan; there is no separate watcher filter. Filtered-out directories
are not watched, so a narrow include list also bounds the watcher set.

Runtime discovery (every 30 seconds) compares each project's filter with the one
its watches were planned for. A change from `sources set`/`clear` or a repaired file
replaces the watches and schedules a sync without restarting the runtime. An
invalid file removes the watches and fails every scan closed; affected scopes report
`degraded` with the configuration error while the runtime and Dashboard keep running.

Scope selects historical handoff documents as source text only. It does not turn
them into durable memory, promote observations, or change memory trust policy.
