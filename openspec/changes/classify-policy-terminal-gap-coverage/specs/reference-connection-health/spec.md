## MODIFIED Requirements

### Requirement: Coverage, Work, And Attention SHALL Remain Decomplected

The reference implementation SHALL keep source coverage, local-device backlog,
dead letters, retryable detail gaps, terminal detail-gap evidence, and owner
attention as separate condition families. A terminal detail gap with an
explicit policy disposition SHALL remain visible in diagnostics and terminal
totals, but SHALL NOT by itself produce a repair-blocking `terminal_gap` or a
maintainer `code_fix` action. A terminal detail gap without that policy
disposition SHALL remain repair-blocking.

#### Scenario: Proven policy terminal evidence stays visible without a false code fix

- **WHEN** a Gmail attachment terminal settlement writes the validated
  `gmail_attachment_too_large` disposition with observed-size and configured-
  limit evidence
- **THEN** the terminal row and its aggregate count SHALL remain visible
- **AND** that row alone SHALL NOT produce a `terminal_gap` coverage condition
  or maintainer `code_fix` action.

#### Scenario: Mutable terminal fields cannot fabricate policy evidence

- **WHEN** a generic status transition changes a `not_found` terminal row's
  reason or error class to `too_large`
- **THEN** the affected stream SHALL remain `terminal_gap`
- **AND** the projection SHALL retain the maintainer repair action.

#### Scenario: A generic transition invalidates a prior policy proof

- **WHEN** a terminal gap with validated policy evidence is changed by a
  generic status, reason, or error transition, or leaves terminal state
- **THEN** the policy disposition SHALL be cleared
- **AND** the resulting row SHALL remain repair-blocking unless a later valid
  terminal settlement writes a new proof.

#### Scenario: Coverage and diagnostics reject the same malformed proof

- **WHEN** persisted policy disposition JSON has only a `kind` or otherwise
  fails the closed observed-size/configured-limit proof shape
- **THEN** neither coverage nor owner diagnostics SHALL treat it as policy
- **AND** the terminal row SHALL remain repair-blocking.

#### Scenario: Historical rows without the disposition remain repair-blocking

- **WHEN** a terminal row has no validated policy disposition
- **THEN** its terminal evidence SHALL remain visible and repair-blocking
- **AND** the implementation SHALL NOT infer policy evidence from free text,
  reason, or error class.

#### Scenario: Historical Gmail evidence may be remeasured but not backfilled

- **WHEN** an operator uses the explicit dry-run-by-default remeasurement
  bridge for one Gmail connection instance's canonical `attachments` terminal
  `too_large` rows that lack a validated policy disposition
- **THEN** the bridge SHALL only select locator shapes the normal Gmail
  scheduled recovery parser accepts: a derivable `attachment_id`, or nonempty
  `message_id` and `part_index`
- **AND** it SHALL only return the selected current gap rows to ordinary
  pending recovery with a status/disposition/locator compare-and-set
- **AND** it SHALL preserve record data and immutable terminal audit/spine
  history without inferring a policy disposition or emitting a new outcome
- **AND** a later normal scheduled recovery lease SHALL be the sole authority
  for any new policy proof, `not_found`, or recovered outcome.
