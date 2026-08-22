## MODIFIED Requirements

### Requirement: Checkpoint Persistence Across a Controller Restart

The runtime SHALL continue to fail closed by default: a run that ends in a
protocol violation, a connector-reported failure, an owner cancellation, or any
process exit without a valid DONE SHALL persist no staged STATE, except as
provided below.

As a narrow exception, the runtime MAY persist a staged checkpoint at the time
its `STATE` message is handled, so that a run interrupted by a controller
restart resumes from that checkpoint rather than from zero. The runtime SHALL
apply the exception to a checkpoint stream ONLY when all of the following hold:

1. No in-scope stream declares that checkpoint stream as a detail parent, via
   the manifest's `state_stream` or `parent_streams` declaration. Eligibility
   SHALL be derived from the manifest alone and SHALL be decidable before the
   connector is spawned. The runtime SHALL NOT accept a connector-supplied
   claim of eligibility.
2. Every record the cursor covers is already durably ingested at the moment the
   checkpoint is persisted.
3. The connector has reported no gap for that stream in the current run.

A checkpoint stream that fails any condition SHALL remain staged and SHALL
commit only under the existing successful-DONE rule, so that a DONE-time
`DETAIL_COVERAGE` verdict can never be bypassed.

The runtime SHALL make an eagerly persisted checkpoint distinguishable from one
that is merely staged, so a reader of the run timeline can tell which
checkpoints survive a restart.

A run ended by a controller restart SHALL be reported with a terminal
disposition distinct from `failed`, reflecting that its outcome was never
observed rather than observed to be bad.

#### Scenario: An interrupted run resumes from its last eligible checkpoint

- **WHEN** a connector emits records for an eligible checkpoint stream, then a
  `STATE` message for that stream, and the process then exits without a valid
  DONE
- **THEN** the runtime SHALL have persisted that stream's cursor durably
- **AND** the next run SHALL resume from that cursor rather than from zero
- **AND** the next run SHALL NOT re-fetch records committed before that cursor

#### Scenario: A detail parent's checkpoint never commits early

- **WHEN** an in-scope stream declares a checkpoint stream as its detail parent
- **AND** the connector emits a `STATE` message for that parent stream
- **THEN** the runtime SHALL NOT persist that parent's cursor at `STATE` time
- **AND** the parent's cursor SHALL commit only after a successful DONE whose
  `DETAIL_COVERAGE` accounting is complete

#### Scenario: Fail-closed defaults are unchanged

- **WHEN** a run terminates with a connector-reported failure, an owner
  cancellation, an invalid terminal count or exit code, or a protocol violation
- **THEN** the runtime SHALL persist no staged STATE beyond the existing
  certified stream-scoped failure exception
- **AND** an ineligible checkpoint stream SHALL persist nothing in every such
  case

#### Scenario: Re-collection after a restart cannot duplicate records

- **WHEN** a run interrupted by a restart re-collects a range whose records were
  already durably ingested
- **THEN** ingest SHALL upsert on the existing record identity rather than
  create duplicates
- **AND** the observable cost of an interrupted run SHALL be repeated work only,
  never lost or duplicated records
