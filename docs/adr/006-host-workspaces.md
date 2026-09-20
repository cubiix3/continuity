# Host-bound Git workspaces

Status: proposed for orchestrator integration.

A worker checkout and its integration checkout can contain different current
versions of the same file. Rebinding a project between them invalidates active
clients and overwrites source freshness. Registering unrelated projects instead
would split durable project knowledge. This was reproduced while auditing a real
orchestrator before integration.

The trusted SDK host can attach a Git worktree to an existing project. Canonical
roots, the common Git directory and Git's worktree registration must agree.
Copies, unrelated repositories and roots already registered as projects are
rejected. No project or workspace selector is accepted in agent requests.

Migration 4 partitions resources, sync state and semantic manifests by workspace.
Existing records retain their primary workspace without rewriting their IDs.
Passage identities include the workspace for attached worktrees, even when their
content is identical. FTS and semantic candidates receive only that partition;
source revalidation, authority and byte budgeting remain unchanged.

Memories remain project-scoped. Source-backed claims require a matching current
path and hash in the requesting workspace. Handoffs record their source workspace;
latest-handoff and context use the bound workspace. An explicit handoff ID can be
read across workspaces of the same project for a host-directed transition. It is
an agent report, not a claim that its source files exist in the destination.

Large hosts may narrow FileSources with include/exclude patterns. These are
trusted SDK options, not repository-controlled security policy. All existing
secret, symlink, nested-project and size limits still apply. Limits are not raised.

This does not manage branches, allocate worktrees, schedule agents or recover
processes. Attached worktrees must remain registered with Git. Workspace moves and
non-Git snapshots are not supported. SQLite remains behind the existing port;
there is no second context store or retrieval implementation.
