## Context

USAA retained fixtures from a live failed run showed the login page remained on the member-id step and displayed a modal: the source said it could not complete the request because its system was unavailable. The connector instead reported that the password field never appeared. That diagnostic is useful for a real DOM-shape regression, but it was inaccurate for this run.

Separately, local dependency repair failed during `@pdpp/polyfill-connectors` postinstall on Ubuntu 26.04 because Patchright does not currently support `chromium` for `ubuntu26.04-x64`.

## Decision

Keep both changes mechanical and evidence-scoped:

- Add a USAA login-step classifier for the observed source-unavailable text.
- Emit a retryable `source_unavailable` token for that class while leaving ordinary missing-password-field diagnostics intact.
- Teach USAA's runtime retryable pattern to recognize the token.
- In Patchright postinstall, skip the optional Chromium download only on known unsupported hosts unless `PDPP_REQUIRE_PATCHRIGHT_BROWSER_DOWNLOAD` is set.

## Alternatives

### Add more USAA selectors or longer waits

Rejected. The retained fixture showed a source outage modal, not a delayed password field. More selectors or waits would make the failure slower and less honest.

### Disable Patchright postinstall unconditionally

Rejected. The current postinstall still provides a useful setup path on supported platforms. The skip should be targeted to the known unsupported platform and explicit skip envs.

### Treat unsupported Patchright install as success in every environment

Rejected. Strict environments can set `PDPP_REQUIRE_PATCHRIGHT_BROWSER_DOWNLOAD=1` to fail instead of skipping.

## Acceptance checks

- USAA source-unavailable text classifies as `source_unavailable`.
- Ordinary missing-password-field text remains a selector-shape diagnostic.
- USAA runtime retryable classification recognizes `source_unavailable`.
- Patchright postinstall exits successfully on Ubuntu 26.04 without downloading Chromium by default.
- Patchright postinstall fails on Ubuntu 26.04 when `PDPP_REQUIRE_PATCHRIGHT_BROWSER_DOWNLOAD=1`.
