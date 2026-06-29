## MODIFIED Requirements

### Requirement: Reference-only surfaces are explicit

Debugging, replay, trace, projection, and operator-control surfaces that are useful for the reference implementation but are not part of core PDPP SHALL be explicitly marked as reference-only.

Retained-size dataset summary reads MAY run a bounded auto-reconcile pass when the retained-size projection metadata is stale or failed. That pass SHALL use the existing dirty-row retained-size reconcile path and SHALL NOT run a full retained-size rebuild as part of an ordinary read. If reconcile succeeds, the read SHALL return the repaired projection metadata. If reconcile fails, the read SHALL return last-known projection data with stale or failed metadata preserved so the owner can see that the numbers may lag and later maintenance can retry.

Read-path reconcile failure SHALL be throttled by an in-process cooldown or an equivalent bounded retry guard. A persistent reconcile failure SHALL NOT cause every dashboard read to run another reconcile attempt.

Owner-facing dashboard copy for stale or failed projection metadata SHALL describe the freshness state concisely and SHALL NOT display raw internal maintenance reasons, storage errors, SQL text, connection identifiers, secrets, tokens, or operator-only diagnostic strings.

#### Scenario: Stale retained-size projection is repaired on read

- **WHEN** a reference-only dataset summary read sees retained-size projection metadata marked stale and the dirty-row reconcile pass can repair the derived rows
- **THEN** the read SHALL run the bounded retained-size reconcile pass
- **AND** it SHALL return fresh projection metadata without requiring a full retained-size rebuild

#### Scenario: Reconcile failure stays visible and retryable

- **WHEN** a reference-only dataset summary read attempts retained-size reconcile and the reconcile fails
- **THEN** the read SHALL preserve stale or failed projection metadata
- **AND** it SHALL NOT clear dirty state or claim the projection is fresh
- **AND** it SHALL NOT expose raw internal failure text through owner-facing dashboard hero copy

#### Scenario: Reconcile failure is not retried on every read

- **WHEN** a reference-only dataset summary read attempts retained-size reconcile and the reconcile fails
- **THEN** an immediate subsequent dataset summary read in the same process SHALL return the existing stale or failed projection without invoking another reconcile attempt
- **AND** a later read MAY retry after the bounded retry guard allows another attempt

#### Scenario: Global-only dirty metadata does not force a full rebuild

- **WHEN** retained-size global metadata is dirty but stream and connection rows are clean
- **THEN** a dataset summary read MAY reconcile the global metadata from clean connection rows
- **AND** it SHALL NOT rebuild every retained-size row from canonical records as part of that read
