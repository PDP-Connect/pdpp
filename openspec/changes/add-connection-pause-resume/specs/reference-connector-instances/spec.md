## ADDED Requirements

### Requirement: Owner-Initiated Connection Pause And Resume

The reference implementation SHALL expose connection pause and connection resume as owner-initiated, connection-scoped actions keyed on exactly one `connector_instance_id`.

Pause SHALL transition a connection from `active` to `paused`. Resume SHALL transition a connection from `paused` to `active`. Both SHALL be zero-cascade status flips: they SHALL NOT delete, rewrite, or hide already-collected records; SHALL NOT revoke, rotate, or erase stored credentials; and SHALL NOT alter disclosure grants, schedules, or the audit spine.

Pause SHALL remain distinct from revoke. Pause stops future collection while retaining the connection's stored credential so that resume requires no re-authorization. Revoke SHALL continue to express a withdrawn authorization.

Both actions SHALL be reachable on the owner-agent bearer control plane and on the owner-session reference control plane. Neither SHALL be reachable over `/mcp` or by a client grant token.

A paused connection SHALL be refused by run admission until it is resumed. Resume SHALL NOT itself validate or supply a credential; a resumed connection whose credential is missing or expired SHALL surface a typed credential error on its next collection run.

#### Scenario: Owner pauses an active connection

- **WHEN** the owner pauses a connection whose status is `active`
- **THEN** the connection's status SHALL become `paused`
- **AND** its collected records, stored credential, disclosure grants, schedule, and audit spine SHALL be unchanged
- **AND** subsequent run admission for that connection SHALL be refused while it remains paused

#### Scenario: Owner resumes a paused connection

- **WHEN** the owner resumes a connection whose status is `paused`
- **THEN** the connection's status SHALL become `active`
- **AND** its collected records SHALL be unchanged
- **AND** the connection SHALL become eligible for run admission

#### Scenario: Wrong-state pause and resume are typed and distinguishable

- **WHEN** the owner resumes a connection whose status is not `paused`
- **THEN** the reference SHALL refuse with `connector_instance_not_paused`
- **AND** **WHEN** the owner pauses a connection whose status is not `active`
- **THEN** the reference SHALL refuse with `connector_instance_not_active`
- **AND** neither refusal SHALL mutate the connection

#### Scenario: Unknown or foreign connection

- **WHEN** a pause or resume names a connection that does not exist or belongs to another owner
- **THEN** the reference SHALL refuse with `connector_instance_not_found`
- **AND** SHALL NOT disclose whether the connection exists

#### Scenario: Paused is an owner-visible status with a way back

- **WHEN** the owner views a connection whose status is `paused`
- **THEN** the console SHALL render `paused` as a first-class status distinct from revoked, syncing, and setup-in-progress
- **AND** SHALL present a resume action for that connection
- **AND** SHALL state that collected data is retained

### Requirement: Manual Upload Import Directory Absence Is A Typed Failure

The reference implementation SHALL verify that a manual-upload connection's `import_dir` exists as a directory on the host before a run is given the binding's import-directory environment variable.

When the directory is absent or is not a directory, the reference SHALL fail the run environment resolution with a typed `manual_upload_import_dir_missing` error naming the missing path, the binding's `import_dir_env_var`, and the `connector_instance_id`. The reference SHALL NOT report this condition as a bare coverage or completeness verdict, because the fault is host or binding configuration rather than an incomplete owner-supplied archive.

A source binding that is not a manual-upload binding SHALL continue to resolve to no manual-upload environment fragment without raising this error.

#### Scenario: Missing import directory names what is missing

- **WHEN** a manual-upload connection's `import_dir` does not exist on the host
- **THEN** run environment resolution SHALL fail with `manual_upload_import_dir_missing`
- **AND** the error SHALL name the missing path, the import-directory environment variable, and the connection
- **AND** the run SHALL NOT report the condition as an incomplete owner-supplied source

#### Scenario: Import path that is not a directory

- **WHEN** a manual-upload connection's `import_dir` exists but is not a directory
- **THEN** run environment resolution SHALL fail with `manual_upload_import_dir_missing`

#### Scenario: Non-manual-upload binding is unaffected

- **WHEN** a connection's source binding is not a manual-upload binding
- **THEN** manual-upload run environment resolution SHALL yield no environment fragment
- **AND** SHALL NOT raise `manual_upload_import_dir_missing`
