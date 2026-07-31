## MODIFIED Requirements

### Requirement: Bounded connector-summary maintenance SHALL make terminal-fold progress

The reference implementation SHALL treat terminal-event folding as the sole
authority for terminal-fact checkpoints. A bounded maintenance page with
existing terminal-fold participants SHALL run a finite terminal-event fold
batch before generic canonical repairs. One cooperative absolute deadline SHALL
be passed to every bounded repair and fold phase and every participant
checkpoint CAS; no repair, fold batch, or checkpoint write SHALL start after
expiry, though one started SQL unit MAY finish. Missing evidence
rows MAY use only an explicit finite cold-row candidate cap before their first
fold when no existing participant can be folded. The implementation SHALL
retain the existing lease-fenced maintenance cursor and the per-row terminal
checkpoint; it SHALL NOT add a second cursor, read-path write, cache, sentinel,
compatibility path, statement cancellation, hard-real-time claim, or
connector-specific scheduling rule for this behavior.

#### Scenario: Slow generic repair on the first page

- **WHEN** a 25-row first page has existing incomplete terminal folds and
  generic canonical repair is slow
- **THEN** the page SHALL advance its durable terminal checkpoints in its
  finite first fold batch before generic repairs start
- **AND** a resume from the first-page cursor SHALL NOT repeat an unchanged
  terminal checkpoint vector solely because generic repair used the budget.

#### Scenario: Unrelated page has newer terminal history

- **WHEN** a later page has a terminal event newer than every terminal event
  for an already-current earlier page
- **THEN** the earlier page SHALL NOT become a generic repair candidate solely
  because of that unrelated terminal event
- **AND** its terminal checkpoint SHALL remain owned by its scoped fold.

#### Scenario: Incomplete fold makes no progress

- **WHEN** a bounded fold is incomplete
- **THEN** its aggregate receipt SHALL report the participant count, events
  read, and previous and new minimum checkpoints without inventing a fold time
  budget
- **AND** it SHALL explicitly identify a zero-progress incomplete fold without
  exposing connection, cursor, credential, or event payload values.

#### Scenario: Deadline expires during participant checkpoint writes

- **WHEN** a finite terminal-event batch completed and a delayed participant
  checkpoint write crosses the cooperative deadline
- **THEN** no later participant checkpoint write SHALL start
- **AND** the fold SHALL return incomplete while preserving already accepted
  checkpoints so unfinished participants resume on the next scoped fold.

#### Scenario: Cooperative one-millisecond cold page

- **WHEN** 25 cold rows have a delayed repair unit and a one-millisecond
  maintenance deadline
- **THEN** at most one repair unit SHALL start before expiry
- **AND** later rounds SHALL converge from durable evidence without a second
  maintenance cursor.
