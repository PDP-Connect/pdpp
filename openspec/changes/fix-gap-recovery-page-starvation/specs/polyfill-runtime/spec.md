## ADDED Requirements

### Requirement: The Gmail connector SHALL acknowledge recovery of a served attachment detail gap

When the runtime serves the Gmail connector one or more valid pending
`attachments` detail gaps at START, those served gaps SHALL become the
connector's current bounded work unit for this run. The connector SHALL
recover them before advancing the ordinary historical attachment crawl, and
the historical crawl/cursor advancement SHALL resume only when no valid
served attachment gaps are handed to the connector. A served gap whose
attachment is not reached this run, or whose attachment hydration fails,
SHALL NOT be acknowledged as recovered — it SHALL remain on the ordinary
`DETAIL_GAP` re-emit path so the durable row stays pending.

#### Scenario: A served attachment gap is recovered when its attachment hydrates successfully

- **WHEN** the runtime serves a pending `attachments` gap identifying a
  specific attachment (by attachment id, and message id / part index when
  present)
- **AND** the connector successfully hydrates and emits that exact attachment
  during the run
- **THEN** the connector SHALL emit `DETAIL_GAP_RECOVERED` with the served
  `gap_id`.

#### Scenario: Served attachment gaps preempt historical backfill while present

- **WHEN** the runtime serves one or more valid pending `attachments` gaps at
  START
- **AND** the connector probes those gaps in stable START order by Gmail
  `X-GM-MSGID` using `search({ emailId })`, caching same-message lookups and
  stopping after at most 32 unique Gmail metadata lookups
- **AND** it emits bounded non-secret `PROGRESS` immediately after each
  admitted candidate is accepted for hydration, before `hydrateAttachment`
  starts, and again after the record emission settles
- **AND** it hydrates each admitted candidate immediately, admitting a
  positional byte-budget prefix that may include one oversized candidate
- **THEN** the connector SHALL treat the served-gap page as the current
  bounded work unit for the run
- **AND** it SHALL still attempt the admitted gaps now
- **AND** it SHALL emit `DETAIL_GAP_RECOVERED` for each admitted gap whose
  attachment hydrates successfully
- **AND** it SHALL leave unadmitted served gaps untouched
- **AND** the ordinary historical attachment crawl/cursor advancement SHALL
  resume only on runs where no valid served attachment gaps are handed to the
  connector
- **AND** if the historical attachment-backfill cursor is already complete,
  that completed-cursor state is simply one consequence of this rule
- **AND** the connector SHALL NOT require a mailbox-wide scan to do so

#### Scenario: A near-miss locator is never recovered

- **WHEN** a served gap's locator identifies a different part index or
  message id than an attachment the connector emits
- **THEN** the connector SHALL NOT emit `DETAIL_GAP_RECOVERED` for that served
  gap.

#### Scenario: An unreached served gap is not recovered

- **WHEN** a served attachment gap's message is not visited during the run
  (outside the incremental or backfill scan range)
- **THEN** the connector SHALL NOT emit `DETAIL_GAP_RECOVERED` for it
- **AND** the durable row SHALL remain pending for a later run.

#### Scenario: A served gap whose attachment fails hydration again is never recovered

- **WHEN** the runtime serves a pending `attachments` gap
- **AND** the connector attempts the matching attachment during the run but
  hydration fails again (`hydration_status: "failed"`)
- **THEN** the connector SHALL NOT emit `DETAIL_GAP_RECOVERED` for that gap
- **AND** the failed attachment SHALL land on the ordinary `DETAIL_GAP`
  re-emit path (a retryable gap key), so the durable row remains pending and
  eligible for a later recovery attempt rather than being silently abandoned.

#### Scenario: A too_large attachment is never the subject of a recovery acknowledgement

- **WHEN** an attachment hydration resolves as `too_large` (a permanent,
  by-policy skip credited directly via the coverage `optional_skip_keys`)
- **THEN** the connector SHALL NOT emit `DETAIL_GAP_RECOVERED` for it, because
  a `too_large` outcome is never the subject of a durable `DETAIL_GAP` in the
  first place — only a `failed` hydration ever creates one
- **AND** any pre-existing pending gap for that record (from an earlier
  `failed` attempt, before a size cap began applying) is already satisfied by
  the coverage skip and is left to age or terminalize on its own; it is
  neither recovered nor required to be.

#### Scenario: Recovery-only Gmail runs stop after served attachment recovery

- **WHEN** the START message has `recovery_only: true`
- **AND** the runtime serves one or more valid pending `attachments` detail
  gaps
- **THEN** the Gmail connector SHALL recover the served attachment gaps and
  return before fetching labels, deriving threads, collecting new messages,
  running the message body pass, or applying flag/label delta work
- **AND** if no valid served attachment gaps are handed to the connector, it
  SHALL return without entering the ordinary Gmail walk.

### Requirement: A pending attachment detail backlog SHALL activate historical attachment backfill

The Gmail connector SHALL treat a non-empty pending `attachments` detail-gap
backlog (served at START) as sufficient reason to run the historical
attachment-backfill pass, independent of the explicit `streamsToBackfill`
flag. This closes the gap where a durable attachment backlog on
already-scanned messages would otherwise never be revisited by the ordinary
incremental UID walk.

#### Scenario: Pending attachment gaps trigger backfill without the explicit flag

- **WHEN** the runtime serves the connector one or more pending `attachments`
  detail gaps at START
- **AND** `streamsToBackfill` does not include `attachments`
- **THEN** the connector SHALL still run the historical attachment-backfill
  pass for the current run.

### Requirement: Gmail served attachment recovery SHALL emit one aggregate-only terminal outcome

When Gmail processes valid served attachment detail gaps, it SHALL enrich its
existing final served-recovery `PROGRESS` summary with exactly one
`attachment_recovery_outcome` object. The object SHALL contain only the fixed
discriminator and non-negative integer aggregates `served`,
`metadata_lookups`, `attempted`, `admitted`, `admitted_bytes`, `recovered`,
`lookup_miss`, `hydration_failed`, and `run_cap_deferred`. It SHALL NOT
contain identifiers, locators, provider identities, content, or error text.
This evidence SHALL NOT alter the recovery byte budget, lookup cap, scheduler,
governor, retry behavior, or user-facing progress copy.

#### Scenario: One terminal aggregate distinguishes the served recovery outcomes

- **WHEN** Gmail completes a served attachment recovery pass
- **THEN** it SHALL emit its existing terminal served-recovery `PROGRESS`
  summary with exact aggregate counts for the served page
- **AND** `run_cap_deferred` SHALL count every served gap left unadmitted when
  the byte budget stops the ordered lane, including an untouched suffix
- **AND** a count near the byte budget with `run_cap_deferred > 0` SHALL be
  observable separately from the metadata lookup count, lookup misses, and
  hydration failures.
