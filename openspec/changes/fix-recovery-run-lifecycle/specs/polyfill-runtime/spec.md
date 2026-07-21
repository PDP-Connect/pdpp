## ADDED Requirements

### Requirement: Gmail historical attachment backfill SHALL size its work unit from known byte cost, not a fixed UID count

Gmail's historical attachment backfill pass SHALL bound each run's unit of
completed work by a byte budget derived from attachment `size_bytes` (from
`BODYSTRUCTURE`, known before download), mirroring the
byte-budget-clamp-and-trim-to-budget-with-at-least-one-entry pattern already
used by the connector-neutral detail gap paging module — implemented as
Gmail-local policy, without adding Gmail-specific fields to the generic
module. Unlike the generic detail-gap page, which has no per-row size hint
and needs a learned observed-average estimate, Gmail's per-UID cost is
knowable up front; no cross-page-learning (EWMA) mechanism is required or
implemented, since the historical backfill pass runs at most once per run.
The durable `backfilled_through_uid` cursor SHALL advance only after every
attachment in a page has been attempted to completion (hydrated, failed, or
too-large); an interrupted page SHALL replay unchanged from the last
committed cursor.

#### Scenario: A page is sized by cumulative known attachment byte cost, not a fixed UID count

- **WHEN** historical attachment backfill selects the next page of UIDs to
  process
- **THEN** the page SHALL be sized so the cumulative attachment byte cost of
  the UIDs it contains approximates a byte budget
- **AND** SHALL NOT be sized purely by a fixed count of UIDs regardless of
  attachment size.

#### Scenario: A UID with no attachments costs nothing

- **WHEN** a candidate UID's BODYSTRUCTURE contains zero attachment leaves
- **THEN** that UID's cost for page-size planning SHALL be zero
- **AND** SHALL NOT be charged the unknown-attachment-size fallback (an
  ordinary window of plain messages with no attachments MUST NOT be
  starved to a handful of admitted UIDs per page).

#### Scenario: A UID with a mix of known and unknown attachment sizes charges the fallback per unknown attachment

- **WHEN** a candidate UID has multiple attachments, some with a known
  `size_bytes` and some without
- **THEN** the UID's cost SHALL be the sum of the known sizes plus one fixed
  conservative fallback cost per attachment whose size is unavailable
- **AND** an unknown-size attachment SHALL NOT be dropped from the sum (which
  would underestimate the UID's true cost).

#### Scenario: A single oversized attachment still forms a complete page

- **WHEN** the next unprocessed candidate's cost alone exceeds the page byte
  budget
- **THEN** that candidate SHALL still be admitted to its own page rather
  than blocking all backfill progress
- **AND** the page SHALL be considered complete once that candidate's
  attachments are attempted to completion.

#### Scenario: The admitted page is derived positionally from UID-sorted candidates, never by UID comparison

- **WHEN** probe metadata for the coarse UID range is collected
- **THEN** the candidates SHALL be sorted ascending by UID before trimming to
  the byte budget (IMAP fetch responses are not guaranteed to arrive in UID
  order)
- **AND** the admitted page SHALL be derived as a positional prefix of the
  sorted, trimmed candidates
- **AND** SHALL NOT be derived by comparing UID values against the trimmed
  page's maximum UID, which would silently admit the entire coarse range if
  a high UID were returned out of order.

#### Scenario: The durable cursor advances only after a full page completes

- **WHEN** a historical attachment backfill page is interrupted before every
  attachment in it has been attempted to completion
- **THEN** the `backfilled_through_uid` cursor SHALL remain at its last
  committed value
- **AND** the next run SHALL replay the same unfinished window rather than
  skipping ahead.

#### Scenario: No new wall-clock kill switch is introduced

- **WHEN** a historical attachment backfill page is in progress
- **THEN** the page SHALL only terminate via explicit cancellation
  (`abortSignal`) or by completing its bounded byte-cost unit of work
- **AND** SHALL NOT be terminated by an elapsed-time limit.
