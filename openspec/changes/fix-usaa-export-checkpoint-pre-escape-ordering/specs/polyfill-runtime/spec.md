## ADDED Requirements

### Requirement: Connector failure-phase DOM checkpoints SHALL precede page-mutating cleanup in the same phase

When a connector attempts a best-effort durable DOM checkpoint capture for a failure phase, and that same phase also performs a page-mutating cleanup action (e.g. dismissing a dialog, pressing a key that closes an overlay, navigating away), the checkpoint capture SHALL run before the page-mutating cleanup action, so the captured surface reflects the page as it existed when the failure was detected rather than after cleanup has already altered it.

#### Scenario: A recognized-but-unexpected dialog shape is dismissed after capture

- **WHEN** a connector's export flow detects that an opened dialog does not have the expected control shape
- **AND** the connector both captures a best-effort DOM checkpoint for that phase and dismisses the dialog (e.g. via `Escape`) as part of the same failure handling
- **THEN** the checkpoint capture SHALL be invoked before the dismissal keypress
- **AND** a dismissal that runs first SHALL be treated as a defect, since it can mutate the surface the checkpoint was meant to observe

#### Scenario: Checkpoint capture failure does not block cleanup

- **WHEN** the pre-cleanup checkpoint capture itself fails or times out
- **THEN** the connector SHALL proceed with the page-mutating cleanup regardless
- **AND** the capture failure SHALL NOT be surfaced as a run failure
