## Decision

Do not rewrite the normative protocol around the current shortcut. The reference should be honest that it has not shipped a generic OAuth authorization-code redirect surface, while the auth design should avoid saying all app tokens are obtained only through that profile.

## Acceptance Checks

- `spec-auth-design` no longer states that the app token is always obtained through authorization code flow.
- Reference implementation docs clearly describe the live PAR plus consent direct-token profile.
- Examples continue to identify generic authorization-code redirects as out of scope.
