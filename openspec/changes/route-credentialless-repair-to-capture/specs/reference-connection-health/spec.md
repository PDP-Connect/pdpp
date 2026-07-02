## MODIFIED Requirements

### Requirement: Connection Health SHALL Preserve Evidence Before Projection

The reference implementation SHALL model connection health as raw facts normalized into typed conditions and then into a derived projection.

The credential-readiness condition SHALL distinguish "no usable stored credential" from "stored credential rejected" as durable connection evidence, derived from credential-presence evidence for the connection rather than inferred solely from a transient run reason code. Both project as an owner reauth/capture action, but with honest, non-conflated reason and copy. A credential-readiness or session-readiness condition SHALL NOT project the connection healthy or idle merely because a credential-shaped run reason code aged out; it SHALL remain derived from durable credential-presence and session-readiness evidence until readiness is proven.

#### Scenario: Raw credential failure becomes typed evidence

**WHEN** a connector run observes a source credential rejection
**THEN** the reference implementation records a `CredentialsValid` condition with `status=false`, a stable reason code, safe message, origin, observed timestamp, and remediation metadata.

#### Scenario: No usable credential is honest evidence distinct from rejection

**WHEN** a static-secret-capable connection has no usable stored credential (never captured, or superseded) and no evidence that a stored credential was provider-rejected
**THEN** the reference implementation SHALL record a `CredentialsValid` condition whose reason is a distinct "credential required" reason, not the "credential rejected" reason
**AND** the owner-facing message and remediation SHALL describe capturing a credential for the existing connection rather than asserting the source rejected a credential
**AND** the projected owner action SHALL be an owner reauth/capture action for the same connection.

#### Scenario: Stored credential rejection becomes durable connection evidence

**WHEN** a connector run that received a connection-scoped stored credential reports a definitive provider credential rejection
**THEN** the reference implementation SHALL mark that stored credential as rejected with a non-secret reason and timestamp
**AND** future run credential recovery SHALL treat that credential as unavailable until explicit owner capture or rotation writes a new active credential.

#### Scenario: Unavailable credential evidence does not fabricate a repair state

**WHEN** the credential-presence evidence cannot be read (for example a credential-store read fails) rather than being read as an authoritative "no stored credential" result
**THEN** the reference implementation SHALL treat the credential-presence evidence as unavailable and fall back to its prior run-reason-derived credential projection
**AND** it SHALL NOT project `credential_required` or an owner reconnect/capture action solely from the unavailable read.

#### Scenario: Credential repair state does not heal by age alone

**WHEN** the most recent credential-shaped run reason code for a connection ages out or is superseded but no proof of credential/session readiness exists
**THEN** the connection SHALL NOT be projected healthy or idle on the credential/session axis
**AND** it SHALL continue to project the unresolved credential-required or credential-rejected condition until a successful run or an active captured credential proves readiness.

#### Scenario: Scheduled run defers rejected credential recovery

**WHEN** a scheduled run cannot recover a connection-scoped stored credential because the credential is missing, revoked, or provider-rejected
**THEN** the reference implementation SHALL NOT spawn the connector with a stale credential or deployment-wide fallback secret
**AND** it SHALL record a skipped owner-repair state instead of a failed connector run
**AND** later automatic ticks SHALL NOT keep retrying the same unavailable credential while the connection remains marked as needing owner repair.

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
