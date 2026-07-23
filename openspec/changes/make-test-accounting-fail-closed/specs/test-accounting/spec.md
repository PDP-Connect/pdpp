## ADDED Requirements

### Requirement: Test discovery SHALL be source-derived and fail closed

The accounting checker SHALL derive tracked test-like paths from Git, compare them
with every suite's planned and observed paths, and fail if any path is unknown,
missing, duplicated, empty, malformed, or neither executed nor explicitly excluded.

#### Scenario: A migrated test disappears from discovery

**WHEN** a tracked `.test.js` is renamed to `.test.ts` without a checked manifest update
**THEN** the pre-run parity check SHALL fail
**AND** the suite SHALL NOT be reported green.

### Requirement: Test execution SHALL emit structured receipts

Each suite/profile receipt SHALL include exact SHA, normalized sorted files, counts,
structured skip reasons, profile, exit code, and an explicit assertion value or
mutation-backed `null`; required unavailable profiles SHALL fail.

#### Scenario: A runner silently skips a required profile

**WHEN** a required backend profile cannot execute
**THEN** receipt verification SHALL fail
**AND** it SHALL identify the missing profile and reason.

### Requirement: Modernization task packets SHALL be invalidated when stale

A task SHALL carry its base SHA, closure hash, runtime edges, owned and forbidden
paths, test manifest, and atomic lease. Integration SHALL reject a packet when any
of those validity inputs no longer matches.

#### Scenario: A task is applied to a changed integration head

**WHEN** the task base SHA differs from the current integration SHA
**THEN** the task checker SHALL fail before execution
**AND** no receipt SHALL be accepted for that task.

### Requirement: Accounting SHALL detect runtime and artifact blind spots

Mutation tests SHALL prove that changed dynamic import or spawn targets, generated
artifact drift, assertion shrinkage, skip additions, and empty selections fail the
accounting gate.

#### Scenario: A subprocess target changes to another existing test

**WHEN** the declared runtime-edge target changes without a packet update
**THEN** the edge or receipt comparison SHALL fail
**AND** the task SHALL require re-planning from the current base.
