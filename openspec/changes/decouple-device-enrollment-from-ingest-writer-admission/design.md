## Context

`POST /_ref/device-exporters/enroll` exchanges a one-time enrollment code for a
device credential. It is the onboarding path for local collectors (Codex CLI,
Claude Code). It ran into two proven, live failures on the deployed `cd12c8078`
instance (Postgres backend, `pg_try_advisory_lock` observed).

The enroll-critical source files are **byte-identical** between the deployed SHA
`cd12c8078` and the current worktree baseline `a85873732` (verified with
`git diff --quiet`), even though the deployed tip is 29 commits ahead — those 29
commits are Gmail/USAA/Chase/health/recovery fixes that do not touch enrollment.
So a fix on the current baseline transfers to the deployed runtime with no delta
risk on the touched files.

## Causal trace (hand-verified)

The enroll handler (`ref-device-exporters.ts:1491`) makes these ordered calls:
`findEnrollmentByCodeHash` → `createDevice` → `createCredential` →
`resolveEnrollmentSourceKind` → **`ensureReferenceConnectorCatalogEntry`** →
`upsert` (connector instance) → `upsertSourceInstance` → `consumeEnrollmentCode`
→ `res.json({ device_token, ... })`.

**Only one call reaches the ingest writer-admission gate:**
`ensureReferenceConnectorCatalogEntry` (`index.js:848`, fires for canonical keys
`codex` / `claude-code`) → `registerConnector(manifest)` **with no options** →

- `lexicalIndexBackfillForManifest` (`search.js:758`): resolves at least one
  connector-instance id (falls back to a synthetic default-account id when the
  fresh instance has no records) → `withConnectorInstanceWrite` (`search.js:791`)
  → `acquirePostgresAdvisoryLock` → `SELECT pg_try_advisory_lock`.
- `semanticIndexBackfillForManifest` (`search-semantic.js:1527`): same fence when
  a semantic backend is configured.

`withConnectorInstanceWrite` (`connector-instance-write-coordinator.ts:324`) is
the SAME per-instance admission gate (default 4 active / 16 queued via
`PDPP_INGEST_ACTIVE_BATCH_LIMIT` / `PDPP_INGEST_ADMISSION_QUEUE_LIMIT`) and
Postgres advisory lock that bulk record ingest holds. So enrollment contends on,
and can be starved by, unrelated bulk ingest:

- gate saturated + advisory lock held → enroll blocks in `acquirePostgresAdvisoryLock`'s
  retry loop → the observed **client hang with an idle Postgres session** (idle
  after `SELECT pg_try_advisory_lock`); when the client is killed, the backend
  logged no completed enroll and the code stayed pending — consistent with a hang
  *before* `consumeEnrollmentCode`.
- gate/queue full → `ConnectorInstanceAdmissionError` (`connector_instance_busy`)
  bubbles out of `handleError` as an untyped **HTTP 500**.

This backfill is a **no-op for a fresh enroll**: the just-created instance has no
records to index. The record-sort backfill (`postgresBackfillRecordSortPositionsForManifest`,
`postgres-records.js:446`) is *also* fenced, but it enumerates
`SELECT DISTINCT connector_instance_id FROM records` first — zero rows for a fresh
enroll → it never enters the fence. The catalog-row persistence
(`persistManifestAndAdvanceGenerations`, `auth.js:1608`) uses its own bounded
`withPostgresTransaction` and does **not** take the writer fence.

**Second, independent defect (credential loss):** the one-time `device_token` is
returned only in the final `res.json`. `consumeEnrollmentCode` (`ref-device-exporters.ts:1578`)
flips the code `pending → consumed` before the response is flushed. If the socket
fails after commit but before the client persists the token, the code is spent,
the device/credential rows exist, and the token is unrecoverable (only its hash is
stored). This is the reported "a previous code was consumed without returning
credentials." Because the server cannot know whether a committed response reached
the client, the correct pattern is an **idempotent re-enroll response**, not a
tighter transaction alone.

## Decisions

### D1 — Skip retrieval-index backfill at enroll (fixes the proven starvation)

