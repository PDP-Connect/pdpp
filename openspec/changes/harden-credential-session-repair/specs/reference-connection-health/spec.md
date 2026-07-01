## MODIFIED Requirements

### Requirement: Connection Health SHALL Preserve Evidence Before Projection

The reference implementation SHALL model connection health as raw facts normalized into typed conditions and then into a derived projection.

#### Scenario: Raw credential failure becomes typed evidence

**WHEN** a connector run observes a source credential rejection
**THEN** the reference implementation records a `CredentialsValid` condition with `status=false`, a stable reason code, safe message, origin, observed timestamp, and remediation metadata.

#### Scenario: Stored credential rejection becomes durable connection evidence

**WHEN** a connector run that received a connection-scoped stored credential reports a definitive provider credential rejection
**THEN** the reference implementation SHALL mark that stored credential as rejected with a non-secret reason and timestamp
**AND** future run credential recovery SHALL treat that credential as unavailable until explicit owner capture or rotation writes a new active credential.

#### Scenario: Explicit credential rotation clears rejection

**WHEN** the owner captures or rotates a valid credential for a connection whose prior credential was rejected
**THEN** the stored credential SHALL return to active status
**AND** the rejected timestamp and reason SHALL no longer make the connection appear credential-blocked.

#### Scenario: Browser-session repair is not password storage

**WHEN** the owner repairs a browser-session connection by logging in through the secure browser
**THEN** the reference implementation MAY capture the browser session state needed for that connector
**AND** it SHALL NOT silently persist the password typed into the provider page as a stored credential.

#### Scenario: Projection is derived

**WHEN** a surface requests connection health
**THEN** the surface receives a projection derived from current conditions rather than independently inferring health from run history.
