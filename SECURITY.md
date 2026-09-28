# Security policy

Security fixes target the latest published release and `main`. Users of older
releases should upgrade to the latest version. Continuity is early software,
with no LTS promise or independent professional security audit claim.

Please report vulnerabilities through
[GitHub private vulnerability reporting](https://github.com/cubiix3/continuity/security/advisories/new).
Do not open public issues containing exploit details, project data, or credentials.
Include a minimal synthetic reproduction, affected version, expected boundary,
and observed behavior. We will acknowledge and investigate reports as maintainer
capacity allows; no response-time guarantee is implied.

Project isolation, secret indexing, memory poisoning, path escapes, and accidental
API exposure are security issues. Read [the security model](docs/security.md) for
the boundaries and explicit non-goals.
