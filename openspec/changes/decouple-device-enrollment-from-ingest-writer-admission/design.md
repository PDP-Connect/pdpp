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
records to index. The catalog-row persistence
(`persistManifestAndAdvanceGenerations`, `auth.js:1608`) uses its own bounded
`withPostgresTransaction` and does **not** take the writer fence.

> **Correction (D4, post-deploy live counterexample on `f0a6fe0fe`):** the
> record-sort backfill (`postgresBackfillRecordSortPositionsForManifest`,
> `postgres-records.js:446`) was believed to be a no-op for a fresh enroll
> because it enumerates `SELECT DISTINCT connector_instance_id FROM records`
> first. That enumeration is scoped to the manifest's `connector_id` (`codex` /
> `claude-code`), which is **shared across every device ever enrolled for that
> connector type** — not scoped to the specific instance being created. It is
> zero rows only for the very first-ever enroll of a connector type. Once ANY
> device has ever ingested a record for `codex`/`claude-code` (the live steady
> state, not a fresh install), a subsequent enroll's `registerConnector` call
> still runs this backfill **unconditionally, before the
> `backfillRetrievalIndexes` short-circuit**, enumerates every existing instance
> under that connector_id, and takes `withConnectorInstanceWrite` for each —
> re-introducing exactly the coupling D1 set out to remove. This is the
> `503 connector_instance_busy` + idle-Postgres-session-after-`pg_try_advisory_lock`
> counterexample observed live. See D4 below.

**Second, independent defect (credential loss):** the one-time `device_token` is
returned only in the final `res.json`. `consumeEnrollmentCode` (`ref-device-exporters.ts:1578`)
flips the code `pending → consumed` before the response is flushed. If the socket
fails after commit but before the client persists the token, the code is spent,
the device/credential rows exist, and the token is unrecoverable (only its hash is
stored). This is the reported "a previous code was consumed without returning
credentials." Because the server cannot know whether a committed response reached
the client, the correct pattern is an **idempotent re-enroll response**, not a
tighter transaction alone.

