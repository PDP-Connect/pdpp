## ADDED Requirements

### Requirement: External-loss successor receipts SHALL preserve causal profile provenance

The reference implementation SHALL record every managed browser-process replacement in an append-only, non-secret, reference-owned ledger. A receipt SHALL be scoped by connection identity, optional surface subject, and profile key. An observed `external_or_host_loss` SHALL remain `started` until a successor readiness probe observes a generation hash in that same scope or a successor allocation attempt truthfully terminalizes it. A successor whose surface ID differs from the lost surface SHALL still correlate by that scope. The reference SHALL persist the allocator's stable profile bind path with the corresponding browser-surface projection.

`profile_key`, `profile_dir`, and `profile_volume` SHALL be an atomic compatibility boundary during surface upsert. When the stored and incoming profile keys are equal, a partial upsert MAY retain omitted profile directory and volume fields. When the profile key changes, the implementation SHALL clear both persisted provenance fields unless the incoming row supplies both a replacement profile directory and volume; it SHALL NOT cross-bind a new profile key to the prior profile location.

#### Scenario: External loss completes only after a changed-surface successor is observed

- **WHEN** a managed surface is lost and its successor receives a different surface ID
- **AND** a readiness probe observes the successor browser generation in the same connection, surface-subject, and profile-key scope
- **THEN** the original external-loss receipt SHALL complete with that successor generation hash
- **AND** the persisted surface projection SHALL retain the allocator profile bind path.

#### Scenario: Historical reconciliation cannot mint a new external-loss boundary

- **WHEN** boot or periodic reconciliation evicts a persisted managed surface that was already `unhealthy` or `stopping`
- **THEN** the implementation SHALL persist its unhealthy projection without appending a new `external_or_host_loss` receipt
- **AND** it SHALL preserve any prior failed scoped successor as selectable system-runtime evidence.
- **WHEN** reconciliation evicts a managed surface that was `ready` immediately before the allocator loss observation
- **THEN** it SHALL append exactly one scoped `external_or_host_loss` receipt
- **AND** a same-profile successor readiness observation SHALL complete that receipt.

#### Scenario: Profile-key replacement cannot inherit prior provenance

- **WHEN** a surface ID is upserted with a different profile key and no replacement directory/volume pair
- **THEN** its persisted `profile_dir` and `profile_volume` SHALL both be absent
- **WHEN** that changed key is upserted with an explicit replacement directory and volume
- **THEN** both replacement provenance fields SHALL persist together.

#### Scenario: A failed scoped successor remains operational evidence

- **WHEN** an external-loss receipt is unresolved
- **AND** an allocator ensure attempt for the same connection, subject, and profile key fails
- **THEN** that receipt SHALL terminalize as failed
- **AND** it SHALL remain available to system-actionable runtime health projection rather than being selected as a current browser generation or relabeled as provider credential rejection.
