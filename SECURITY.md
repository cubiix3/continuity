# Security policy

The latest commit on `main` is the supported development version. Continuity is
early software; no stable release or independent security audit is claimed.

Please report vulnerabilities through
[GitHub private vulnerability reporting](https://github.com/cubiix3/continuity/security/advisories/new).
Do not open public issues containing exploit details, project data, or credentials.
Include a minimal synthetic reproduction, affected version, expected boundary,
and observed behavior. We will acknowledge and investigate reports as maintainer
capacity allows; no response-time guarantee is implied.

Project isolation, secret indexing, memory poisoning, path escapes, and accidental
API exposure are security issues. Read [the security model](docs/security.md) for
the boundaries and explicit non-goals.
