## Why

Live Gmail attachment recovery is starved: `connector_detail_gaps` holds 10,012
`pending`/`temporary_unavailable` rows at `attempt_count = 0` (never claimed)
alongside exactly 256 rows stuck at `attempt_count = 104`, repeatedly
re-attempted on every successful 15-minute run for days, while the other
10,012 never advance.

Two independent, compounding root causes:

1. **Connector-neutral store starvation.** `listPendingGaps` (the recovery-page
   selection query in `connector-detail-gap-store.js`, both SQLite and
   Postgres backends) ordered candidates `ORDER BY created_at LIMIT
   candidateLimit`, where `candidateLimit` is bounded by the page byte budget
   (`detail-gap-paging.js`, default 256KB / ~1536 bytes/row ⇒ exactly 256
   rows). Being served for recovery (marked `in_progress`, then reset to
   `pending` by end-of-run cleanup when the connector does not recover or
   re-defer it) does not change a row's `created_at`, so the identical oldest
   256 rows sorted first on every subsequent call. Rows past the byte-bounded
   page were never read from the store at all. This is a connector-neutral
   defect: any connector whose recovery rate for a stream is below 100% per
   page, with a pending backlog larger than one page, starves every row after
   the page boundary indefinitely.

2. **Gmail never consumes served attachment gaps.** The Gmail connector emits
   `DETAIL_GAP` for a failed attachment hydration but never reads
   `START.detail_gaps` (the runtime's per-run recovery page) back — it has no
   code path that re-attempts a previously-failed attachment outside its
   normal forward per-message walk. Gmail's forward walk only visits new UIDs
   (`priorUidnext:*`); an attachment gap on an already-scanned message is
   never revisited by the ordinary pass, so even with fair store-level
   selection Gmail would still never actually recover a served gap — it would
   just cycle it back to pending every run with no progress. This is separate
   from cause 1 and would recur for any connector with the same
   ignore-served-gaps shape.

This is unrelated to the `recovered_run_id` stickiness semantics already
fixed in the deployed source (§10-A) — no gap here is stuck `recovered`; all
10,268 are `pending`, and ancestry/upsert stickiness is not implicated.

Recovered from a prior, unmerged branch (commits `bc30b04fc`, `2020c5782`,
`a496fb223`) that independently diagnosed and
fixed both causes but never landed on `main`. That branch's fix and tests are
adopted here (cherry-picked and reconciled against current `main`), plus
additional multi-run drain regression tests proving the full liveness property
across a realistic 15-minute-cadence backlog larger than one page.

## What Changes

- Change the connector-neutral recovery-page selection order in both the
  SQLite and Postgres `listPendingGaps` implementations from strict
  `created_at` FIFO to an aging-bucket order: `attempt_count` minus an age
  bonus (one bucket per 15-minute rotation window the row has waited since its
  last attempt, capped at 8 buckets / 2 hours), tie-broken by
  `last_attempt_at`/`created_at` then `gap_id`. A row served for recovery
  sorts behind never-attempted rows on the next selection once its effective
  rank exceeds theirs, AND an old row that keeps losing to a stream of
  zero-attempt fresh arrivals ages into priority over time — closing both the
  simple head-of-queue starvation and the subtler "fresh work keeps
  outranking old work forever" edge case.
- Wire the Gmail connector's attachment hydration path to consume
  `START.detail_gaps`: when a served pending `attachments` gap's attachment id
  (and, if present, message id / part index) matches an attachment that is
  successfully hydrated and emitted this run, the connector now emits
  `DETAIL_GAP_RECOVERED` with the served `gap_id` — closing the loop the store
  fix alone cannot close for Gmail. Also: a pending attachment detail backlog
  now activates the historical attachment-backfill pass (in addition to the
  existing explicit `streamsToBackfill` flag), so durable attachment gaps on
  already-scanned messages are reachable again instead of only ever being
  revisited by luck of the incremental UID window. The served-gap probe lane
  is streaming, not batch-probed: it walks START order, reuses same-message
  `X-GM-MSGID` lookups, hydrates as it goes, and caps Gmail metadata lookups at
  32 unique messages per run so provider work cannot explode ahead of byte
  admission. To keep the run visibly alive during a slow hydration, it emits a
  bounded `phase=hydrating` progress tick immediately after admission and then
  the settled progress once the record lands.
- No change to admission (`resolveRecoveryAdmission`), backoff
  (`next_attempt_after`), terminal classification, or byte/candidate-limit
  math — the WHERE clause, byte budget, and lease semantics are untouched.

### Revision (independent gate review, 2026-07-15)

An independent judge pass on the initial commit (`d66f38302`) found one
blocker: the Gmail recovery guard checked only that the attachment *record
emitted*, not that hydration *succeeded* — a `failed` (or `too_large`)
attachment still emits a record, so a served gap whose attachment failed
hydration again was wrongly acknowledged `DETAIL_GAP_RECOVERED`. Because the
store's same-run stickiness keeps a `recovered` row recovered when the
re-upserted `DETAIL_GAP` shares the same run id, and the commit-gate credits a
required key against a `pending` OR `recovered` durable gap, this would have
silently and permanently abandoned exactly the population the fix targets: a
served gap that fails again. This revision:

- Gates the `DETAIL_GAP_RECOVERED` emit on `hydration_status === "hydrated"`
  only. `too_large` is deliberately excluded even though the commit-gate
  already treats it as covered via `optional_skip_keys`: a `too_large`
  outcome is never the subject of a durable `DETAIL_GAP` in the first place
  (gaps are only ever created for `failed`), so there is nothing to recover —
  any pre-existing pending row from an earlier `failed` attempt is already
  harmless and left to age or terminalize on its own.
- Adds the missing spec-required regression: a served gap whose attachment
  fails hydration again must never emit `DETAIL_GAP_RECOVERED` and must land
  on the ordinary `DETAIL_GAP` requeue path (proven mutation-resistant against
  the pre-fix guard).
- Makes the SQLite recovery-page ordering's `last_attempt_at` fallback
  symmetric with Postgres via `NULLIF(last_attempt_at, '')` (a latent,
  currently-unreachable engine divergence the gate flagged as a nit).

### Revision (live-instance follow-on, 2026-07-21)

Live post-deploy evidence on `cin_12407c1afb78d56848fe0b20` (Gmail attachments)
found a second, subtler starvation mode the aging-bucket fix did not close:
256 rows pinned at `attempt_count = 107` (the quarantine no-progress threshold,
`DEFAULT_QUARANTINE_POLICY.maxNoProgressAttempts`, is 8), untouched for 6+
days, while 2,619 other rows kept cycling through selection every run and
7,361 more had already recovered.

Root cause: the aging-bucket rank is `attempt_count - age_bonus`, with
`age_bonus` capped at `PENDING_GAP_MAX_AGE_BUCKETS` (8). A row's own
`attempt_count` has NO ceiling, so a row repeatedly re-attempted past the
quarantine threshold accumulates a rank that gets strictly worse forever —
permanently sinking it behind any backlog with rows at a lower attempt count,
including a steady stream of fresh zero-attempt arrivals that themselves keep
aging into a better rank than the poison row can ever reach. Once starved this
way, the row is never selected again, so it can never reach
`maybeQuarantineGap` (`runtime/recovery-quarantine.ts`) either — that check
only runs when a served row is selected and re-defers. The row is stuck
`pending` forever: neither recovered nor quarantined, and invisible to the
"poison item does not block the backlog" guarantee this same change's sibling
requirement (`add-connector-neutral-recovery-governor`) already promises,
because it never gets far enough to be evaluated.

Fix: clamp the `attempt_count` term in `pendingGapOrderBySql` (both SQLite and
Postgres) at `DEFAULT_QUARANTINE_POLICY.maxNoProgressAttempts`, the same
threshold quarantine uses. A row past that threshold can never rank worse than
a row exactly at the threshold — which the existing (unchanged) age-bonus
mechanism already guarantees eventually wins selection over a continuously
arriving fresh backlog. This only ever raises (never lowers) the effective
rank of a row already past its no-progress budget; ordering for every row
under the threshold is unaffected. See
`reference-implementation/server/stores/connector-detail-gap-store.js`.

## Capabilities

Modified:

- `reference-implementation-runtime`
- `polyfill-runtime`

### Superseded revision (live-instance follow-on, 2026-07-22)

The rank clamp fixed selection starvation, but retained run diagnostics exposed
a separate lease-accounting defect: the runtime marks every byte-page row
`in_progress` and increments `attempt_count` before Gmail applies its own
attachment-byte admission. Gmail may cleanly finish after hydrating only a
small prefix; its untouched suffix is reset to `pending` during cleanup, but
keeps the synthetic increment. Repeating that successful path makes rows look
like 45–115 failed attempts even though no attachment hydration was requested,
distorting rank and allowing a later real failed attempt to quarantine on a
false budget.

The initial cleanup-based remedy was rejected in independent review: silence
after `DONE:succeeded` does not prove a Gmail metadata lookup was unattempted,
and an unowned reset can race a re-serve. It is retained here only as incident
history.

### Revision (lease-accounting closure, 2026-07-22)

Recovery now records two separate durable facts: a run-owned lease and an
explicit provider attempt. Serving a page atomically claims rows with
`(lease_run_id, lease_id, expiry)` but does not change `attempt_count` or
`last_attempt_at`. A connector reports `DETAIL_GAP_ATTEMPTED` before a real
lookup; recovery or re-deferral is an explicit lease-owned settlement. Cleanup
CAS-releases only the same owner lease and therefore never subtracts counts or
erases a prior timestamp. Expired leases, not merely different run ids, are
reclaimable.

Gmail now explicitly attempts and re-defers metadata lookup misses, while its
byte-cap suffix remains untouched and is safely released. Successful run
completion awaits durable lease release; accounting failure or an attempted
lease without an explicit outcome fails the run before success evidence/state
commit. Existing quarantined-gap requeue remains a separate, operator-scoped
repair and this change does not mutate live rows.

### Revision (Sol migration and identity review, 2026-07-22)

Pre-lease schemas can contain old `in_progress` rows with real historical
attempt evidence but no lease tuple. Both bootstrap migrations now normalize
only that lease-less legacy state to `pending`, preserving `attempt_count` and
`last_attempt_at`; fresh-schema leases remain subject to normal owner/expiry
rules. The deployment contract is explicit: drain active connector runs, then
perform a single-version restart. Mixed old/new runtime operation is unsupported
and no distributed compatibility layer is introduced; bootstrap fails closed
instead of migrating a pre-lease schema while a durable active run remains.

Each served gap now receives its own run-owned `lease_id`, rather than sharing
a page token. The runtime carries the token in START and requires the same
gap/run/token tuple on every settlement, so a same-page swapped token fails
closed. Real old-schema SQLite and isolated-Postgres upgrade oracles prove the
legacy conversion; a runtime oracle proves unique same-page tokens and swap
rejection.

### Revision (throughput discriminator, 2026-07-23)

The live audit proves that Gmail served-gap recovery is running but cannot yet
separate byte-budget binding, the 32-unique-message metadata-lookup cap,
lookup misses, hydration failures, and byte-cap deferrals from one successful
run. Add one `attachment_recovery_outcome` aggregate to Gmail's existing final
served-recovery `PROGRESS` summary. Its fixed allowlist is `served`,
`metadata_lookups`, `attempted`, `admitted`, `admitted_bytes`, `recovered`,
`lookup_miss`, `hydration_failed`, and `run_cap_deferred` (plus its fixed
object discriminator). The runtime validates the exact aggregate shape and
keeps it on the existing `run.progress_reported` spine event.

This is evidence only: no byte budget, metadata-lookup cap, scheduler,
governor, retry policy, durable schema, or user-facing progress copy changes.
The object contains no identifiers, locators, provider identities, content, or
error text. `run_cap_deferred` counts served gaps left unadmitted because the
byte budget stopped the ordered lane, including its untouched suffix, so an
oversized admitted first candidate still reveals byte-budget binding.

### Revision (throughput correction, 2026-07-23)

The fixed-shape terminal aggregate from a successful run resolves the remaining
uncertainty: `served=256`, `attempted=1`, `admitted=1`,
`admitted_bytes=1889782`, `recovered=1`, `lookup_miss=0`,
`hydration_failed=0`, `metadata_lookups=1`, and `run_cap_deferred=255` prove
that Gmail's 1 MiB positional recovery budget is binding. Scheduler admission,
the connector-neutral recovery governor, metadata lookup cap, authentication,
and hydration are not the limiting path for this run.

The recovery governor has no MIME-part byte-cost capacity seam: it governs
eligible provider work, retries, pacing, and request/wall-clock blast radius.
Making it admit attachment bytes would couple generic scheduling to
connector-specific metadata and would not improve provider pacing. The Gmail
connector therefore keeps that governor unchanged and applies the smallest
local policy correction: served attachment recovery defaults to a bounded
4 MiB byte batch, the existing validated maximum. Historical attachment
backfill remains at its 1 MiB default, preserving ordinary forward-sync
behavior. `PDPP_GMAIL_ATTACHMENT_RECOVERY_PAGE_BYTES` is a bounded
recovery-only override; the existing `PDPP_GMAIL_ATTACHMENT_BACKFILL_PAGE_BYTES`
remains a compatible fallback until the recovery-specific variable is set.

Acceptance target: with the measured 1,889,782-byte shape and no override,
three served gaps admit and recover exactly two (3,779,564 bytes) and leave
one as truthful `run_cap_deferred`. A first attachment larger than 4 MiB still
admits exactly one, and the 32-unique-message lookup cap remains unchanged.

### Revision (hydration-stage discriminator, 2026-07-23)

The controlled recovery audit proves `hydration_failed` is accounted correctly
but cannot distinguish IMAP retrieval from blob-path failure. Add a second
fixed-shape aggregate to the same final served-attachment recovery `PROGRESS`
summary: `attachment_hydration_failure_outcome`. Its allowlist is
`imap_download_failed`, `blob_upload_transport_failed`,
`blob_upload_http_4xx`, `blob_upload_http_5xx`,
`blob_upload_invalid_response`, and `blob_upload_integrity_failed` (plus its
fixed object discriminator). The runtime validates and preserves it on the
existing `run.progress_reported` spine event.

The stages come from typed IMAP and blob-uploader catch boundaries. They do
not use error-message matching, retain raw status or provider data, change the
attachment record shape, or change retry, quarantine, terminal, admission, or
owner-action behavior. A non-durable typed hydration result carries the stage
to recovery accounting; `ReferenceBlobUploadFailure` retains its original
cause for local classification, while consumer cancellation remains transport
rather than a source-iterator failure. A fetch rejection is attributed to a
source pull only when that pull has already failed and its preserved cause
matches; timing alone is not evidence. `too_large` remains a separate
local-policy outcome.

### Revision (unclassified hydration failure preservation, 2026-07-23)

A canary Gmail recovery run exposed a plain blob-upload error that reached a
failed attachment result without a typed boundary stage. The prior accounting
guard threw, converting that retryable connector outcome into a non-retryable
connector protocol violation. Add `unclassified_failed` to the same exact,
payload-free aggregate. A failed hydration with no typed stage increments this
counter; it is not guessed to be transport or any other typed cause. The
runtime requires the two recovery aggregates together and validates that all
failure-stage counters sum exactly to `hydration_failed`.

This preserves attachment record, retry, quarantine, terminal, admission,
acknowledgement, cancellation, and privacy behavior. A composed Gmail
hydrator/recovery regression uses a plain `Error` from `uploadBlob` to prove
the recovery function completes, leaves the item retryable, emits no recovery
acknowledgement, and reports one unclassified failure.

### Revision (owner review: live-shape first-item starvation, 2026-08-01)

The owner-review closure re-inspected the available durable read-only evidence
for `cin_12407c1afb78d56848fe0b20`: the attachment recovery spine repeatedly
reported `served=45`, `admitted=1`, and `recovered=0`; the first-ranked MIME
parts were approximately 4.7–8.9 MB against the 4 MiB recovery budget. The
exact code path in `recoverServedAttachmentGaps` admitted the first candidate
unconditionally. After a failed hydration, `admittedBytesTotal` was already
over budget, so the next iteration returned from the top-level fully-spent
guard before locator normalization, `DETAIL_GAP_ATTEMPTED`, metadata lookup, or
settlement. The earlier mid-page overflow continuation therefore could not
reach the smaller siblings in this live shape. Untouched leases were released
without changing `last_attempt_at`, so the store's existing fair ordering had
no new service event with which to rotate them.

The follow-up keeps the generic recovery governor, store ordering, byte budget,
lease accounting, and quarantine semantics unchanged. Gmail now holds the
first candidate when its known cost exceeds the whole run budget, probes later
siblings through the existing 32-unique-message cap, and gives a fitting
candidate priority. The held candidate is settled as `run_cap_deferred` before
that sibling hydrates, or is the sole oversized fallback when no fitting
candidate is found. Thus metadata work remains bounded, attachment bytes do
not become unbounded, and a failed hydration cannot emit a recovery
acknowledgement. The exact repeated-page regression uses 4,700,000 and
8,900,000-byte candidates plus a 16,000-byte sibling and proves the same
smaller sibling recovers on two ordered runs.
