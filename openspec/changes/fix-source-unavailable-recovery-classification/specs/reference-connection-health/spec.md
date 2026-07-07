## MODIFIED Requirements

### Requirement: Connection Health SHALL Preserve Evidence Before Projection

The reference implementation SHALL model connection health as raw facts normalized into typed conditions and then into a derived projection.

Stored-credential-presence evidence SHALL be connection-binding-scoped: it applies only to a connection that is bound as static-secret. For such a connection the credential-readiness condition SHALL distinguish "no usable stored credential" from "stored credential rejected" as durable connection evidence, derived from credential-presence evidence rather than inferred solely from a transient run reason code; both project as an owner reauth/capture action, with non-conflated reason and copy. A connection bound as a browser session SHALL NOT project a "no usable stored credential" condition from an absent credential row, because it authenticates by owner-authenticated browser session rather than a stored credential. A credential-readiness or session-readiness condition SHALL NOT project the connection healthy or idle merely because a credential-shaped run reason code aged out; it SHALL remain derived from durable evidence until readiness is proven.

Generic terminal run failures MAY be promoted to credential repair when the durable known-gap evidence contains a definitive auth failure, such as credential rejection or 401/403 session failure. The projection SHALL NOT promote a generic failure to credential repair when the known-gap evidence states `source_unavailable`; source availability evidence SHALL remain source/run evidence unless another current fact proves credential rejection or missing credential.

Known-gap evidence that states `source_unavailable` SHALL be classified as a retryable source condition for coverage rollup, even when historical runtime fields marked the gap actionable or non-retryable. The projection SHALL NOT surface such legacy evidence as terminal connector-code coverage unless another current fact proves a non-retryable connector defect.

#### Scenario: Raw credential failure becomes typed evidence

**WHEN** a connector run observes a source credential rejection
**THEN** the reference implementation records a `CredentialsValid` condition with `status=false`, a stable reason code, safe message, origin, observed timestamp, and remediation metadata.

#### Scenario: Source unavailable does not become credential repair

**WHEN** a connector run has a generic terminal failure
**AND** a degrading known gap carries `source_unavailable`
**THEN** the reference implementation SHALL NOT create a `CredentialsValid=false` condition solely from that known gap
**AND** it SHALL NOT route the owner to credential reconnect unless separate current credential evidence proves missing or rejected credentials.

#### Scenario: Historical source unavailable reads as retryable

**WHEN** a persisted connector run has a generic terminal failure
**AND** a degrading known gap carries `source_unavailable`
**AND** historical gap fields mark the gap actionable or non-retryable
**THEN** the connection health coverage axis SHALL classify the gap as retryable
**AND** it SHALL NOT surface the gap as a terminal connector-code fix.
