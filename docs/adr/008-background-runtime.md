# 008 — User background runtime and bounded source reconciliation

## Decision

Use a Windows Task Scheduler **current-user InteractiveToken / least-privilege**
logon task. Its action is the absolute Node executable and quoted installed CLI
`runtime start` arguments, including an explicit canonical home. The short starter
launches a detached hidden Node runtime; no PowerShell command is persisted as the
task action. A fixed adapter uses Task Scheduler COM through noninteractive PowerShell
to register/inspect/remove the task. Paths are passed as encoded JSON data.

Task names are home-derived; an ownership marker must match before updating/removing.
No elevation, credentials, service, restart supervisor, or remote binding is added.

## Alternatives

- Startup shortcuts are simple, but add shell/window-style and shortcut-target
  handling while offering less explicit registration inspection.
- HKCU Run is removable but encodes a shell command and provides less task metadata.
- Task Scheduler records executable and arguments separately, exposes enablement,
  supports current-user login without a saved password, and can launch the exact
  action in tests. InteractiveToken avoids S4U/batch-logon privilege requirements.

See [Microsoft's task security contexts](https://learn.microsoft.com/en-us/windows/win32/taskschd/security-contexts-for-running-tasks).

## Runtime and source policy

The existing Dashboard server remains in the control process. One worker thread
opens the existing SDK to run synchronous source traversal without blocking the
Dashboard. This is another trusted host connection, not a second storage/Core model.
All SDK sync callers share an OS-owned scope lease (Windows named pipe, Linux
abstract Unix socket). There is no PID-reuse-based stop or stale PID lock recovery.

Nonrecursive `fs.watch` handles attach only to directories returned by the existing
scanner. Recursive OS watches would observe ignored dependency/build trees too.
The scanner exposes metadata-only traversal with the same boundaries, not a second
parser or exclusion list. Watches are hints: 1.5-second debounce, a serial dirty
queue, 30-second registration discovery and 10-minute reconciliation provide bounded
operation. Above 512 eligible directories per scope, reconciliation is the fallback.
Local per-project source scope (ADR 010) is part of that one resolved selection:
event acceptance reuses the scan's exclusion, include-prefix and include checks.
Discovery rebuilds a scope's watch plan when its local filter changes or becomes
invalid/valid again; invalid configuration removes watches and fails scans closed.

## Consequences

No schema migration or retrieval policy change. Source limits and failures remain
visible; large unsupported scans are not made successful by raising limits.
Source scans can delay worker messages, but not runtime control. An unhandled worker
failure requires an explicit runtime restart. Real login verification remains a
separate acceptance step from programmatically launching the registered task.
