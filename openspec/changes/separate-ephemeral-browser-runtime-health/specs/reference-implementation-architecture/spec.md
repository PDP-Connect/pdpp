## ADDED Requirements

### Requirement: Dynamic allocator observations SHALL be bounded, current, non-allocating, and honest about repair

Each full connection-health refresh SHALL perform at most one `listSurfaces()`
observation for each dynamic allocator scope and SHALL share that single snapshot
with every projection reader in the refresh. The snapshot cache SHALL be bounded to
that refresh; expired data SHALL be represented as `status: "unknown", reason:
"expired"`, not reused as stale-while-revalidate or last-known-good green evidence.

The health read path SHALL NOT call `ensureSurface`, acquire a lease, create, stop,
or restart a surface merely to observe health. `NekoSurfaceAllocatorService`
`listSurfaces()` may nevertheless perform its bounded idempotent
`#migrateContainerNetworkIfNeeded` operation while deriving existing-container
readiness: it may attach an owned existing container to the expected Docker network
and accepts an already-attached concurrent repair as success. This narrowly scoped
attachment repair SHALL NOT create, stop, restart, or lease a surface, and the
health specification SHALL NOT describe `listSurfaces()` as effect-free.

`listSurfaces()` proves only that the allocator API was reachable enough to accept
the request and return a valid inventory response at the observation time. It does
not prove free capacity, successful future allocation, container creation,
profile-specific startup, CDP readiness, provider authentication, or collection
success.

#### Scenario: One full refresh has bounded calls and a shared inventory

**WHEN** a full refresh projects multiple H-E-B and Reddit connection-health
consumers against one dynamic allocator scope
**THEN** the reference SHALL call `listSurfaces()` exactly once for that scope
**AND** all consumers SHALL use the resulting same-refresh snapshot
**AND** the refresh SHALL make zero `ensureSurface`, create, stop, restart, or
lease-acquisition calls.

#### Scenario: Observation allows only bounded existing-network repair

**WHEN** `listSurfaces()` observes an existing owned legacy container that lacks the
expected Docker network
**THEN** it MAY perform the bounded idempotent expected-network attachment repair
while deriving readiness
**AND** it SHALL NOT create, stop, restart, or lease a surface
**AND** a failed attachment SHALL leave the observation non-green rather than
allocating a replacement.

#### Scenario: Expired cache cannot serve stale green

**WHEN** a prior allocator observation has expired before a new full refresh
**THEN** the projection SHALL represent reachability as `status: "unknown", reason:
"expired"` until a new valid observation completes
**AND** it SHALL not expose stale-while-revalidate green or reuse the old inventory
as current capacity evidence.

### Requirement: Process replacement SHALL use an append-only two-phase non-secret reference-owned ledger

The reference implementation SHALL persist a connection-scoped, append-only
process-replacement ledger for managed browser surfaces. Every replacement,
including one discovered after the fact, SHALL record exactly one cause from this
closed set:

```ts
type ReplacementCause =
  | "capacity_pressure"
  | "idle_ttl"
  | "operator_requested"
  | "restart_reconcile"
  | "readiness_invalidated"
  | "allocator_internal_ensure_surface"
  | "same_container_browser_generation_change"
  | "external_or_host_loss";
```

The installed public `StopBrowserSurfaceRequest` reasons SHALL map losslessly:
`capacity_pressure` to `capacity_pressure`, `idle_ttl` to `idle_ttl`, `operator`
to `operator_requested`, `reconcile` to `restart_reconcile`, and `surface_failed`
to `readiness_invalidated`. The implementation SHALL NOT collapse idle-TTL or
readiness-invalidation replacement into capacity or operator causes. The remaining
causes cover allocator-internal replacement, same-container browser-generation
change, and externally observed or unknown host loss.

