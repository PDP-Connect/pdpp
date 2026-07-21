## ADDED Requirements

### Requirement: Recovery-only runs SHALL NOT produce or propagate inventory facts for any stream

A `recovery_only` run only drains pending detail gaps; by definition it
performs no forward/list inventory pass against the manifest's stream scope.
The runtime SHALL NOT emit a per-stream inventory fact
(`checkpoint`/`considered`/`covered`/`collected`) for ANY stream on a
`recovery_only` run's terminal event — not even a stream the run served or
recovered a detail gap for, since detail-gap hydration is not a list-pass
measurement and proves nothing about that stream's inventory state.
Downstream evidence folds (`connector-summary-read-model.ts`,
`ref-control.ts`'s collection-report classifying-run selection) SHALL
therefore have nothing to fold from a `recovery_only` terminal event and
SHALL leave every stream's stored evidence — both its value and its
provenance (`run_id`, `evidence_as_of`) — completely unchanged by it.

Preserving a stream's prior inventory value while reassigning its
provenance to the recovery-only run is also prohibited: that would
misrepresent how recently the value was actually measured. Inventory
evidence and its provenance travel together, or not at all.

Current gap/recovery progress for a stream (e.g. a pending-gap count
reaching zero after a successful drain) is a separate evidence channel,
owned by the durable detail-gap store and surfaced via live
`pendingDetailGaps`/`terminalDetailGapsByStream` reads in the
collection-report projection — never by this terminal-fact block.

#### Scenario: A recovery-only run's terminal event carries no inventory fact for any stream

- **GIVEN** a connector instance with prior measured evidence for streams A
  and B (`coverage_condition: complete`, `checkpoint: committed`)
- **AND** stream A has pending detail gaps, stream B does not
- **WHEN** a `recovery_only` run executes, serves and recovers all of stream
  A's pending detail gaps, and terminates successfully
- **THEN** the run's terminal event SHALL carry no `collection_facts` entry
  for stream A or stream B
- **AND** the connector summary's stored evidence for BOTH streams SHALL
  remain the prior measured evidence, unchanged in value and provenance.

#### Scenario: A recovery-only run's classifying-run selection falls through to stored evidence for every stream, with original provenance

- **GIVEN** the newest terminal run for a connector instance is
  `recovery_only`
- **WHEN** the collection report is projected for any stream
- **THEN** the classifying-run selection SHALL fall through to the stored
  (durable, prior-run) fact for that stream
- **AND** the resulting evidence's `run_id`/`evidence_as_of` SHALL be the
  prior run's own provenance, never the recovery-only run's.

#### Scenario: Current gap-drain progress is visible independently of the terminal-fact block

- **GIVEN** a connector instance with prior measured evidence for stream A
  and one pending detail gap for stream A
- **WHEN** a `recovery_only` run recovers that pending gap and terminates
  successfully
- **THEN** the collection report for stream A SHALL reflect zero pending
  gaps (read from the live detail-gap store)
- **AND** stream A's inventory evidence (`checkpoint`/`considered`/
  `covered`) and provenance SHALL be unchanged from the prior measured run.

#### Scenario: A genuine full-scope run still replaces stored evidence normally

- **GIVEN** a connector instance whose most recent terminal run was
  `recovery_only`
- **WHEN** a later, non-`recovery_only` run performs a genuine forward/list
  pass and terminates with a fresh per-stream fact
- **THEN** that fact SHALL replace the stored evidence and provenance for
  its streams exactly as it would have before recovery-only runs existed
- **AND** this replacement SHALL NOT be affected by the intervening
  recovery-only run.

#### Scenario: Run scope is a persisted, explicit fact

- **WHEN** a run's terminal spine event (`run.completed`, `run.failed`,
  `run.cancelled`, `run.browser_surface_failed`) is emitted
- **THEN** the event's data payload SHALL include a `recovery_only` boolean
  sourced from the run's actual `START.recovery_only` value
- **AND** this fact SHALL be durable and inspectable, independent of
  whether any fold currently keys off it.
