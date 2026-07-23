## ADDED Requirements

### Requirement: Test discovery SHALL be source-derived and fail closed

The accounting checker SHALL derive tracked test-like paths from Git, compare
them with every suite's planned and observed paths, and fail if any path is
unknown, missing, duplicated, empty, malformed, or neither executed nor
explicitly excluded.

#### Scenario: A migrated test disappears from discovery

**WHEN** a tracked `.test.js` is renamed to `.test.ts` without a checked manifest update
**THEN** the pre-run parity check SHALL fail
**AND** the suite SHALL NOT be reported green.

### Requirement: Test execution SHALL have verifier-issued authority

The accounting authority SHALL issue an unexpired, single-use run ID and nonce
before spawning each required suite/profile. It SHALL bind the intended
integration base, current SHA, complete tracked source tree, manifest, exact
child argv/cwd, selected files, profile, transcript, exit, and structured
assertion/pass/failure/skip counts. Verification SHALL consume the run ID and
SHALL reject caller-authored receipts, replay, expiry, generic skip reasons,
incomplete child selection, and a missing required profile.

#### Scenario: A receipt is fabricated without execution

**WHEN** a JSON receipt and matching transcript exist without an issued and completed run
**THEN** verification SHALL fail
**AND** it SHALL NOT report the suite/profile green.

### Requirement: Modernization task packets SHALL be invalidated when stale

A task SHALL carry its base SHA, closure hash, source-resolved runtime edges,
owned and forbidden paths, generated artifacts, test manifest, and atomic
lease/CAS receipt. The closure and lease SHALL bind every one of those inputs.
The validator SHALL reject a base other than the current integration SHA (except
for the single commit directly materializing the tracked packet from that base).
That materialization SHALL change the packet itself and only its owned or
explicitly retired paths. The validator SHALL reject a changed scoped input, an
escaped packet or lease path, or a canonical generator that does not recreate
byte-identical output. The lease SHALL be a local atomic compare-and-create
boundary and SHALL NOT require a distributed workflow service.

#### Scenario: A task is applied to a changed integration head

**WHEN** the task base SHA differs from the current integration SHA and is not
the direct parent of the single materialization commit
**THEN** the task checker SHALL fail before execution
**AND** no receipt SHALL be accepted for that task.

### Requirement: Accounting SHALL detect runtime and artifact blind spots

Mutation tests SHALL prove that changed dynamic import or spawn targets, an
omitted authority manifest-command edge, a comment that names a different target,
a generator that exits without recreating output, assertion shrinkage, skip
additions, and empty selections fail the accounting gate.

#### Scenario: A subprocess target changes to another existing test

**WHEN** the declared runtime-edge target changes without a packet update
**THEN** the edge or receipt comparison SHALL fail
**AND** the task SHALL require re-planning from the current base.
