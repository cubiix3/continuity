# Security policy

Before the first release, the latest commit on `main` is the supported development
version. Once 0.1 is released, security fixes target the latest 0.1.x patch and
`main`; older patches should be upgraded. Continuity is early software, with no
LTS promise or independent professional security audit claim.

Please report vulnerabilities through
[GitHub private vulnerability reporting](https://github.com/cubiix3/continuity/security/advisories/new).
Do not open public issues containing exploit details, project data, or credentials.
Include a minimal synthetic reproduction, affected version, expected boundary,
and observed behavior. We will acknowledge and investigate reports as maintainer
capacity allows; no response-time guarantee is implied.

Project isolation, secret indexing, memory poisoning, path escapes, and accidental
API exposure are security issues. Read [the security model](docs/security.md) for
the boundaries and explicit non-goals.
