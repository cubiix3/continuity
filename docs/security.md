# Security model

Project isolation is a security boundary within Continuity's interfaces. The
trusted local user or host chooses a project before agent input is accepted.

| Threat | Control | Test evidence |
| --- | --- | --- |
| Cross-project leakage | Canonical local identity; project-filtered storage queries and object lookup | Two-project E2E, foreign handoff/context lookup |
| Prompt-based scope widening | No project selector in agent schemas; strict unknown-field rejection | Core, HTTP, and real MCP injection tests |
| Symlink/path traversal | Realpath validation; skip symlinks and junctions, hard-linked files, nested project roots | Alias, traversal, junction tests |
| Secret indexing | Mandatory filename exclusions plus content scanning and gitignore | Secret names, token patterns, nested ignore tests |
| Memory poisoning | Exact source excerpts only; free-form proposals need attention | Unsupported claims and routine-output rejection |
| Stale context | Refresh and hash before retrieval; require matching memory evidence version | Source change, deletion, and new exclusion tests |
| Silent conflicts | Stable claim key; conflict becomes `needs_attention`; append revisions | Conflict, forget, and revision tests |
| Deleted sources | Clear old searchable content; mark missing | Deleted-source test |
| Malicious repository content | Text cannot change project capability or policy | Prompt scope test; fixed host binding |
| Compromised agent using tools | Six-operation adapter without DB or namespace access | MCP tool inventory and injected scope rejection |
| API exposure | Loopback-only CLI binding, bearer token, host/origin checks, body limit | Real HTTP authentication, origin, Host, and oversized-body tests |

## Trust is provenance, not permission

`authoritative` means a current file in the host-selected project. It does not mean
that the file is benign, reviewed, Git-tracked, or allowed to issue system
instructions. `derived` means an exact excerpt whose current source hash was
verified by policy. `agent_observation` labels handoff claims. `untrusted` labels
unverified proposals. `verified` is reserved for an explicit future verification
workflow; no current operation assigns it.

An agent consuming a bundle must continue treating source content as data under
its own instruction hierarchy. Continuity cannot prevent a downstream model from
following malicious prose. It prevents that prose from widening its own scope.

## Exclusions and limits

`.env`, `.env.*`, private-key containers, credentials/secrets filenames, `.git`,
`.continuity`, dependencies, build outputs, caches, and common local state files
are denied independently of gitignore. Common token and private-key patterns
cause the whole file to be skipped. Detection is heuristic, not a secret-scanning
guarantee. Avoid indexing repositories containing sensitive data outside recognized
patterns. Explicit handoff/proposal input is local user data and may itself be
sensitive; it is not a credential vault.

Only local project roots selected by the operator are supported. A root is a
directory, not an inferred Git remote. Do not initialize a parent directory that
intentionally contains unrelated unregistered projects. Registered child roots
and nested Git repositories are excluded. Symlinked project roots resolve to the
same canonical identity; internal symlinks are never indexed.

The same-user filesystem is trusted not to be maliciously mutated during a scan.
Realpath checks and link exclusion are not an OS sandbox against concurrent
filesystem replacement by another process with the same permissions. Processes
with arbitrary OS code execution or database access can bypass application-level
capabilities. Use operating-system account/sandbox separation for hostile agents.

## Local storage and history

The database directory and file request private POSIX permissions (0700/0600).
On Windows, protect the state directory with your account's ACLs. There is no
at-rest encryption. Do not use a shared writable `CONTINUITY_HOME`.

Historical context bundles, handoffs, and memory revisions retain their original
contents locally. `inspect` and `explain` are explicitly historical; they do not
revalidate or claim current truth. `memory forget` deactivates a claim, not a
secure erase. Deleting a source does not purge previous bundles, revisions, WAL,
backups, or filesystem remnants. Retention previews now report eligibility;
deletion and secure purge remain future work.

Additional failure tests cover link chains/junctions, copied identity artifacts,
hostile rules/handoffs, corrupted scope/source records, abandoned transactions,
atomic sync rollback, concurrent process registration/proposals, and explicit
relocation. Sync detects size/mtime/canonical-path changes during individual reads.
Freshness is a checked filesystem snapshot, not a lock preventing another process
from editing files after that snapshot. Retry failed syncs; stale fallback is not used.

Human review is exposed only by the local host/CLI. It does not create a security
boundary against an agent that can execute arbitrary CLI commands as that same user.
Reviewer labels are audit metadata, not authentication. Approved free-form claims
remain below current sources and do not gain source-authoritative trust.

## Local API

The CLI has no remote binding option. Every request needs a bearer token, including
health checks. `CONTINUITY_API_TOKEN` supplies a host-managed token; otherwise a
random session token is printed to stderr at startup. Do not expose this output
or proxy the service publicly. Requests with `Origin` or unexpected `Host` values
are rejected; no CORS permission is sent. Bodies are limited to 64 KiB.

Remote use is unsupported. This design does not claim multi-user authorization,
rate limiting, TLS, or safety behind a reverse proxy.

Report vulnerabilities through [SECURITY.md](../SECURITY.md).
