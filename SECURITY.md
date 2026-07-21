# Security Policy

PDPP is a protocol for user-controlled, purpose-bound access to personal data,
plus a forkable reference implementation. Because it deals with personal data,
authorization, and consent, we take security reports seriously and ask that
they be disclosed privately so a fix can ship before the issue is public.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately through GitHub's private vulnerability reporting:

1. Go to the repository's **Security** tab.
2. Choose **Report a vulnerability** to open a private security advisory
   ([direct link](https://github.com/PDP-Connect/pdpp/security/advisories/new)).

This creates a confidential channel visible only to you and the maintainers. If
you cannot use GitHub's private reporting, contact a maintainer listed in
[`MAINTAINERS.md`](MAINTAINERS.md) directly and ask for a private channel before
sending any details.

When reporting, please include as much of the following as you can:

- The affected component (protocol spec, reference implementation, a specific
  package, or the site/console).
- A description of the issue and its impact (for example, grant-scope bypass,
  credential exposure, SSRF, injection).
- Steps to reproduce, a proof of concept, or affected code paths.
- Any suggested remediation.

## What to expect

- **Acknowledgement:** we aim to acknowledge a report within a few business
  days.
- **Assessment:** we will investigate, confirm the issue, and keep you updated
  on progress.
- **Fix and disclosure:** we will work on a fix and coordinate a disclosure
  timeline with you. We prefer coordinated disclosure and will credit reporters
  who wish to be named once a fix is available.

Please give us a reasonable opportunity to remediate before any public
disclosure.

## Scope

This policy covers the protocol specification, the reference implementation, and
the packages and surfaces in this repository. Because the reference
implementation is designed to be **forked and self-hosted**, operators of a
deployed instance are responsible for the security of their own deployment and
infrastructure. Reports about a specific third-party deployment should go to
that deployment's operator, not to this repository — unless the root cause is a
defect in the code or protocol here.
