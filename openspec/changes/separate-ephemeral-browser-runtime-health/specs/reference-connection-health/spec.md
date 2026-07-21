## ADDED Requirements

### Requirement: Ephemeral browser runtime health SHALL expose six independent facts with stable names

For every browser-backed connection, the reference implementation SHALL derive a
connection-scoped `EphemeralBrowserRuntimeProjection` containing exactly these
fact groups: management (`connection_kind`, `surface_mode`), current allocator
capability (`allocator_observation`), active execution (`demand`, `active_lease`),
current capacity (`current_compatible_idle_surfaces`), process-bound credential
continuity (`credential_continuity`), and receipts
(`last_successful_runtime_receipt`, `current_replacement_receipt`). It SHALL expose
the runtime-axis result as `health_eligible`.

`connection_kind` SHALL use `browser-runtime`, `unmanaged-browser`, `non-browser`,
or `local-device`; `surface_mode` SHALL use `dynamic-managed`, `static-managed`,
or `none`. A dynamic `allocator_observation.status` SHALL use `available`,
`unavailable`, or `unknown`; an expired observation is exactly
`status: "unknown", reason: "expired"`, not a fourth status. These names SHALL NOT
be replaced by prose aliases or alternate hyphen/underscore spellings.

`health_eligible` SHALL describe only current runtime capability. The
connection-health summary separately owns overall connection collectability and the
headline, which SHALL continue to account for credential readiness, collection,
coverage, freshness, and all other applicable axes. A `health_eligible` runtime
axis SHALL NOT by itself project the connection green or collectable.

For ordinary dynamic-managed browser runtime with `demand: "none"`, a current
`available` allocator observation SHALL make the runtime axis health-eligible even
when `current_compatible_idle_surfaces` is zero. `unavailable`, `unknown`, and
expired observations SHALL fail closed and SHALL NOT be projected green. A current
active unhealthy surface or active execution with no matching non-terminal
`active_lease` SHALL fail closed. Static-managed browser runtime with no current
ready surface remains unavailable. `unmanaged-browser`, `non-browser`, and
`local-device` connections with `surface_mode: "none"` SHALL expose the managed
runtime axis as N/A rather than inherit managed browser uncertainty.

#### Scenario: H-E-B and Reddit have zero idle surfaces after a successful release

**WHEN** parameterized H-E-B and Reddit connections are `browser-runtime` with
`surface_mode: "dynamic-managed"`, `demand: "none"`, zero
`current_compatible_idle_surfaces`, and a current `available` allocator observation
**THEN** each projection's `health_eligible` SHALL be true
**AND** neither connection SHALL use released surface history as headline authority
**AND** the connection headline SHALL still require its independent non-runtime
health axes to pass.

#### Scenario: Allocator capability is not current green evidence

**WHEN** a dynamic-managed runtime's allocator observation is `unavailable`,
`unknown`, or `status: "unknown", reason: "expired"`
**THEN** `health_eligible` SHALL be false
**AND** the runtime axis SHALL NOT project green from a previous observation,
successful run, receipt, or retired row.

#### Scenario: Active execution is missing its lease or is unhealthy

**WHEN** a dynamic-managed connection has `demand: "active"` and its required
non-terminal `active_lease` is absent, its surface is missing, or its current leased
surface is unhealthy
**THEN** `health_eligible` SHALL be false
**AND** zero idle capacity or historical success SHALL NOT soften that result.

#### Scenario: Static, unmanaged, non-browser, and local-device modes keep distinct semantics

**WHEN** a static-managed browser runtime has no current ready surface
**THEN** its runtime axis SHALL be unavailable.

**WHEN** a connection is `unmanaged-browser`, `non-browser`, or `local-device` with
`surface_mode: "none"`
**THEN** the managed-runtime axis SHALL be N/A.

### Requirement: Runtime receipts SHALL be bounded historical evidence with no headline authority

`last_successful_runtime_receipt` SHALL be accepted only when the same connection
has one ordered, bounded `ready -> succeeded -> released` chain with matching
`connection_id`, `profile_key`, `run_id`, `surface_subject_id`, `surface_id`,
`lease_id`, and `generation`. The projection SHALL reject a future or over-age
`completed_at` or any identity, generation, timestamp, or event-order mismatch. A
valid historical receipt may be shown as diagnostic evidence but SHALL NOT make the
runtime axis green, allocate capacity, revive a retired surface, or override current
failure/unknown evidence.

`current_replacement_receipt` SHALL be a connection- and surface-subject-scoped
selection for the current process generation, not the newest replacement history
row. It SHALL describe only the current replacement state and correlation identity;
it SHALL NOT itself prove surface readiness, provider authentication, connection
collectability, or headline health.

#### Scenario: Receipt mismatch is rejected

**WHEN** a candidate H-E-B or Reddit receipt has a stale/future age or a mismatched
connection, profile, run, surface subject, surface, lease, generation, timestamp,
or `ready -> succeeded -> released` event order
**THEN** the reference SHALL omit it as a valid `last_successful_runtime_receipt`
**AND** it SHALL not influence runtime-axis or headline health.

#### Scenario: Exact released receipt remains history

**WHEN** the exact bounded receipt proves ready, succeeded, and released for one
connection but no current ready surface or eligible allocator observation exists
**THEN** the receipt SHALL remain visible as historical evidence
**AND** the headline SHALL remain determined solely by current runtime facts and
the connection's independent axes.

### Requirement: Process-bound credential continuity SHALL fail closed without false owner action

For a connection whose provider authentication is process-bound, a current
`credential_continuity` of `replacement_pending`, `rehydration_false`, or
`indeterminate` SHALL not be green. Those states SHALL create no owner action on
their own. Only a typed, verified, provider-originated, connection-bound
`ProviderInvalidationProof` may create the existing connection-scoped repair action,
and the reference SHALL deduplicate that action by connection and proof identity.
A profile path, URL, title, DOM marker, replacement receipt, or successful HTTP
transport response without the provider's authenticated identity SHALL NOT prove
continuity or invalidation.

#### Scenario: ChatGPT HTTP 200 without a user is not continuity

**WHEN** the ChatGPT authenticated-session probe receives HTTP 200 from
`/api/auth/session` but the response contains no `user`
**THEN** the probe result SHALL be false
**AND** `credential_continuity` SHALL not be green
**AND** the connection SHALL receive no owner repair action unless a separate typed
verified `ProviderInvalidationProof` exists.

#### Scenario: Replacement pending is not a repair request

**WHEN** a process-bound connection has a `current_replacement_receipt` but
rehydration is pending, false, or indeterminate
**THEN** the health projection SHALL surface the continuity state as non-green
diagnostic evidence
**AND** it SHALL NOT create a reauth, browser-session, or stored-credential owner
action from replacement alone.