The ledger SHALL persist a `started` receipt before a new process generation is
claimed. It SHALL then persist exactly one `completed` receipt after the new
generation is observed, or a truthful terminal non-completion outcome. Each receipt
SHALL contain a stable idempotency key; connection, profile, surface-subject, and
known run/lease/surface/generation correlations; observed time; and old/new
one-way process-generation hashes where observed. It SHALL not contain raw process
or container identifiers, cookies, tokens, profile content, provider response
bodies, or session material. Replaying an idempotency key SHALL return the same
receipt; a conflicting replay SHALL be rejected.

The current replacement selection SHALL be scoped to connection and surface subject.
It SHALL select an unresolved `started` receipt while replacement is pending, or a
completed receipt only when its next-generation hash matches the current observed
process generation. A terminal or non-matching historical receipt SHALL NOT be
selected as current. SQLite and Postgres implementations SHALL have equivalent
schema, idempotency, ordering, selection, redaction, and connection-isolation
behavior.

The ledger belongs to reference-owned runtime persistence. The RI may expose its
internal correlation through its existing allocator metadata/projection adapter and
the `current_replacement_receipt` field; it SHALL NOT add or alter the standalone
remote-surface package/repository or its public APIs.

#### Scenario: Replacement replay is idempotent and isolated

**WHEN** the same replacement event is observed repeatedly for one connection
**THEN** the ledger SHALL retain one receipt sequence for its idempotency key
**AND** a contradictory replay SHALL be rejected rather than mutating its cause,
generation, or connection identity.

**WHEN** two isolated connections replace processes concurrently, including when
they share a profile-like display value
**THEN** each ledger record and resulting current replacement receipt SHALL remain
scoped to its own connection and surface subject
**AND** neither process-generation hashes nor continuity state SHALL be joined
across connections.

#### Scenario: Current selection matches the observed process generation

**WHEN** a replacement receipt completed for an older process generation and a
later current process generation is observed for the same connection
**THEN** the projection SHALL NOT select the older receipt as
`current_replacement_receipt`
**AND** it SHALL keep the historical ledger entry auditable.

#### Scenario: Storage backends agree

**WHEN** the same replacement sequence is persisted in SQLite and Postgres
**THEN** both backends SHALL accept exactly `capacity_pressure`, `idle_ttl`,
`operator_requested`, `restart_reconcile`, `readiness_invalidated`,
`allocator_internal_ensure_surface`, `same_container_browser_generation_change`,
and `external_or_host_loss`
**AND** both SHALL reject the same duplicate/conflicting idempotency key
**AND** both SHALL preserve the same connection-scoped order, current-generation
selection, and forbidden-field redaction.

### Requirement: Portable authenticated-session continuity SHALL remain an explicit cross-boundary handoff

Portable authenticated-session continuity SHALL remain OPEN / UNSATISFIED until
three owners are specified, approved, and implemented: the
`packages/polyfill-connectors` provider adapter and exact probe; the
`reference-implementation/runtime` fencing/checkpoint/replace/restore/probe
orchestrator; and a separately authorized encrypted connection-scoped
secret-session store. This requirement SHALL NOT be read as authorization to design
or implement that secret store in the runtime-health change.

The mandatory acceptance gate is two isolated forced process/container replacements
followed by each provider's exact authenticated-session probe and proof of no false
owner action. For ChatGPT, HTTP 200 with no `user` is false. DOM, URL, title, and
profile-presence heuristics SHALL be rejected as proof. The gate SHALL remain marked
OPEN / UNSATISFIED until it has independently passed.

#### Scenario: OPEN handoff is not marked complete by evidence-only work

**WHEN** the runtime-health projection and non-secret replacement ledger are
implemented without the separately authorized session store and provider adapter
**THEN** the portable-continuity handoff SHALL remain OPEN / UNSATISFIED
**AND** no task, release note, or health headline SHALL represent it as complete.

#### Scenario: Two forced replacements remain an unsatisfied no-false-action gate

**WHEN** deterministic verification forces process/container replacement
independently for two isolated process-bound connections before the authorized
provider adapter, continuity orchestrator, and encrypted connection-scoped
session store exist
**THEN** each connection SHALL remain isolated and expose no false owner action
from replacement evidence alone
**AND** the portable-continuity gate SHALL remain OPEN / UNSATISFIED.
