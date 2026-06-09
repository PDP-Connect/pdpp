## ADDED Requirements

### Requirement: Canonical retained-history compaction SHALL be opt-in and convergence-preserving

The reference implementation SHALL support an explicit canonical retained-history compaction mode for streams whose compaction policy declares a semantic immutable change model and a current-row representative policy.

Canonical compaction SHALL use the same canonical record fingerprint definition as the connector runtime's no-op emit suppression for the same `(connector_id, stream)`. The canonical fingerprint SHALL remove only the policy-declared non-versioning fields and SHALL preserve real record-field changes as retained version boundaries.

Canonical compaction SHALL keep the current `records.version` row for the current same-fingerprint run, SHALL preserve tombstones and resurrection boundaries, SHALL preserve every distinct canonical fingerprint boundary, SHALL NOT renumber surviving versions, and SHALL NOT apply to streams without an explicit canonical eligibility policy.

Default historical compaction SHALL remain audit mode. Audit mode SHALL keep its existing conservative retention behavior unless canonical mode is requested and the stream is eligible.

#### Scenario: Ineligible stream fails closed

- **WHEN** an operator requests canonical compaction for a stream without `changeModel: "immutable_semantic"` and `representativePolicy: "current"`
- **THEN** the compaction tool refuses the canonical apply instead of deleting retained versions

#### Scenario: Immutable duplicate versions converge to the current semantic survivor

- **WHEN** an eligible immutable stream has multiple non-tombstone retained versions for the same key with the same canonical fingerprint
- **THEN** canonical compaction retains the current `records.version` row for that same-fingerprint run and removes the redundant retained history rows

#### Scenario: Real version boundaries survive

- **WHEN** an eligible immutable stream has retained versions for the same key with distinct canonical fingerprints
- **THEN** canonical compaction retains a survivor for each distinct canonical fingerprint boundary

#### Scenario: Tombstones and resurrections survive

- **WHEN** an eligible stream history contains a tombstone or a non-tombstone resurrection after a tombstone
- **THEN** canonical compaction retains the tombstone and the resurrection boundary

#### Scenario: Default compaction remains conservative

- **WHEN** the operator runs the compaction tool without canonical mode
- **THEN** the tool uses audit-mode retention rules and does not apply canonical-mode deletion rules

#### Scenario: Copied database validates destructive apply

- **WHEN** a stream is proposed for live canonical apply
- **THEN** the operator first validates the canonical dry-run and apply path on a copied or narrowed database and confirms no current row is orphaned before approving live mutation
