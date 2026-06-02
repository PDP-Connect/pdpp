## ADDED Requirements

### Requirement: Chase current activity stays separate from posted transactions
The reference Chase connector SHALL expose UI-visible pending or current-cycle account activity through a separate `current_activity` stream rather than by changing the posted-only `transactions` stream. The `transactions` stream SHALL remain QFX/Web Connect derived, posted-only, append-only, and keyed by Chase QFX `FITID`.

#### Scenario: Chase UI shows activity that QFX does not export
- **WHEN** Chase's account activity UI shows pending or current-cycle rows that are not present in a QFX/Web Connect export
- **THEN** the reference connector SHALL NOT emit those UI-only rows into `transactions`
- **AND** it SHALL emit supported UI-visible rows into `current_activity` when that stream is requested and the live UI surface can be parsed

#### Scenario: Pending activity is collected
- **WHEN** the connector observes a pending Chase activity row
- **THEN** the row SHALL be emitted only to `current_activity`
- **AND** the emitted record SHALL identify its status as pending rather than settled or posted

#### Scenario: Posted QFX transaction identity remains authoritative
- **WHEN** a posted Chase transaction appears in QFX output with a `FITID`
- **THEN** the connector SHALL continue to key the `transactions` record from `account_id|fitid`
- **AND** it SHALL NOT merge UI-derived `current_activity` identity into the `transactions` primary key

### Requirement: Chase current activity is modeled as mutable visibility data
The `current_activity` stream SHALL use `mutable_state` semantics and SHALL be described as UI-visible freshness data rather than as a settled accounting ledger.

#### Scenario: Chase exposes a stable UI transaction identifier
- **WHEN** a Chase current activity row includes a source-provided UI transaction identifier
- **THEN** the connector SHALL prefer that identifier when building the `current_activity` primary key

#### Scenario: Chase exposes no stable UI transaction identifier
- **WHEN** a Chase current activity row has no source-provided UI transaction identifier
- **THEN** the connector SHALL use a deterministic fallback key scoped to the account and visible row attributes
- **AND** it SHALL NOT claim that the fallback key preserves identity across pending-to-posted transitions

#### Scenario: Consumers request both Chase streams
- **WHEN** a client requests both `transactions` and `current_activity`
- **THEN** the stream metadata and schemas SHALL make clear that `transactions` is the posted QFX ledger and `current_activity` is volatile UI-visible activity