`ensureReferenceConnectorCatalogEntry` calls
`registerConnector(localCollectorManifest, { backfillRetrievalIndexes: false })`.
The `backfillRetrievalIndexes: false` option already exists (`auth.js:2547`) and
short-circuits exactly the lexical + semantic backfill that enters the writer
fence. Everything enroll actually needs — the persisted catalog row and generation
advance — still runs (unfenced). Retrieval-index maintenance is not lost: it
already happens on the ingest write path and on any real manifest (re)registration;
a fresh enroll indexes nothing regardless. This is the smallest change that
removes the enroll → writer-fence coupling.

### D2 — Idempotent re-enroll with strict safeguards (fixes credential loss)

When `findEnrollmentByCodeHash` returns a code whose status is `consumed`, the
handler treats the request as a **retry of the same enrollment** rather than an
error, but ONLY under all of these safeguards:

- The code is **unexpired** (expiry is still enforced; an expired consumed code is
  revoked and rejected `410`, same as an expired pending code).
- The retry resolves the **same device** already bound to that code
  (`enrollment.deviceId`), and that device is **not revoked**.
- The credential is **atomically rotated**: all of the device's non-revoked
  credentials are revoked and exactly one fresh credential is created, so a retry
  yields a single current token and invalidates any previously issued token —
  active credentials never accumulate.
- **No second device and no second source instance** are created; the existing
  connector-instance / source-instance rows are reused (the upserts are keyed on
  device + binding and are idempotent).
- An **audit receipt** is emitted (`emitSpineEvent`, event type
  `device.enroll.credential_rotated`) recording the rotation.

A `pending` code follows the existing first-enrollment path unchanged. A retry
with a different binding/device, or after expiry, is rejected — it is not the same
enrollment. This is the industry idempotent-response pattern (Stripe-style: the
client's transport failure must be safely retryable without duplicating the
side-effect), narrowed to the one legitimate retry.

Security: the token remains a high-entropy one-time secret stored only as a hash;
rotation issues a new secret and invalidates the old, so nothing weakens the
one-time property and no plaintext is ever stored.

### D3 — Typed retryable backpressure instead of a misleading 500

The enroll handler catches `ConnectorInstanceAdmissionError`
(`code === "connector_instance_busy"`) and returns **HTTP 503** with a typed
`retryable: true` body and a `Retry-After` header, instead of letting it fall
through to an untyped 500. After D1 the enroll should no longer hit the fence, so
this is defense-in-depth for any future fenced call on the enroll path and makes
the collector's retry behavior correct-by-contract.

## Scope discipline

The proven live cause is D1 (starvation). D2 fixes a separately-proven data-loss
defect the owner actually hit. D3 is a cheap, correctness-improving mapping at the
same seam. No cross-store request-transaction rewrite is introduced (that would
require threading a shared client through every device-exporter and
connector-instance store method — large blast radius, not systemic-minimal). The
idempotent-response pattern (D2) achieves the same no-loss guarantee at the route
boundary.

## Test oracle

- **Concurrency oracle (D1):** a full-server integration test on Postgres holds
  the connector-instance writer fence for the enroll's connector, saturating the
  admission gate, then drives a real enroll. Before D1 this reproduces the live
  failure (hang → admission error / 500). After D1 the enroll completes promptly
  and returns `201` with a `device_token`, proving enroll no longer contends on the
  ingest writer fence.
- **Idempotency oracle (D2):** enroll once (code consumed, token T1). Re-POST the
  same code → `201` with a new token T2 ≠ T1, the SAME `device_id` and
  `connector_instance_id`, exactly one active credential (T1 rejected on ingest,
  T2 accepted), and a rotation audit event.
- **Adversarial (D2):** replay after expiry → `410`; replay with a different
  binding/device → rejected; concurrent retries of the same code → at most one
  active credential and no duplicate device; the old token is invalidated after
  rotation.
- **Typed backpressure (D3):** force `connector_instance_busy` on the enroll path
  → assert `503` + `retryable: true` + `Retry-After`, never `500`.
