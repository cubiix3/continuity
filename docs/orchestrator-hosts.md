# Orchestrator hosts

The SDK composition root is privileged. Keep it inside the host process; pass
only its bound `ProjectClient` to an agent adapter. Host API version is exposed as
`CONTINUITY_HOST_API_VERSION` (currently 1). Context schema version remains 1.

```ts
import { openContinuity, CONTINUITY_HOST_API_VERSION } from 'continuity-local';

if (CONTINUITY_HOST_API_VERSION !== 1) throw new Error('Unsupported host API');
const host = openContinuity(privateStateDirectory, {
  sources: {
    include: ['AGENTS.md', 'README.md', 'docs/', 'src/', 'tests/'],
    exclude: ['docs/archive/'],
  },
});
host.init(registeredProjectRoot);
const client = host.workspace(registeredProjectRoot, workerWorktreeRoot);
const bundle = await client.context({ task: 'Fix reconnect timeout', role: 'implementation' });
// client.latestHandoff() belongs to this workspace.
// client.handoff(hostSelectedHandoffId) supports an explicit same-project transition.
host.close();
```

Use `host.project(root)` for the primary checkout. The host must derive roots from
its registration/worktree registry, never task text. Persist the host's project
mapping in private local state. A clone is a new project; linking display names
does not authorize shared context. Attaching a registered Git worktree is explicit.

Attached workspace source snapshots and semantic caches are separate. Reviewed
memories belong to the project. Context provenance and handoffs include an opaque
workspace ID. Host options only narrow indexing; they cannot permit secrets or
escape the canonical root. Include patterns use gitignore matching semantics.

Context requests still rescan for freshness, including after a semantic network
wait. Parallel clients use SQLite transactions for snapshot replacement, not a
transaction held across backend calls. Hosts should measure scanning costs before
cutover; this API does not promise an event-driven incremental filesystem watcher.

Optional semantic setup and failure behavior are unchanged. Do not pass provider
accounts, credentials, raw logs or chat transcripts as memory or handoff content.
