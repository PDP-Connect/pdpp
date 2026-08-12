## Context

The collector currently commits a supplied STATE delta and separately posts terminal facts. This change retains one durable item and one endpoint, but turns that endpoint into an idempotent transaction over state, terminal evidence, and run history.

## Goals / Non-Goals

**Goals:** one durable local item before any remote cursor acknowledgement; exact replay after response loss; fail-closed conflicts; one transaction on both backends; safe legacy migration.

**Non-Goals:** infer old terminal facts, change batch semantics, or make legacy state-only checkpoints terminal.

## Decisions

### Versioned canonical envelope and durable receipt

The terminal item contains a versioned canonical envelope. Its SHA-256 is over canonical JSON with lexicographic object keys; terminal facts sort by normalized stream and each status set sorts/deduplicates. The server recomputes the hash; it never trusts a client hash. The envelope binds commit/run id, authenticated device id, path/body source instance id, canonical connector id, resolved connector instance id, complete supplied state delta, normalized facts, and collection boundary. The collector resolves the canonical connector id before persisting the item; the endpoint rejects aliases instead of hashing two names for one connector.

The reference persists a receipt in the terminal spine event data: version, hash, all bindings, and the exact response. Physical receipt and PostgreSQL lock identity hash the full authorized run binding (device, source, canonical connector, resolved connection, run), excluding the caller-supplied commit id. The same run binding plus the same commit id and hash returns that stored response without writes. A different commit id or canonical body for that run binding returns typed non-retryable `409 terminal_run_commit_conflict`, with no mutation or prior-result disclosure. The same caller commit id in a different authorized namespace is independent.

Local collector run ids are collector-minted: no server run-admission row exists before the first terminal commit. The authenticated device and resolved source/connection therefore authorize the first use, which durably binds that run id in the receipt. Authorization and connection resolution happen before any receipt lookup; later reuse under a different device, source, connector, or resolved connection cannot read the incumbent response and fails as not-found/permission/conflict according to the already-authorized namespace.

### Supplied delta semantics

The vector is a complete representation of this run's supplied STATE delta, not a replacement of all connector state. The transaction upserts every supplied valid non-reserved stream entry and preserves omitted entries. A successful terminal run with valid facts creates terminal work even for an empty state map. The stored receipt, not later connector state, is replay authority.

### One transaction-aware backend seam

After device/path/source authorization resolves the canonical connector and connector instance, one SQLite immediate transaction / one PostgreSQL transaction client: verifies or inserts the receipt event, upserts the supplied state delta, appends exactly one `run.completed` spine row, and writes its run-history projection. PostgreSQL must use transaction-aware spine/run-history helpers, never nest the existing helper transaction. A fault after any state row, event insert, or run-history write rolls back every surface.

### Durable local ordering and taxonomy

Outbox schema v3 is mandatory and non-lossy for v1/v2 files. `terminal_run_commit` is predecessor-gated behind record/gap rows. New collectors never fall back to old separate PUT/terminal paths. 408/429/5xx/timeout/transport remain retryable; malformed/auth/not-found/conflict are terminal operator-actionable `terminal_run_commit_*` failures, never child failure.

### Compatibility retirement

Old separate state/terminal routes are non-atomic compatibility only. State-only checkpoint eligibility is exactly: no terminal facts are being asserted. The legacy terminal event carries durable, versioned protocol telemetry; retirement is not before 2026-11-12 and also requires no supported collector version using it plus a compatibility-window oracle. Receipt data is in `spine_events`, already covered by SQLite/Postgres backup/restore inventories; the change adds no table, and restore tests must prove replay.

## Risks / Trade-offs

- [Receipt in spine event] → response is self-contained and backup-covered; test exact replay after later state changes.
- [Concurrent duplicates] → unique event id plus transaction-aware conflict lookup; test same and divergent envelope races on both backends.
- [Old binary sees v3 outbox] → refuse safely with explicit upgrade guidance; migration never drops pending rows.

## Migration Plan

Server first, collector second. Migrate local outboxes v1/v2 to v3 before accepting new terminal work. Endpoint rollback leaves durable v3 work retryable after restoration; it must not route it through legacy endpoints.
