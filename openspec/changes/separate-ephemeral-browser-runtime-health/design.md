## Context

The successful H-E-B and Reddit runs establish a bounded runtime history:
`ready -> succeeded -> released`. They do not establish a current ready surface.
Conversely, scale-to-zero runtime practice establishes that a callable allocator
does not require a warm idle instance. The current browser-health signal needs both
facts without reintroducing retired-row authority.

The ChatGPT evidence establishes a separate credential boundary: a replacement
process can reuse a profile and reach `https://chatgpt.com/`, yet the exact
authenticated-session probe can return HTTP 200 without a `user`. That result is
false, not an authenticated session, and DOM, URL, title, or profile-presence
heuristics cannot override it.

## Decision

### Six independent runtime facts have one implementation-facing shape

The reference implementation owns an `EphemeralBrowserRuntimeProjection`. Its
field names are stable handoff names, not prose aliases:

```ts
{
  connection_kind: "browser-runtime" | "unmanaged-browser" | "non-browser" | "local-device";
  surface_mode: "dynamic-managed" | "static-managed" | "none";
  allocator_observation: {
    status: "available" | "unavailable" | "unknown";
    reason?: "http" | "fetch" | "timeout" | "malformed" | "not_observed" | "expired";
    observed_at?: string;
    expires_at?: string;
  } | null;
  demand: "none" | "active";
  active_lease: ActiveLeaseExecution | null;
  current_compatible_idle_surfaces: number;
  credential_continuity:
    "not_applicable" | "continuity_proven" | "replacement_pending" |
    "rehydration_false" | "indeterminate";
  last_successful_runtime_receipt: LastSuccessfulRuntimeReceipt | null;
  current_replacement_receipt: CurrentReplacementReceipt | null;
  health_eligible: boolean;
}
```

These represent six independent facts: surface management, allocator capability,
active demand/lease execution, current idle capacity, process-bound credential
continuity, and receipts. `last_successful_runtime_receipt` and
`current_replacement_receipt` are the two receipt views within the sixth fact.

`health_eligible` means only that the **runtime axis** may contribute healthy
evidence. `reference-connection-health` separately owns connection collectability
and its headline; it also considers credential readiness, collection, coverage,
freshness, and other axes. A runtime-eligible connection is therefore not
automatically green or collectable, and a non-green continuity overlay is never
erased by allocator capability.

Dynamic-managed ordinary no-demand runtime is eligible only when
`allocator_observation.status` is `available`; zero
`current_compatible_idle_surfaces` is ordinary. `unavailable`, `unknown`, and
`unknown` with `reason: "expired"` are never green substitutes. A current active
unhealthy surface, or `demand: "active"` without a matching non-terminal
`active_lease`, fails closed. Static-managed absence remains unavailable.
`unmanaged-browser`, `non-browser`, and `local-device` use `surface_mode: "none"`
and do not inherit managed-runtime uncertainty.

### Observation and cache boundary

One full connection-health refresh makes at most one allocator `listSurfaces()`
observation for each dynamic allocator scope. Its resulting snapshot is the only
allocator inventory consumed by that full refresh. A cache may deduplicate readers
inside that boundary only. On expiry its observation is `status: "unknown"` with
`reason: "expired"`, not `available`: no stale-while-revalidate green and no
implicit last-known-good promotion are permitted. A historical ready or successful
run receipt has no TTL path to headline health and cannot resurrect a retired row.

The health read path SHALL NOT call `ensureSurface`, acquire a lease, create, stop,
or restart a surface. The current `NekoSurfaceAllocatorService.listSurfaces()` is
not literally effect-free: while deriving readiness it may invoke the bounded,
idempotent `#migrateContainerNetworkIfNeeded` repair, which can attach an existing
owned container to the expected Docker network and treats an already-attached race
as success. It still SHALL NOT allocate, create, stop, restart, or lease a surface.

`listSurfaces()` proves only that the allocator API was reachable enough to accept
the request and return a valid inventory response at the observation time. It does
**not** prove free capacity, future allocation, container creation,
profile-specific startup, CDP readiness, provider authentication, or collector
success.

### Receipts remain exact history

`LastSuccessfulRuntimeReceipt` has this minimum identity shape:

```ts
{
  connection_id: string;
  connector_id: string;
  profile_key: string;
  run_id: string;
  surface_subject_id: string;
  surface_id: string;
  lease_id: string;
  generation: number;
  lifecycle: ["ready", "succeeded", "released"];
  completed_at: string;
}
```

It is admitted only when one ordered record proves the exact lifecycle above for
the same connection, profile, run, surface subject, surface, lease, and generation,
and when `completed_at` is not future and is within the bounded age. Any
connection, profile, run, surface-subject, surface, lease, generation, order, or
age mismatch rejects the receipt. It describes a past successful runtime and has
no headline authority.

### Every replacement has a causal, two-phase, non-secret receipt

The reference implementation owns an append-only process-replacement ledger. Its
single closed `cause` enum is exactly:

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

