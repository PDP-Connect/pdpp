## Why

Local-collector device enrollment (`POST /_ref/device-exporters/enroll`, the
Codex / Claude Code onboarding path) is a **control-plane** operation that mints
a one-time device credential. Today it is coupled to the **data-plane** ingest
writer-admission gate and is not transactional, which makes onboarding fail under
two proven, live conditions:

1. **Starvation by unrelated bulk ingest.** The enroll handler calls
   `ensureReferenceConnectorCatalogEntry` → `registerConnector(manifest)` with no
   options → `lexicalIndexBackfillForManifest` + `semanticIndexBackfillForManifest`,
   each of which takes `withConnectorInstanceWrite` — the same per-instance
   admission gate (default 4 active / 16 queued) and Postgres advisory lock
   (`pg_try_advisory_lock`) that bulk record ingest holds. When ingest saturates
   the gate, enrollment either blocks at the advisory lock (a client hang with an
   idle Postgres session — observed live on the deployed `cd12c8078` instance) or
   is rejected with HTTP 500 `connector_instance_busy`. This backfill is a **no-op
   for a fresh enroll** (the just-created instance has no records to index), so the
   enroll pays the full concurrency-fence cost for zero useful work.

2. **One-time credential loss on transport failure.** The handler performs five
   sequential, non-transactional writes and only returns the one-time
   `device_token` in the final response body. `consumeEnrollmentCode` runs
   **before** the response is flushed, so a socket failure after consume burns the
   code while never delivering the token: the device and credential rows exist, the
   enrollment code is spent, and the collector holds a placeholder `codex.env`.
   The credential is unrecoverable and the owner must mint a fresh code — the exact
   "a previous code was consumed without returning credentials" symptom reported
   live.

A 500 `connector_instance_busy` is also the **wrong error class** for transient
backpressure: it reads as a server fault, is not typed as retryable, and gives the
collector no `Retry-After` signal.

## What Changes

- **Decouple enrollment from ingest writer admission.** Device enrollment SHALL
  NOT be gated by, or contend on, the connector-instance ingest writer-admission
  queue or its Postgres advisory lock. Ensuring the connector catalog entry at
  enroll time SHALL persist the catalog row without running retrieval-index
  backfill inline (retrieval-index maintenance already happens on the ingest write
  path and via manifest (re)registration; a fresh enroll indexes nothing).

- **Make enrollment credential-safe across transport failure.** The one-time
  device credential SHALL become retrievable/idempotent so that a transport
  failure after the enrollment code is consumed does not strand the owner. The
  enrollment code and the device credential SHALL be consumed/created atomically
  with respect to each other: either the caller receives the credential, or the
  code remains usable. A retried enroll with the same enrollment code (before it
  is durably consumed) SHALL NOT create a second device or leak a second
  credential.

- **Return typed, retryable backpressure instead of a misleading 500.** When
  enrollment genuinely cannot proceed because of transient resource pressure, the
  reference SHALL return a typed retryable status (HTTP 503 with a
  `retryable`/`Retry-After` signal), never an untyped 500 `connector_instance_busy`.

- **Preserve one-time device-token security.** The device token SHALL remain a
  high-entropy one-time secret stored only as a hash; the credential-recovery
  mechanism SHALL NOT weaken that (no plaintext-at-rest, no unbounded re-issuance).

## Impact

- Affected specs: `local-device-exporter-collection` (enrollment atomicity +
  admission-independence + typed backpressure requirements).
- Affected code: `reference-implementation/server/routes/ref-device-exporters.ts`
  (enroll handler ordering + typed error), `ensureReferenceConnectorCatalogEntry`
  (skip inline retrieval-index backfill at enroll). No change to the ingest writer
  coordinator's semantics for ingest; no change to the enroll wire contract's
  success shape.
- No migration. Backward compatible: existing enrolled devices and in-flight
  enrollment codes are unaffected.
