## Why

`paused` has been a valid `connector_instances.status` since the schema's first CHECK constraint, and the owner-facing specs already promise pause and resume as per-instance actions. Neither existed. No production code path ever wrote `paused`, and only one path ever cleared it — a side effect of storing a static-secret credential.

That left `paused` a state with no entrance and, for any connection that reached it another way, no exit. Two of the owner's connections (419,290 records) arrived pre-paused from an archive transplant and could not be recovered: `run` refused them as inactive, `reactivate` refused them as not-revoked, the console had no control because `SourceStatusKind` had no `paused` member, and file-import connections authenticate to nothing so the credential-capture side effect never fired.

## What Changes

- Add owner-initiated `pause` (active -> paused) and `resume` (paused -> active) as first-class connection actions, on both the owner-agent bearer surface and the owner-session reference surface.
- Add `connector_instance_not_paused` (409) and `connector_instance_not_active` (409) so each action refuses a wrong-state target with a typed, distinguishable code.
- Make `paused` a first-class `SourceStatusKind` the console renders and explains, with a Resume control on a paused connection and a Pause control on an active one.
- Keep the narrow automatic resume for recovered `historical_archive` connections (credential capture and run admission) unchanged, so repairing a credential still resumes that row without a second owner step.
- Fail loudly when a manual-upload binding's `import_dir` is absent on the host, naming the missing path and env var instead of reporting a bare `source_incomplete`.

## Capabilities

Modified:
- `reference-connector-instances`

## Impact

- Pause and resume are zero-cascade status flips. Records, credentials, grants, schedules, and the audit spine are untouched by both.
- Pause is deliberately NOT a substitute for revoke: it stops collection while keeping the credential, so it carries no credential-revocation or grant-narrowing semantics.
- A manual-upload run whose artifact directory is missing now fails with a typed, actionable error rather than an owner-blaming coverage verdict.