This maps the installed public `StopBrowserSurfaceRequest` reasons losslessly:
`capacity_pressure` and `idle_ttl` retain their literals; `operator` maps to
`operator_requested`; `reconcile` maps to `restart_reconcile`; and
`surface_failed` maps to `readiness_invalidated`. The remaining three causes cover
allocator-internal `ensureSurface` replacement, browser-generation change in the
same container, and honestly observed external or host loss. The current allocator
cannot reliably distinguish every exited/missing/host-loss subtype, so it SHALL
record `external_or_host_loss` rather than invent a narrower cause. Unknown
causality SHALL NOT be called a policy cause.

The Luna acceptance branch's six literals are provisional test-fixture vocabulary,
not this ledger's public or persistent authority. Luna compatibility work SHALL
update those fixtures to the exact eight literals above; it SHALL NOT collapse idle
TTL or readiness invalidation into capacity or operator causes.

Each replacement begins with a `phase: "started"` receipt. It resolves once to
`phase: "completed"` only after the new process generation is observed, or to
`phase: "terminal"` with a truthful non-completion outcome (`failed` or
`abandoned`). A start record is never silently treated as completion. The minimum
receipt includes `replacement_id`, a stable `idempotency_key`, `connection_id`,
`profile_key`, `surface_subject_id`, relevant run/lease/surface/generation
correlation identifiers, `cause`, `phase`, `observed_at`, and old/new
process-generation hashes where observed.

Generation hashes SHALL be one-way redactions produced by the RI and SHALL NOT
contain raw process IDs, raw container IDs, cookies, tokens, profile content, or
provider response bodies. Replaying the same idempotency key returns the original
receipt; a replay with contradictory immutable fields is rejected. SQLite and
Postgres preserve the same keys, ordering, redaction, terminality, and
connection-isolation semantics.

`CurrentReplacementReceipt` is a selection, not merely the newest row. For a live
replacement it selects the unresolved `started` receipt in the current connection
and surface-subject scope. For a completed replacement it selects only a receipt
whose next-generation hash matches the current observed process generation. A
terminal or non-matching historical row is not current. Ties are resolved by the
ledger's deterministic persisted order and `idempotency_key`, never by an
unscoped timestamp. The selection may explain the continuity overlay; it does not
prove a ready surface, provider session, or healthy headline.

The RI surfaces this internal evidence by joining the ledger into
`current_replacement_receipt` and its own allocator metadata/projection adapter.
It does not change the standalone remote-surface repository/package or its public
API.

### Credential-continuity overlay and OPEN handoff

For a process-bound credential, `replacement_pending`, `rehydration_false`, or
`indeterminate` is not green and creates no owner action. Only a typed,
auditable `ProviderInvalidationProof` can create the existing connection-scoped
repair action:

```ts
{
  kind: "provider_invalidation_proof";
  provider: string;
  connection_id: string;
  evidence_id: string;
  observed_at: string;
  verified: true;
}
```

The proof is connection-bound, provider-originated, and non-secret. Free-form
strings, a replacement receipt, false or indeterminate exact probes, and DOM, URL,
title, or profile heuristics are not proofs. Deduplicate a repair by connection and
proof identity, so a proof yields at most one repair for that connection.

Portable authenticated-session continuity remains **OPEN / UNSATISFIED**. Its
implementation handoff has three exact owners:

1. `packages/polyfill-connectors` owns the provider adapter and its exact
   provider-authentication probe.
2. `reference-implementation/runtime` owns fencing, checkpoint, replace,
   restore, probe ordering, and projection orchestration.
3. A separately authorized encrypted connection-scoped secret-session store owns
   approved session material. This change neither designs its schema nor claims it
   closed.

The acceptance gate remains OPEN: force process/container replacement independently
for two isolated process-bound connections, prove no cross-connection material or
result leaks, run each connector's exact authenticated-session probe after restore,
and prove no false owner action. For ChatGPT, HTTP 200 from `/api/auth/session`
with no `user` is probe false. URL, DOM, title, and persisted-profile heuristics
are rejected.

## Alternatives

- Treat a released success as current health. Rejected: it revives historical
  authority and hides current allocator loss.
- Require one warm surface for dynamic health. Rejected: it turns scale-to-zero
  latency/cost policy into false unavailability.
- Immediately create browser-session repair after every process loss. Rejected:
  process loss does not prove provider invalidation and creates false owner work.
- Add generic session export/import to the remote-surface package. Rejected:
  session material belongs to the provider credential boundary, not a host-neutral
  surface package.

## Acceptance Checks

- Parameterized H-E-B and Reddit cases prove dynamic no-demand plus one fresh
  allocator observation is eligible with zero idle surfaces, without claiming
  overall connection health is green.
- Receipt mismatches, stale observations, historical rows, and active lease
  failures never become green authority.
- The replacement ledger covers the one exact cause enum, two receipt phases,
  deterministic idempotency, redaction, current-generation selection, and
  SQLite/Postgres parity, including isolated simultaneous replacements.
- Provider invalidation needs the typed proof and creates at most one
  connection-scoped repair; false/indeterminate probes and DOM/profile heuristics
  create none.
- The forced two-connection portable-continuity gate stays visibly OPEN / UNSATISFIED
  and is not marked complete by this change.
