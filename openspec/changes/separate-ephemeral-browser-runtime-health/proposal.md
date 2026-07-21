## Why

H-E-B and Reddit both completed successful browser-backed collection, but their
released surfaces were correctly excluded from current health authority. The
result exposed two separate facts that the current headline conflates: a dynamic
allocator can be usable with zero warm surfaces, while a historical ready/release
receipt is not proof that a current surface—or an authenticated process-bound
session—exists.

The ChatGPT replacement evidence makes the second boundary material. A new browser
process can retain a profile yet fail the provider's authenticated-session probe.
That ambiguity must not turn green, and it must not manufacture an owner repair
action before provider evidence proves invalidation.

## What Changes

- Define a connection-scoped ephemeral-browser runtime projection with stable,
  implementation-facing names for surface mode, allocator observation, active
  demand/lease execution, current compatible idle capacity, process-bound
  credential continuity, `last_successful_runtime_receipt`, and
  `current_replacement_receipt`. Its `health_eligible` result applies only to the
  runtime axis; it is not the connection's overall collectability or headline.
- Make ordinary dynamic no-demand health-eligible when a fresh, non-allocating
  allocator observation succeeds, even with zero idle surfaces. Keep static
  absence unavailable, unmanaged/non-browser N/A, and current active failures
  fail-closed.
- Make history visible but non-authoritative: no success TTL, retired-row revival,
  or stale-while-revalidate green. Bound each full refresh to one `listSurfaces()`
  observation and one snapshot cache.
- Add an append-only, non-secret, connection-scoped process-replacement ledger
  with two-phase receipts, deterministic idempotency, generation redaction,
  SQLite/Postgres parity, and two-connection isolation. Its one closed cause set
  is `capacity_pressure`, `idle_ttl`, `operator_requested`,
  `restart_reconcile`, `readiness_invalidated`,
  `allocator_internal_ensure_surface`, `same_container_browser_generation_change`,
  and `external_or_host_loss`. The standalone remote-surface package is unchanged.
- Amend the active credential-boundary retention change so genuine process loss is
  continuity-indeterminate—not an immediate owner repair. Preserve an explicit
  OPEN handoff for portable authenticated-session continuity.

## Capabilities

Modified:

- `reference-connection-health`
- `reference-implementation-architecture`
- `polyfill-runtime`

## Out of Scope

This change does not create, select, store, export, import, or deploy portable
authenticated session material. The separately authorized encrypted,
connection-scoped session store remains an OPEN cross-boundary handoff.
