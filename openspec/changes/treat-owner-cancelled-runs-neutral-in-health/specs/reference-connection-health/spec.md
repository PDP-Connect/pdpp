## MODIFIED Requirements

### Requirement: Connection Health SHALL Preserve Evidence Before Projection

The reference implementation SHALL model connection health as raw facts normalized into typed conditions and then into a derived projection.

Stored-credential-presence evidence SHALL be connection-binding-scoped: it applies only to a connection that is bound as static-secret. For such a connection the credential-readiness condition SHALL distinguish "no usable stored credential" from "stored credential rejected" as durable connection evidence, derived from credential-presence evidence rather than inferred solely from a transient run reason code; both project as an owner reauth/capture action, with honest, non-conflated reason and copy. A connection bound as a browser session SHALL NOT project a "no usable stored credential" condition from an absent credential row, because it authenticates by owner-authenticated browser session rather than a stored credential. A credential-readiness or session-readiness condition SHALL NOT project the connection healthy or idle merely because a credential-shaped run reason code aged out; it SHALL remain derived from durable evidence until readiness is proven.

Owner-cancelled terminal runs SHALL remain visible in run history and timelines, but SHALL NOT by themselves satisfy connector-failure health conditions, terminal coverage-gap conditions, or maintainer-code-fix required actions. The projection SHALL treat only runtime owner-cancel terminal reasons, such as `owner_cancelled` and `owner_cancel_forced`, as owner-cancelled. Connector-declared cancellation that carries connector/source failure evidence SHALL remain classified from that evidence. When the latest run is owner-cancelled and an earlier successful run exists, coverage and stream collection-report projection SHALL use the earlier successful run as the coverage fact anchor rather than dropping the connection to unmeasured coverage solely because the latest run was cancelled by the owner.

#### Scenario: Owner-cancelled run is not a connector failure

**WHEN** the latest run for a connection is terminal with `status=cancelled`
**AND** its terminal reason is `owner_cancelled` or `owner_cancel_forced`
**THEN** the connection health projection SHALL NOT record `CollectionSucceeded=false` solely from that run
**AND** it SHALL NOT project a maintainer `code_fix` required action solely from that run
**AND** the run SHALL remain visible as cancelled in run history and timelines.

#### Scenario: Owner-cancelled run preserves prior coverage

**WHEN** the latest run for a connection is terminal with owner-cancel reason `owner_cancelled` or `owner_cancel_forced`
**AND** an earlier successful run carries coverage or stream collection-report facts
**THEN** the connection health projection SHALL use the earlier successful run as the coverage fact anchor
**AND** stream rows SHALL continue to project from the successful run's committed collection facts.

#### Scenario: Connector failure remains a failure

**WHEN** the latest run for a connection is terminal with a connector failure reason such as `connector_exit_without_done`
**THEN** the connection health projection SHALL continue to classify the failed run as connector-failure evidence.