> **Third, independent defect (D5, post-deploy live counterexample on
> `ace356a7d`): a PENDING-code partial write, not a consumed-code response loss.**
> A live retry of the same still-`pending` code returned `HTTP 500` /
> Postgres `23505 duplicate key value violates unique constraint
> "connector_instances_pkey"`. Causal sequence: a first enroll attempt reached
> identity creation (`createDevice`, `createCredential`, the connector-instance
> `upsert`, `upsertSourceInstance` all committed) and then failed — most
> plausibly the D4-fenced writer-pressure path, before D4 shipped, or any other
> failure between identity creation and `consumeEnrollmentCode` — leaving the
> code `pending` while the identity rows persisted, durably orphaned.
>
> `performFirstEnrollment` generated `deviceId`/`sourceInstanceId` via
> `generateSpineId(...)` — `randomBytes(8)`, a **fresh random value on every
> call**. `connector_instances.connector_instance_id`, by contrast, is
> **deterministic**: `makeConnectorInstanceId(ownerSubjectId, connectorId,
> sourceKind, sourceBindingKey)` (`connector-instance-utils.ts`), independent of
> `deviceId`. So retrying the still-pending code re-ran
> `performFirstEnrollment` from scratch: it minted a brand-new random
> `deviceId` (no way to know a device already existed for this code) but
> recomputed the SAME `connector_instance_id` as the orphaned first attempt —
> and the connector-instance `upsert`'s `ON CONFLICT(owner_subject_id,
> connector_id, source_kind, source_binding_key) DO UPDATE` target is the named
> UNIQUE constraint, not the `connector_instance_id` PRIMARY KEY; a second
> `INSERT` computing the identical PK value under a genuinely concurrent write
> (or certain retry timings) can still race the PK check ahead of the named
> unique-constraint conflict resolution, producing `23505` on
> `connector_instances_pkey` directly. D2 does not help here: it only
> activates when `enrollment.status === "consumed"` (`handleIdempotentReEnroll`
> reads `enrollment.deviceId`, which is `NULL` on a still-pending code) — this
> is a **pending-code partial write**, a distinct failure class from D2's
> consumed-code response loss. See D5 below.

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

### D4 — Gate the derived-column repair backfill behind the same flag as retrieval-index backfill (closes the D1 residual coupling)

Live counterexample (post-deploy, `f0a6fe0fe`): a direct enroll POST returned a
typed `503 connector_instance_busy` while the fresh code remained pending, with
`controller_active_runs=0` and an idle Postgres session after
`SELECT pg_try_advisory_lock` — the exact D1 symptom class, on code that had
already shipped D1. Deterministically reproduced: enroll+ingest one record for a
first `codex` device (so `records` has a row under `connector_id=codex`), hold
the writer-admission gate on that first device's `connector_instance_id`, then
enroll a *second*, independent `codex` device. Before D4 the second enroll blocks
on/rejects from the held fence; after D4 it completes promptly.

`registerConnector` (`auth.js`) runs `postgresBackfillRecordSortPositionsForManifest`
(Postgres) / `backfillSqliteRecordSemanticTimesForManifest` (SQLite)
**unconditionally, before** the `options.backfillRetrievalIndexes === false`
short-circuit that D1 added. Both functions enumerate every
`connector_instance_id` already holding records under the manifest's
`connector_id` and take `withConnectorInstanceWrite` — the same fence bulk
ingest holds — for each one found, regardless of the option enroll already
passes.

**Fix:** move both derived-column-repair calls behind the same
`options.backfillRetrievalIndexes !== false` gate that already guards the
lexical/semantic retrieval-index backfill (`auth.js`, `registerConnector`). A
caller that opts out of retrieval-index maintenance because it is
re-registering an unchanged manifest has no derived-column
(cursor/primary-key/semantic-time) drift to repair either — the same
"unchanged manifest ⇒ nothing to backfill" reasoning D1 already applied to
retrieval indexes applies identically here. Verified against every existing
`backfillRetrievalIndexes: false` caller's actual need:

- **Enroll** (`ensureReferenceConnectorCatalogEntry`, both `index.js` and
  `reference-local-connector-catalog.ts`): registers the static, unchanged
  local-collector manifest — no drift, ever.
- **Manifest reconcile, invalidation path** (`polyfill-manifest-reconcile.ts`,
  the `invalidatePriorRecords` → `applyShippedManifest` sequence): deletes all
  prior records for the connector *before* re-registering, so there is nothing
  left to backfill regardless.
- **Manifest reconcile, other paths** (`applyShippedManifest`'s other two call
  sites): already explicitly opt out of index maintenance; the caller's own
  intent is "no fenced maintenance on this registration."

The Postgres manifest-cache invalidation (`invalidatePostgresRecordManifestCache`)
is NOT fenced and is kept regardless of the flag, so manifest-shape caching
stays coherent even when the fenced repair is skipped. Real, user-driven
manifest changes (`POST /connectors`, no `backfillRetrievalIndexes` option
passed) are unaffected — they still get both the retrieval-index backfill and
the derived-column repair.

No change to D1/D2/D3's behavior or wire contracts. D2 (idempotent re-enroll)
and D3 (typed 503) are preserved unmodified and re-verified green.

### D5 — Pending-code partial-write idempotency (closes the pending-code partial-write gap; superseded design, see D6 correction)

Live counterexample (post-deploy, `ace356a7d`): retrying the same still-
**pending** code returned `HTTP 500` / Postgres `23505 duplicate key value
violates unique constraint "connector_instances_pkey"`. Root cause: a first
enroll attempt reached identity creation (device, credential, connector
instance, source instance all durably written) then failed before
`consumeEnrollmentCode`, leaving the code pending while identity persisted.
`deviceId`/`sourceInstanceId` were random per call, but
`connector_instances.connector_instance_id` is deterministic from `(owner,
connector, source_kind, source_binding_key)` — retrying regenerated random
device identity but recomputed the SAME connector-instance id as the orphan,
colliding. D2 did not cover this: it only activates for a `consumed` code.

**D5's original fix** derived `deviceId`/`sourceInstanceId` deterministically
from `enrollment.enrollmentCodeId` (the code row's own id). This made a retry
of the *same code* converge cleanly, and was verified as such. It was
**superseded before shipping** (see D6) once a live counterexample proved it
moved the hole rather than closed it for the *actual* live remediation path —
a fresh code, not a retry of the failed one. The rest of D5's contributions
survive into D6 unchanged: the credential-rotation-not-plain-insert fix for
concurrent first-attempt races, and the raw-`23505`-to-typed-503 defense in
depth in `respondEnrollError`.

### D6 — Stable-binding identity key, adopt-orphan-only, durably serialized (fix-enroll-stable-binding-identity-key)

**Second live counterexample, mid-turn correction to D5:** the original
pending code from the D5 incident expired (`2026-07-25T04:50:12Z`) while its
partial device/source/connector identity remained. The owner cannot retry an
expired code — the only real remediation is a **fresh code** for the same
physical collector (same connector + same `local_binding_name`). D5's
code-id-keyed derivation meant a fresh code derives a **different**
`deviceId`/`sourceInstanceId` than the expired code's orphan (different
`enrollmentCodeId` input to the hash) — while `connector_instances` stays
keyed on the STABLE `(owner, connector, binding)` tuple, independent of the
code. So a fresh code would still collide on `connector_instances_pkey`
(D5 did not actually fix this class), or — worse, once D5's early revert
attempt swapped `createDevice` to `ON CONFLICT DO NOTHING` — silently leak a
**second**, permanently-orphaned device with its own active credential that
nothing would ever clean up, requiring manual DB intervention to notice or
fix.

**Fix: key identity resolution off the STABLE binding, not the ephemeral
code.** `resolveOrCreateEnrollmentDevice` (new store method, both backends)
looks up an existing **orphaned** device for `(ownerSubjectId, connectorId,
localBindingId)` — a device with a `device_source_instances` row for that
exact binding but **no enrollment code ever successfully consumed for it**
(`NOT EXISTS (... device_enrollment_codes WHERE device_id = ... AND status =
'consumed')`) — and adopts it if found; otherwise creates a fresh device.
Ambiguity (more than one orphan candidate — should be structurally
unreachable given this method is the sole writer under its own lock, but the
query is defensive) **fails closed** by throwing, never guesses.

**Critical distinction preserved from a PRE-EXISTING, intentional product
test** (`device-exporter-routes.test.js`: "re-enrolling the same connector +
local_binding_name resumes one stable connector_instance", predates this
entire change): a genuinely **new** enrollment for an **already-completed**
binding — a live device with at least one *consumed* code — is explicitly
**NOT** adopted. That case always mints a fresh device, resuming only the
stable `connector_instance` (D5's original binding-keyed-everything design
would have broken this pre-existing, deliberately-tested contract; the first
D6 draft did break it, caught by re-running the full regression suite, and
was corrected to the orphan-only adoption rule below before landing). Orphan
eligibility is therefore load-bearing and precise:
- exact `owner_subject_id` + `connector_id` + `local_binding_id` match
- the device/source-instance are not revoked
- **no** enrollment code has ever been successfully consumed for that device

**Durable serialization, not a process-local lock.** The lookup-then-create
decision is itself a race: two genuinely concurrent enroll attempts for the
same still-empty binding could both observe "no orphan" and each create a
distinct device before either commits, since neither has written anything yet
for a per-device lock (`rotateDeviceCredential`'s `SELECT ... FOR UPDATE`) to
serialize on. On Postgres, `resolveOrCreateEnrollmentDevice` wraps the
lookup-and-create in one transaction that opens with
`pg_advisory_xact_lock(hash(owner, connector, binding))` — a durable,
database-backed lock, auto-released on commit/rollback, in a namespace
(`pdpp:enrollment-binding-identity:v1:`) distinct from
`connector-instance-write-coordinator.ts`'s ingest-admission advisory-lock
keyspace so the two fences can never accidentally couple. On SQLite,
better-sqlite3's synchronous, single-connection execution model already
provides the same exclusivity — no explicit lock needed (documented in the
method itself, not left implicit).

**The placeholder source-instance row must be created inside the SAME lock as
the device.** The orphan-eligibility query requires a `device_source_instances`
row to exist (that is where `connector_id`/`local_binding_id` live —
`device_exporters` alone does not carry them). If that row were created later,
outside the lock, by the caller's own (unlocked) `upsertSourceInstance` call —
as an early D6 draft did — a concurrent second attempt's lock acquisition
could land in the window between the first attempt's device-only commit and
its later source-instance write, see no orphan, and create an independent
second device. `resolveOrCreateEnrollmentDevice` therefore inserts BOTH
`device_exporters` and a placeholder `device_source_instances` row
(`connector_instance_id NULL`) atomically when creating fresh identity; the
caller's subsequent `upsertSourceInstance` call fills in the real
`connector_instance_id` afterward via its own existing `ON CONFLICT` target.

**The dispatch-level `!consumed` fallback needed re-deriving, not reusing D5's
assumption.** With code-id-keyed identity (D5), a concurrent loser's own
freshly-written device was BY CONSTRUCTION identical to the winner's — the
fallback could unconditionally treat any `!consumed` outcome as "same
identity, race for consume" and resolve it via `handleIdempotentReEnroll`.
With binding-keyed, adopt-orphan-only identity (D6), that assumption no
longer holds in general: `handleIdempotentReEnroll`'s binding-match check
alone cannot distinguish "this really is the winner's device" from "this is a
same-binding orphan that also happens to have a live source instance for this
binding" (`performFirstEnrollment` always writes one, win or lose) — the two
look identical to that check. The route now re-reads the enrollment code's
actual bound `device_id` after a failed consume and only treats it as the D2
resume case when it matches; otherwise it explicitly revokes the losing
attempt's own device before rejecting, so no active credential for an
abandoned device survives the request.

**Explicit rejection of a declined D2 resume**, not a fall-through. A
`consumed` code that `handleIdempotentReEnroll` declines (revoked device;
structurally-unreachable binding mismatch) must never reach
`performFirstEnrollment` — a `consumed` code can never be claimed by
`consumeEnrollmentCode` (`WHERE status = 'pending'`), so falling through would
create a brand-new, permanently-unclaimable orphan device whose own
`resolveOrCreateEnrollmentDevice`/`rotateDeviceCredential` would succeed
*before* the doomed consume attempt is even reached — silently masking the
decline as a `201` success. `respondIfConsumedCodeReplay` makes this an
explicit, immediate rejection instead of relying on a later write to fail.

**Defense-in-depth (unchanged from D5): map raw Postgres `23505` to a typed
retryable `503`** (`enrollment_identity_conflict`, `Retry-After: 1`) in
`respondEnrollError`, alongside the existing `connector_instance_busy`
mapping. The binding-keyed identity + durable-lock fix above should make a
unique-violation unreachable on this route in practice; this is the same
class of defense-in-depth D3 already established.

### D7 — Qualify the binding-identity key by sourceKind (fix-enroll-source-kind-identity-gap)

**Independent-gate finding, not a live counterexample:** D6's stable-binding
key — `(ownerSubjectId, connectorId, localBindingId)` — omits `sourceKind`.
`connector_instances` (the pre-existing store D6's key was modeled on) is
itself keyed on FOUR parts: `(owner_subject_id, connector_id, source_kind,
source_binding_key)` (see `add-browser-collector-enrollment-primitive`
Decision 1 — `local_device` and `browser_collector` are peers on the same
binding axis, not a hierarchy). D6's key silently dropped the fourth part.
Concretely: `resolveOrCreateEnrollmentDevice`'s advisory-lock hash material
and its orphan-eligibility query joined only `device_source_instances` +
`device_exporters` on owner/connector/binding; `sourceKind` was resolved in
the ROUTE only *after* the identity decision (`performFirstEnrollment`
called `resolveEnrollmentSourceKind` after
`resolveOrCreateEnrollmentDevice`, not before). A `local_device` orphan
(identity created by a partial write, never consumed) could therefore in
principle be adopted by a later `browser_collector` enrollment sharing the
same owner, connector, and binding name — merging two structurally distinct
connector-instance kinds into one device identity. Unreachable today only
because `sourceKind` is currently a pure function of `connectorId` (a given
connector's manifest declares exactly one of `filesystem`/`browser`, never
both — `resolveEnrolledSourceKind` in `connector-source-kind.ts`), so no
single `connectorId` can drive both branches in the current connector
catalog. The gap is real at the KEY-DESIGN level regardless: nothing in the
identity/lock mechanism itself enforces the invariant, so a future connector
whose manifest resolution changes, or a regression in
`resolveEnrolledSourceKind`, would silently reopen it. Per explicit
instruction, this is fixed as a systemic correction to the identity contract,
not deferred as "unreachable in practice."

**Fix: `sourceKind` becomes the fourth part of the identity key, resolved
BEFORE the identity decision.** `performFirstEnrollment` now calls
`resolveEnrollmentSourceKind` first, then passes the resolved `sourceKind`
into `resolveOrCreateEnrollmentDevice`. That method's contract is now keyed
on `(ownerSubjectId, connectorId, sourceKind, localBindingId)` end-to-end:

- **Lock material:** `advisoryEnrollmentBindingKey` takes `sourceKind` as an
  explicit parameter and folds it into the SHA-256 hash input
  (`...v1:\0` + `owner\nconnector\nsourceKind\nbinding`), so a
  `local_device` and a `browser_collector` enrollment sharing owner,
  connector, and binding name serialize on DISTINCT advisory-lock keys —
  each kind's identity decision is independent, never blocked by or racing
  against the other's.
- **Orphan eligibility:** a new `source_kind` column on
  `device_source_instances` (both backends, additive migration —
  `ADD COLUMN IF NOT EXISTS source_kind TEXT` on Postgres,
  `addColumnIfMissing` on SQLite, following the exact established pattern
  the table's other post-hoc columns already use) is written by
  `resolveOrCreateEnrollmentDevice`'s placeholder-row insert and by
  `upsertSourceInstance`. `find-orphaned-device-for-binding.sql` (and the
  Postgres store's inline equivalent) now predicates `dsi.source_kind = ?`
  alongside the existing owner/connector/binding predicates — an EXACT
  match, never NULL-permissive. A legacy row written before this column
  existed has `source_kind IS NULL`, which matches no candidate under exact
  equality and is therefore never adopted by ANY kind — safe by
  construction, not a special case: it simply falls through to minting a
  fresh device, exactly like any other non-matching row.

**Why a schema column, not a join-based derivation.** `connector_instances`
already carries `source_kind`, and an orphan created after the
connector-instance upsert step does have a matching `connector_instances`
row — but `resolveOrCreateEnrollmentDevice` must also cover the
placeholder-only orphan (a partial write that failed BEFORE the
connector-instance upsert ever ran, `connector_instance_id IS NULL` on the
`device_source_instances` row), which has no `connector_instances` row to
join against at all. A join-based approach would silently fail to qualify
exactly the orphan case D6 was built to handle. The additive column is the
narrower, correct fix: it reuses the exact `ADD COLUMN IF NOT EXISTS` /
`addColumnIfMissing` migration pattern this table's `connector_instance_id`,
`last_error_json`, and four other post-hoc columns already established (see
`migratePostgresDeviceExporterColumns` in `postgres-storage.js` and the
matching block in `db.js`'s `applySqliteMigrations`), touches no other
table, and requires no backfill (existing rows simply read as
`source_kind IS NULL`, which is semantically correct — they predate the
kind-tracking contract and are inert for orphan-adoption purposes, never
falsely matched).

**Scope kept minimal.** Only the two call sites the identity-decision race
actually needs — `upsertSourceInstance` (write) and
`find-orphaned-device-for-binding.sql` (read) — were changed to carry
`source_kind`. `getSourceInstance`, `getSourceInstanceByBinding`,
`listSourceInstances`, and the heartbeat queries are unrelated to the
identity-decision race and were left untouched.

### D8 — connector_instances upsert cannot migrate a legacy same-binding row keyed under a stale source_binding_key derivation (fix-enroll-connector-instance-pk-collision)

**Live counterexample, discovered after watched deploy of D1-D7:** a fresh
pending code for `(owner_local, codex, vivid-fish)` returned `503
enrollment_identity_conflict` (a raw Postgres `23505`) on **every** retry,
with no operator remediation available through the API. Root cause traced by
direct inspection of the live `pdpp` database (read-only) and confirmed by a
byte-exact reproduction:

- `connector_instances`'s identity is `UNIQUE(owner_subject_id, connector_id,
  source_kind, source_binding_key)`, with `connector_instance_id` as a
  SEPARATE `PRIMARY KEY`. `makeConnectorInstanceId` derives that PK
  deterministically by hashing `owner + connector + sourceKind +
  sourceBindingKey` — so a retried `upsert()` for the SAME logical binding,
  under the SAME key derivation, always targets the same row, and the named
  `ON CONFLICT` target absorbs every same-binding write race by construction.
- The live `vivid-fish` binding had a pre-existing, already-completed
  `connector_instances` row (`cin_da9889ea09f0132af33c2f4e`) whose
  `source_binding_key` was computed under an OLDER, larger binding shape —
  `{kind, device_id, local_binding_name, source_instance_id}` — that predates
  `deviceExporterSourceBindingIdentity`'s smaller, device-independent
  `{kind, local_binding_name}` shape. This is a **legacy key-normalization
  gap**, not two independent bindings: the row's `source_binding_json`
  itself confirms `owner_subject_id=owner_local`, `connector_id=codex`,
  `source_kind=local_device`, `local_binding_name=vivid-fish` — the EXACT
  same logical binding a fresh enroll for `vivid-fish` resolves to today.
  Because the key INPUT differs (old shape vs. new shape), the named
  `ON CONFLICT` target on a fresh `upsert()` call for this binding does
  **not** match this row under its stale key — Postgres therefore attempts a
  plain `INSERT`.
- That `INSERT`'s own `connector_instance_id` — computed by today's
  `makeConnectorInstanceId` from the CURRENT binding-identity key — happens
  to equal the legacy row's own PRIMARY KEY (the legacy row's id predates
  `makeConnectorInstanceId` and was assigned by an older mechanism, before
  ids were derived from `source_binding_key` at all). The `INSERT` therefore
  collides on the `PRIMARY KEY` — a constraint the named `ON CONFLICT` target
  does not cover — surfacing as `23505` on every retry, deterministically,
  since neither side of the collision ever changes without intervention.

**Reproduced deterministically** (not by construction from priors — by
reading the live `pdpp-postgres-1` database read-only, confirming the exact
row shapes, then recreating them byte-for-byte against a throwaway Postgres
container and driving the real enroll route): every retry against the
recreated state returns `503 enrollment_identity_conflict`, matching the
live symptom exactly.

**Fix: on a PRIMARY KEY collision, migrate the colliding row in place — but
ONLY when it is PROVABLY the same logical binding.** `upsert()` (both
backends) catches the PK-specific error — Postgres's raw `23505` on this
exact `INSERT`; SQLite's distinct `SQLITE_CONSTRAINT_PRIMARYKEY`, which
better-sqlite3 raises separately from the named-target's own
`SQLITE_CONSTRAINT_UNIQUE` — looks up the colliding row, and checks
`isSameLogicalBindingUnderLegacyKey`: same `owner_subject_id`,
`connector_id`, and `source_kind` columns, AND the `local_binding_name`
embedded in the colliding row's OWN stored `source_binding_json` matches the
binding currently being upserted. Only when this is proven does `upsert()`
`UPDATE` that row's `source_binding_key`/`source_binding_json` to the
current stable shape and return its SAME `connector_instance_id` — a
key-normalization migration, executed lazily on first collision rather than
a bulk backfill, keeping the row's identity, references, and history
completely intact. A collision against any row that does NOT pass this
check (different owner/connector/kind, or a `local_binding_name` mismatch —
i.e. a genuinely unrelated binding) re-throws the raw `23505` unmodified,
fail-closed — the existing `respondEnrollError` mapping (D3/D5) still
surfaces it as a typed retryable `503`, never silently adopted or merged.

**Explicitly rejected: a generic salted-retry id.** An earlier draft of this
fix treated every `23505` on this `INSERT` as evidence of a coincidental
hash collision against an unrelated row and retried under a fresh, salted
id — this was WRONG. The colliding row here is not unrelated: its own
`source_binding_json` proves it IS this binding, only keyed under a stale
derivation. Salting would have forked a second, permanently-duplicate
`connector_instances` row for one logical binding, silently orphaning the
original's history and violating the "one logical connector instance"
invariant this entire change exists to protect — a worse defect than the one
being fixed. **Explicitly rejected: weakening the `PRIMARY KEY` or the named
`ON CONFLICT` target.** Per explicit instruction, neither constraint may be
weakened; the fix works entirely within the existing schema, migrating the
stale key onto the existing row rather than loosening any uniqueness
guarantee. **Explicitly rejected: a cleanup script.** The fix recovers
through the ordinary enrollment API path with no operator action, matching
the live remediation path (retry the same code) exactly — no manual
database intervention or bulk backfill of legacy rows is introduced or
required; each legacy row migrates lazily, in place, the first time its
binding is next upserted.

**Preserved:** exactly ONE `connector_instance_id` per logical binding —
the legacy row survives under its own id, migrated to the current key, never
duplicated into a second row; `resolveOrCreateEnrollmentDevice`'s
source-kind-qualified orphan adoption (D7) and its durable advisory-lock
serialization (D6) are unmodified — D8 is scoped entirely to the
connector-instance key-normalization edge case, a layer below the
device-identity resolution D6/D7 already handle correctly; the pre-existing
"re-enrolling the same connector + local_binding_name resumes one stable
connector_instance" contract (`device-exporter-routes.test.js`) re-verified
green and unmodified.

### D9 — Postgres startup SHALL coalesce an equivalent stale/full-key row with its stable enrolled row (fix-enroll-post-restart-idempotency)

The local-device startup migration ran on every Postgres boot but still derived
its lookup key from `{kind, device_id, local_binding_name, source_instance_id}`.
Current enrollment uses the stable `{kind, local_binding_name}` key. A valid
enrollment can therefore leave a stable connector-instance row referenced by
`device_source_instances` beside an older full-key row whose stored binding JSON
is identical. Treating their different ids as a conflict makes restart fail;
ignoring it leaves an identity fork.

The migration now uses the stable key while retaining the full stored binding
JSON (including device and source ids), finds an obsolete full-key row only when
its stored binding JSON exactly matches the source row's full binding, and
coalesces it transactionally into the stable row. Every known owned reference is
repointed only after a per-table collision check; unknown reference tables with
legacy data, multiple equivalent candidates, mismatched binding data, or two
rows claiming the same owned key fail closed and roll back. The stale row is
deleted only after all safe repoints complete. Thus restart is re-entry-safe,
preserves state, and never chooses between non-equivalent data.

**Table semantics are explicit.** `connector_summary_evidence`, lexical index
rows/meta, and semantic index rows/meta/backfill progress are rebuildable
projections: when both ids hold one, the legacy projection is discarded and the
canonical record/manifest/evidence reconciliation rebuilds canonical truth.
Every other migration reference remains authoritative or operator/audit state:
checkpoints, records/history/version facts, blobs/bindings, detail gaps,
manifest violations, attention, schedules/runs, and device-source identity are
repointed only when their unique ownership does not collide; otherwise the
whole coalescence rolls back. Unknown reference tables with legacy data also
block deletion. This deliberately trades a rebuildable-cache refresh for no
manual DB surgery, never for authoritative data loss.

## Scope discipline

The proven live cause is D1 (starvation). D2 fixes a separately-proven data-loss
defect the owner actually hit. D3 is a cheap, correctness-improving mapping at the
same seam. D4 closes a residual coupling D1 missed — same seam, same flag, no new
mechanism. D5 closed the pending-code partial-write gap but with an identity key
(code id) that a second live counterexample proved was the wrong stable anchor.
D6 corrects it to the binding key `connector_instances` already uses, adds the
durable Postgres advisory-lock serialization the naive lookup-then-create
sequence needed, and restores the pre-existing "fresh device per completed-
binding re-enroll, connector_instance stays stable" contract D5's blanket
binding-keying would have broken. D7 completes D6's key to match
`connector_instances`' own four-part identity (adding `sourceKind`, the one
part D6 dropped) — an independent-gate finding rather than a live
counterexample, fixed as a systemic key correction (additive column,
lock-material parameter, query predicate) rather than deferred as
"unreachable given today's connector catalog." D8 is a live counterexample
one layer below D6/D7's device-identity resolution: a legacy
`connector_instances` row for the SAME logical binding, keyed under a stale
pre-D6/D7 `source_binding_key` derivation, can collide on the PRIMARY KEY
with today's deterministic id for that binding — fixed by migrating the
colliding row's key in place, in the `upsert()` call site that can hit this
collision, ONLY when the collision is proven to be this same binding (never
by touching the identity-resolution mechanism D6/D7 already got right, and
never by adopting a genuinely unrelated colliding row). No
cross-store request-transaction rewrite is introduced anywhere in this change
(that would require threading a shared client through every device-exporter
and connector-instance store method — large blast radius, not
systemic-minimal); the locked `resolveOrCreateEnrollmentDevice` method is
scoped to exactly the two tables (`device_exporters`,
`device_source_instances`) whose identity-decision race needs it, D7's
`source_kind` column addition touches only `device_source_instances`, and
D8's lazy key migration touches only `connector_instances`' own `upsert()`.
D9 is the narrow Postgres bootstrap counterpart for the already-materialized
old/new duplicate topology; it reuses the existing reference-rewrite collision
rules rather than changing enrollment identity resolution or relaxing a
constraint.
The idempotent-response pattern (D2, extended by D6) achieves the same
no-loss guarantee at the route boundary.

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
- **Second-instance concurrency oracle (D4, mutation-grade live-class):** enroll
  and ingest one real record for a FIRST `codex` device on Postgres (populating
  `records` under `connector_id=codex` for that device's `connector_instance_id`),
  hold the writer-admission gate on that FIRST device's instance, then enroll a
  SECOND, independent `codex` device while the gate is held. Before D4 this
  reproduces the live counterexample (second enroll blocks on/is rejected by the
  first device's held fence via `postgresBackfillRecordSortPositionsForManifest`).
  After D4 the second enroll completes promptly and returns `201` with a distinct
  `connector_instance_id`. This is mutation-grade: reverting D4 alone (leaving
  D1-D3 intact) makes this oracle fail while the D1 oracle above still passes,
  proving it detects the specific residual coupling D1 did not close.
- **Pending-code partial-write oracle (D5→D6, Postgres, mutation-grade
  live-class):** a test-only fault hook (`__setEnrollPhaseFaultHookForTest`,
  mirroring the file's existing `deviceIngestPhaseFaultHook` seam; production
  never installs it) throws immediately after `upsertSourceInstance` —
  identity fully durable — and before the credential rotation +
  `consumeEnrollmentCode`. First attempt: identity creation commits, the
  fault throws, the code stays `pending`. Asserts exactly one orphaned device
  row exists. Retry the SAME still-pending code with the hook cleared. Before
  D6 this reproduces the live counterexample class. After D6 the retry
  returns `201`, and the test asserts convergence on exactly ONE device / ONE
  connector instance / ONE source instance / ONE active credential, the code
  consumed exactly once bound to the resumed device, and that the returned
  token actually authenticates a heartbeat call.
- **Adversarial (D5→D6):** a pending code with NO existing device row (a
  genuine first attempt, nothing to resume) still enrolls normally through
  `performFirstEnrollment`.
- **Concurrency oracle (D5→D6, both backends):** N genuinely concurrent FIRST
  attempts (`Promise.all`, no prior successful enroll) for the same still-
  pending code. On SQLite (`withServer`, in-process) and on real Postgres with
  independent connections (the class of race single-writer SQLite semantics
  can mask): every attempt returns `201`; all converge on exactly one
  device/connector-instance/source-instance id and exactly one active
  credential (verified both by querying store state directly on Postgres and,
  on both backends, by confirming exactly one of the concurrently-issued
  tokens authenticates a heartbeat call). Mutation-grade: reverting the
  `resolveOrCreateEnrollmentDevice` advisory lock alone makes this oracle fail
  deterministically (see below).
- **Stable-binding adoption oracle (D6, Postgres, mutation-grade live-class):**
  code A reaches identity creation via the same fault hook, then its expiry is
  moved into the past (simulating real time passing without a retry — the
  exact live scenario, not a synthetic shortcut). Code A is confirmed to fail
  closed as expired (`410`, no token). A FRESH code B is minted for the SAME
  connector + local binding and exchanged. Asserts: code B succeeds and
  ADOPTS code A's orphaned device (same `device_id`, not a new one); final
  state has exactly one device / connector instance / source instance /
  active credential for the binding; code A remains `revoked` (the expiry
  check's own status transition), never consumed or resurrected; code B's own
  row is the one actually consumed; the returned token authenticates.
- **Isolation oracle (D6):** two DIFFERENT local bindings for the same
  connector never share device/connector-instance/source-instance identity. A
  FRESH code for an ALREADY-COMPLETED binding (a live device with a consumed
  code) mints a NEW device while resuming the SAME connector_instance —
  proves the pre-existing "re-enroll forks a fresh device_id, resumes the
  connector_instance" contract (`device-exporter-routes.test.js`) still holds
  under D6's orphan-only adoption rule, and that adoption never crosses
  binding boundaries.
- **Durable-lock oracle (D6, Postgres, deterministic, mutation-grade):** holds
  TWO concurrent enroll attempts for the SAME pending code at the
  `after_identity_before_consume` rendezvous — both have committed identity
  with ZERO credential rows written (the exact empty-credential-row race
  window a per-device lock cannot serialize, since it takes no lock on rows
  that do not yet exist) — releases them together, then holds them AGAIN at a
  second rendezvous (`after_rotation_before_consume`) immediately after each
  attempt's OWN `rotateDeviceCredential` call returns but BEFORE either
  consumes — the one moment before either D2's cleanup-rotation fallback can
  run and mask a defect by cleaning it up. Asserts exactly one active
  credential at that moment, then again in the final state. **Mutation-grade,
  verified deterministically:** removing `resolveOrCreateEnrollmentDevice`'s
  `pg_advisory_xact_lock` call makes this oracle fail 5/5 runs (`2 !== 1`
  devices — the lookup-then-create race the lock exists to prevent); the same
  mutation independently makes the D5→D6 concurrency oracle and the D6
  stable-binding adoption oracle fail too (3 of 4 oracles catch it; only the
  single-writer-at-a-time D6 isolation oracle does not, as expected). All
  restored and re-verified green.
- **Cross-kind isolation oracle (D7, Postgres, mutation-grade):** drives
  `resolveOrCreateEnrollmentDevice` directly (the store method under test,
  not just the route) with the SAME `ownerSubjectId` + `connectorId` +
  `localBindingId` but two DISTINCT `sourceKind` values
  (`local_device`/`browser_collector`) — exactly the scenario D6's
  three-part key could not distinguish. Asserts: (1) with no orphan or live
  device under either kind yet, each kind resolves to its OWN fresh device,
  never sharing a `device_id`; (2) after failing both attempts before
  consume (an orphan per kind), a SECOND attempt under a given kind adopts
  ONLY that kind's own orphan, never the other kind's; (3) exactly two
  independent devices exist for the shared owner+connector+binding — one per
  kind, never merged, never a spurious third. **Mutation-grade, verified
  deterministically:** reverting the Postgres orphan query's `source_kind`
  predicate (and its lock-key parameter) back to the pre-D7 three-part shape
  makes the oracle fail 3/3 runs (`browserResolved.adopted` is wrongly
  `true` — the browser-collector attempt adopts the local-device orphan);
  the same query run without the predicate independently confirms the
  underlying orphan SET itself is ambiguous across kinds (2 rows match one
  candidate slot), proving the predicate — not incidental query shape — is
  what prevents the collision. Restored and re-verified green, alongside the
  full D1–D6 Postgres suite unmodified.
- **Legacy-key-migration recovery oracle (D8, Postgres, live-class, mutation-grade):**
  recreates the exact live database state byte-for-byte: a legacy, already-
  completed `connector_instances` row for `(owner_local, codex, vivid-fish)`
  whose `source_binding_key` predates the current binding-identity key shape
  and whose id happens to equal what today's deterministic formula computes
  for this SAME binding, plus a partial-write orphan (`source_kind=
  local_device`, `connector_instance_id NULL`) for the same binding. Mints a
  fresh code for the binding and exchanges it three consecutive times.
  Asserts: every attempt returns `201` (not the live `503`); every attempt
  converges on the SAME resolved device/connector-instance/source-instance
  identity (idempotent, not a new row per retry); the LEGACY row's OWN
  `connector_instance_id` is reused (not a second, forked row); its
  `source_binding_key`/`source_binding_json` are migrated to the current
  stable shape in place; exactly ONE active connector instance exists for
  this binding (never a duplicate); the resolved token authenticates a real
  heartbeat call. A companion SQLite unit test
  (`connector-instance-store.test.js`) additionally proves the fail-closed
  path: a PK collision against a row whose own `source_binding_json` encodes
  a DIFFERENT `local_binding_name` is never adopted or migrated — the raw
  `SQLITE_CONSTRAINT_PRIMARYKEY` re-throws unmodified. **Mutation-grade,
  verified deterministically:** reverting the legacy-key-migration logic
  (Postgres backend) makes the Postgres oracle fail 3/3 runs with the EXACT
  live symptom — `503 enrollment_identity_conflict` on the very first
  attempt. Restored and re-verified green, alongside the full D1–D7 Postgres
  suite unmodified.
