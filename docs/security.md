# Security model

## Optional semantic retrieval

Semantic adapters receive only resources authorized by the host-bound project and
the existing source scanner. Ollama scoring loads only that project's versioned
vectors. OpenViking search receives exact current leaf URIs, with pre-retrieval URI
filters; no empty or global target is permitted. Neither backend supplies content,
trust, memory status or namespace grants to the broker. Unknown candidate IDs fail
closed to lexical retrieval. Source hashes and bindings are rechecked after awaits.

Configuration comes from the private Continuity home, not repository prose. Only
literal loopback endpoints are supported; redirects and oversized responses are
rejected. Network failures are reported as degraded retrieval. A malicious local
backend can still impair relevance or availability; it cannot authorize another
project through this capability. See [backend limits](retrieval.md), including
OpenViking operator-managed revisions and retained remote resource versions.

Project isolation is a security boundary within Continuity's interfaces. The
trusted local user or host chooses a project before agent input is accepted.

| Threat | Control | Test evidence |
| --- | --- | --- |
| Cross-project leakage | Canonical local identity; project-filtered storage queries and object lookup | Two-project E2E, foreign handoff/context lookup |
| Prompt-based scope widening | No project selector in agent schemas; strict unknown-field rejection | Core, HTTP, and real MCP injection tests |
| Symlink/path traversal | Realpath validation; skip symlinks and junctions, hard-linked files, nested project roots | Alias, traversal, junction tests |
| Secret indexing | Mandatory filename exclusions plus content scanning and gitignore | Secret names, token patterns, nested ignore tests |
| Memory poisoning | Exact excerpts use source hashes; attributed agent claims activate at lower trust; conflicts quarantine | Forged-trust rejection, routine filtering, same-key conflicts and source supersession tests |
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
verified by policy. `agent_observation` labels handoff claims and automatically active
agent-learned memories; attribution is self-reported and does not prove truth. `untrusted` labels
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

Human review is exposed only by the trusted local host/CLI and human Dashboard. It does not create a security
boundary against an agent that can execute arbitrary CLI commands as that same user.
Reviewer labels are audit metadata, not authentication. Approved free-form claims
remain below current sources and do not gain source-authoritative trust.

## Provider hooks and autosave

Provider hooks read only structured hook fields. The `Stop` hook reads
`last_assistant_message` only on the stop that answers Continuity's own save
request, and only from a tagged JSON block. Transcripts, transcript paths and tool
payloads are never opened. Hook commands contain only absolute paths and fixed
words, quoted literally for PowerShell and POSIX `sh`. Hooks never exit 2. They
block a stop only with an explicit JSON decision, never on a continuation stop, so
recursion is impossible.

Saved claims pass the normal memory policy with the provider's session as
attribution. They cannot reach human-reviewed trust, choose a project or workspace,
become project rules or override an accepted memory. A save is applied only in the
project or workspace where the edits and the request happened; a `cd` elsewhere or a
nested Git checkout gets nothing. Secret-looking content is checked per raw field
and dropped before storage.

A handoff close applies only to the open handoff the host offered in that session's
request. It is bound to the same project and workspace, and it never rewrites the
handoff. Autosave runs by default only in attended interactive sessions, so headless
runs keep their final output. The mode comes from the hook's environment: Claude Code's
session variables, and for Codex the app-server daemon marker without Codex's
tool-command markers. Whoever controls that environment can switch autosave, as with
`CONTINUITY_AUTOSAVE`. Switching it changes only whether a save is requested, never
trust, scope or attribution. A prompt-injected source can still lead the model to propose
a false lesson; it is attributed as an agent observation, and sources and human
review outrank it. See [agent lifecycle](agent-lifecycle.md).

## Local human Dashboard

The Dashboard is an installation-wide trusted human client, separate from agent
capabilities. It can navigate registered projects and workspaces, but object
lookups still validate their ownership. It cannot select an arbitrary filesystem
root or namespace. Source previews use the existing scanner and fail closed when
the source is removed or unavailable; context audit is explicitly historical.

`continuity dashboard` binds only to 127.0.0.1. Assets and API share an origin.
Exact Host/Origin checks, Fetch-Site rejection and a custom-header bootstrap
protect a per-process capability kept only in browser memory. Data reads require
that capability; writes additionally require the exact Origin and JSON POST.
No CORS grant, URL token, localStorage credential or cookie is used. CSP prevents
remote scripts, framing and inline script execution; project content is rendered
through text nodes. Browser extensions and arbitrary same-user processes are not
isolated by this boundary. See [the Dashboard contract](dashboard.md).

## Local agent API (`serve`)

The CLI has no remote binding option. Every request needs a bearer token, including
health checks. `CONTINUITY_API_TOKEN` supplies a host-managed token; otherwise a
random session token is printed to stderr at startup. Do not expose this output
or proxy the service publicly. Requests with `Origin` or unexpected `Host` values
are rejected; no CORS permission is sent. Bodies are limited to 64 KiB.

Remote use is unsupported. This design does not claim multi-user authorization,
rate limiting, TLS, or safety behind a reverse proxy.

Report vulnerabilities through [SECURITY.md](../SECURITY.md).
