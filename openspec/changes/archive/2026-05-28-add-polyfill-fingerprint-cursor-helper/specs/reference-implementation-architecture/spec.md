## ADDED Requirements

### Requirement: Polyfill connector authoring layer SHALL provide a reusable per-record fingerprint cursor

The reference polyfill-connectors package SHALL expose a shared primitive that connector authors can adopt to suppress no-op record emits on streams whose source re-derives the full record each run (archive rebuilds, full-collection refetches, file-mtime triggers, aggregate re-derivation). The primitive SHALL:

- compute a stable per-record fingerprint over the emitted record fields with a caller-declared exclusion list for run-clock fields;
- accept the prior STATE cursor and tolerantly decode the prior fingerprint map (legacy cursor shapes, missing fields, malformed entries SHALL NOT throw and SHALL produce an empty map for those entries);
- answer whether a given record's fingerprint has moved relative to the prior cursor;
- always carry forward the fingerprint of skipped records so the next STATE write does not silently drop them;
- track ids observed in the current run so that, on full-scan streams, fingerprints for ids absent from the current run can be pruned at run boundary;
- expose the prior fingerprint value so a connector with derived-field-preservation policy can read it without breaking the encapsulation.

Adoption SHALL be opt-in. Connectors whose source provides a strong incremental cursor SHALL NOT be forced to use the primitive. The primitive SHALL NOT modify the public RECORD or STATE wire shape; the fingerprint map is carried inside the connector's STATE cursor, which is already opaque to the runtime.

The runtime byte-equivalence no-op check at the storage layer SHALL remain in force as a backstop. The authoring-layer primitive SHALL NOT be relied on as the sole churn-prevention layer.

#### Scenario: Identical second run emits no records

- **WHEN** a connector adopts the primitive on a stream and the source state has not moved between runs
- **THEN** the second run SHALL emit zero RECORD messages for that stream
- **AND** the STATE cursor for that stream SHALL still carry the full per-record fingerprint map forward

#### Scenario: Run-clock field does not cause a re-emit

- **WHEN** a record's fingerprint excludes a run-clock field (e.g. `fetched_at`) and only that field advances between runs
- **THEN** `shouldEmit` SHALL return `false`
- **AND** the prior fingerprint SHALL be preserved in the next STATE write

#### Scenario: Source mutation re-emits exactly that record

- **WHEN** the source value of a single record changes between runs
- **THEN** `shouldEmit` SHALL return `true` for that record and `false` for unchanged records
- **AND** only the changed record SHALL appear in the run's RECORD output

#### Scenario: Source deletion is pruned at run boundary

- **WHEN** a record present in the prior cursor is not observed on a requested full-scan stream this run
- **THEN** the prune operation SHALL remove that id from the next STATE cursor
- **AND** a later re-add of the same id SHALL re-emit the record rather than be silently skipped as a no-op

#### Scenario: Legacy or malformed prior state is tolerated

- **WHEN** the prior STATE cursor has no `fingerprints` field, has a malformed shape, or contains entries with the wrong value type
- **THEN** the primitive SHALL produce an empty prior map for the malformed portion
- **AND** the run SHALL proceed without throwing and re-emit every record as new
