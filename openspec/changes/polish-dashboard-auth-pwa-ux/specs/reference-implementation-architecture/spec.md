## MODIFIED Requirements

### Requirement: Reference-only surfaces are explicit

Debugging, replay, trace, and operator-control surfaces that are useful for the reference implementation but are not part of core PDPP SHALL be explicitly marked as reference-only.

#### Scenario: Owner auth placeholder session lifetime is configured

- **WHEN** placeholder owner authentication is enabled with `PDPP_OWNER_PASSWORD`
- **THEN** the reference SHALL issue a finite signed owner-session cookie
- **AND** the default owner-session lifetime SHALL be long enough for multi-day operator work by default
- **AND** deployments SHALL be able to override the lifetime explicitly with `PDPP_OWNER_SESSION_TTL_SECONDS`.

#### Scenario: Hosted owner login renders in dark mode

- **WHEN** an owner opens a reference-hosted owner page such as `/owner/login` in an OS dark-mode context
- **THEN** the page SHALL render readable dark-mode colors without requiring dashboard JavaScript or website-only theme state.
