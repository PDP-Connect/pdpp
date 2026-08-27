## ADDED Requirements

### Requirement: Permanent terminal commits are rebuilt before retirement

The local collector SHALL NOT blindly requeue a dead-letter
`terminal_run_commit` as ordinary upload work. It SHALL retain the rejected
terminal row and may generate a replacement only from a newly completed pass
that satisfies the existing terminal coverage and acknowledgement gates.

#### Scenario: A terminal commit is permanently rejected

- **WHEN** a `terminal_run_commit` row is dead-lettered by a non-retryable
  server rejection
- **THEN** recovery SHALL leave that row and its payload/error retained
- **AND** recovery SHALL NOT resend the same row bytes as a blind retry
- **AND** the active lifecycle SHALL continue to report the unresolved
  terminal evidence until a replacement is accepted

#### Scenario: A replacement terminal commit is accepted

- **WHEN** a newly completed pass produces a terminal commit for the same
  source, connector instance, and collection boundary
- **AND** the server accepts the replacement terminal commit
- **THEN** the collector SHALL record a durable supersession link to the old
  dead-letter row
- **AND** the old row SHALL remain locally inspectable
- **AND** the old row SHALL no longer block active lifecycle recovery

#### Scenario: Replacement generation does not complete

- **WHEN** the new pass is interrupted, lacks coverage evidence, or its
  replacement terminal commit is not accepted
- **THEN** the old dead-letter terminal row SHALL remain active
- **AND** the collector SHALL NOT claim terminal coverage or retire the row

#### Scenario: Ordinary retryable dead-letter recovery

- **WHEN** a non-terminal dead-letter upload has a retryable transport/server
  error
- **THEN** the existing filtered requeue and delivery behavior SHALL remain
  available
