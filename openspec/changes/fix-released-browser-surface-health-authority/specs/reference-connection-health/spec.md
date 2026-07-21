## MODIFIED Requirements

### Requirement: Connection Health SHALL Preserve Evidence Before Projection

The reference implementation SHALL model connection health as raw facts normalized into typed conditions and then into a derived projection.

Stored-credential-presence evidence SHALL be connection-binding-scoped: it applies only to a connection that is bound as static-secret. For such a connection the credential-readiness condition SHALL distinguish "no usable stored credential" from "stored credential rejected" as durable connection evidence, derived from credential-presence evidence rather than inferred solely from a transient run reason code; both project as an owner reauth/capture action, with honest, non-conflated reason and copy. A connection bound as a browser session SHALL NOT project a "no usable stored credential" condition from an absent credential row, because it authenticates by owner-authenticated browser session rather than a stored credential. A credential-readiness or session-readiness condition SHALL NOT project the connection healthy or idle merely because a credential-shaped run reason code aged out; it SHALL remain derived from durable evidence until readiness is proven.

A managed browser-surface projection SHALL be lifecycle-scoped. Released or retired surface rows that are no longer backed by current lease evidence SHALL be treated as history, not current authority. A historical surface row SHALL NOT downgrade the connection on its own merely because that row is unhealthy. When current evidence exists for a live lease-backed failure or for a ready live surface, the projection SHALL use that evidence normally; when current browser-surface evidence is absent, the projection SHALL prefer `unknown` over letting retired unhealthy history drive the headline.

#### Scenario: Raw credential failure becomes typed evidence

**WHEN** a connector run observes a source credential rejection
**THEN** the reference implementation records a `CredentialsValid` condition with `status=false`, a stable reason code, safe message, origin, observed timestamp, and remediation metadata.

#### Scenario: No usable credential is honest evidence distinct from rejection

**WHEN** a static-secret-BOUND connection has no usable stored credential (never captured, or superseded) and no evidence that a stored credential was provider-rejected
**THEN** the reference implementation SHALL record a `CredentialsValid` condition whose reason is a distinct "credential required" reason, not the "credential rejected" reason
**AND** the owner-facing message and remediation SHALL describe capturing a credential for the existing connection rather than asserting the source rejected a credential
**AND** the projected owner action SHALL be an owner reauth/capture action for the same connection.

#### Scenario: Browser-session-bound connection does not project credential_required

**WHEN** a connection is bound as a browser session (a browser-session `source_binding.kind`) and has no stored credential row
**AND** the connector also supports a static-secret credential at the connector level
**THEN** the reference implementation SHALL NOT record a "credential required" `CredentialsValid` condition from the absent credential row
**AND** the connection's repair SHALL be surfaced as browser/session repair rather than static-secret credential capture.

#### Scenario: Stored credential rejection becomes durable connection evidence

**WHEN** a connector run that received a connection-scoped stored credential reports a definitive provider credential rejection
**THEN** the reference implementation SHALL mark that stored credential as rejected with a non-secret reason and timestamp
**AND** future run credential recovery SHALL treat that credential as unavailable until explicit owner capture or rotation writes a new active credential.

#### Scenario: Released browser-surface history does not become current authority

**WHEN** a browser surface was previously leased, then released, and later retained only as an unhealthy historical row
**AND** no current lease-backed failure or other current allocator evidence exists for that connector
**THEN** the projected connection health SHALL NOT degrade from that historical surface row alone
**AND** the projection SHALL prefer `unknown` over treating the historical row as current runtime authority.

#### Scenario: Current leased unhealthy browser surface still fails closed

**WHEN** a browser surface is backed by a current non-terminal lease
**AND** the current surface evidence reports that surface as unhealthy
**THEN** the reference implementation SHALL project the managed browser surface as failed
**AND** the connection health SHALL degrade with a remote-surface failure reason.

#### Scenario: Newer ready browser surface outranks older unhealthy history

**WHEN** a connector has both older unhealthy browser-surface history and a newer current ready surface
**THEN** the reference implementation SHALL project the ready current surface as the current browser-surface evidence
**AND** the older unhealthy history SHALL NOT poison the connection headline.

#### Scenario: Browser-surface evidence is absent when only history remains

**WHEN** the connector has only retired or released browser-surface history and no current lease-backed or ready surface evidence
**THEN** the projected browser-surface evidence SHALL be `unknown`
**AND** the connection health SHALL remain `unknown` rather than `degraded`.

### Requirement: Conditions SHALL Be Typed, Current, And Safe

Every condition that can affect owner-facing health SHALL include a stable type, tri-state status, severity, reason, safe message, origin, observed timestamp, sensitivity, and optional remediation.

#### Scenario: Secret redaction

**WHEN** a credential or token-related failure is converted into a condition
**THEN** the condition message and remediation SHALL NOT include secret values and SHALL mark diagnostic sensitivity as `secret_redacted` when source details were redacted.

#### Scenario: Expired condition is not dominant

**WHEN** a condition has expired or is superseded by newer evidence for the same connection generation
**THEN** it SHALL NOT drive the dominant health projection.

### Requirement: Readiness SHALL Be First-Class

The reference implementation SHALL represent credential validity, runtime binding availability, remote surface availability, local exporter availability, and required external tools as readiness conditions when evidence exists.

#### Scenario: Missing runtime binding

**WHEN** a connector requires a browser surface and no usable surface is available
**THEN** the connection health SHALL expose a readiness condition explaining the missing runtime dependency.

#### Scenario: Unknown readiness remains explicit

**WHEN** no probe or failure evidence exists for a readiness dimension
**THEN** the reference implementation SHALL represent that readiness as unknown rather than guessing healthy or unhealthy.
