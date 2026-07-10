## MODIFIED Requirements

### Requirement: Owner Surfaces SHALL Share One Projection Contract

Dashboard, CLI, and owner-control-plane API surfaces SHALL consume the same connection health projection and condition contract.

Owner-console surfaces that expose owner-triggered run controls SHALL render the accepted-start result returned by the reference control action as local, connection-scoped feedback. When that result includes a run id, the owner console SHALL expose a link to the corresponding sync detail, derived from that validated run id, and SHALL keep that exact link visible across refresh or revalidation while the local acknowledgement remains current. The console SHALL NOT rely solely on a later active-run projection refresh to prove that the click worked, because short runs can start and complete before the refreshed projection observes them as active. Owner-console surfaces that expose connection-level owner actions SHALL also honor a typed exact-sync target when structured attention carries a causative run id. That target SHALL use the existing owner-action view model rather than inferring from latest-run history, and it SHALL remain distinct from legacy action-target, attachment, or remediation fields. When no structured run id is available, the rendered owner action SHALL not invent a clickable exact target or a generic `/syncs` fallback.

#### Scenario: Fast owner-triggered sync returns a run id

- **WHEN** the owner clicks a source-detail sync control
- **AND** the reference accepts the request and returns a run id
- **THEN** the console SHALL render local confirmation that the sync started
- **AND** it SHALL link to the sync detail for that run id

#### Scenario: Accepted start survives refresh

- **WHEN** a source-detail sync starts successfully
- **AND** the owner refreshes or the page revalidates before the next server projection catches the run as active
- **THEN** the owner console SHALL still show the accepted-start feedback from the control action result
- **AND** the exact run link SHALL remain visible until a later current projection or local expiry supersedes it
- **AND** the marker SHALL remain bounded by its original expiry, not a renewed mount cycle

#### Scenario: Connection-level action has a known run id

- **WHEN** a connection-level owner action is backed by structured attention evidence with a causative run id
- **THEN** the owner-facing action SHALL carry a typed exact-sync target for that run id
- **AND** the owner-facing action SHALL route directly to `/syncs/<run_id>`
- **AND** it SHALL NOT fall back to the generic `/syncs` index

#### Scenario: Structured attention can still be secret

- **WHEN** structured attention is marked secret and carries a causative run id
- **THEN** the legacy owner-action target fields remain redacted
- **AND** the rendered exact-sync target still carries only the opaque run id
