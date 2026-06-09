# Add version remediation disposition for retained history

## Why

The records-page version-churn notice now classifies every non-normal row with a
reference-derived `version_disposition` (the five-way label shipped by
`add-version-disposition-for-retained-history`). That made the banner read "no
review needed" without claiming the history is absent — but it stopped at *why*
the history exists. It does not tell the operator *what each row needs next*, and
that gap is now load-bearing because three structurally different rows all carry
the **same** disposition.

The two read-only evidence lanes
(`tmp/workstreams/ri-version-rationality-evidence-v1-report.md` and
`tmp/workstreams/ri-records-version-rationality-next-v1-report.md`) proved that
the four watch rows are *not* interchangeable:

- `chase/statements` and `usaa/statements` are both
  `reviewed_historical_residue`. Their byte churn is RC4 re-encryption /
  regeneration-timestamp noise; the owner-visible content is invariant. But the
  registered compaction policy excludes only `fetched_at`, so the dry-run reports
  `removableVersions = 0` — running it frees nothing. The history only becomes
  meaningfully minimal once the **connector emits a content fingerprint**
  (`pdf_text_sha256` + `pdf_page_count`) so the blob-identity fields can be
  excluded losslessly. The disposition label says "reviewed residue — safe to
  leave or compact," which is true about safety but silent about the fact that
  the real remediation is net-new connector work, not compaction.

- `usaa/accounts` is also `reviewed_historical_residue`. But its retained
  history is the **sole surviving copy** of 11 real pre-split balance
  observations that predate the `account_stats` split. The forward fingerprint
  gate is lossless (only `fetched_at` no-ops collapse, so `--apply` would not
  destroy those rows today), but the row carries a **pending owner migration
  decision** — whether to backfill those pre-split balances into `account_stats`
  before the entity history is ever treated as collapsible. The compaction-policy
  comment itself records this open decision. The operator cannot see it: the row
  reads identically to the two statement rows.

- `claude-code/sessions` is `recurring_point_in_time_snapshot` — correctly
  expected, never re-alarming. But one active session drives nearly all of its
  growth, and whether to **bound** that snapshot history (a new retention class)
  is an explicit, decline-able **owner retention-policy decision**, not a defect.
  The disposition says "growth is normal" and stops there.

So the disposition surface is honest about *forward correctness* and *safety*,
but it flattens three different remediation/owner-decision paths into "reviewed
residue" and one into "recurring snapshot." An operator looking at the notice
cannot tell which watch row needs a connector content fingerprint, which carries
a pending data-migration decision, and which is an owner retention-policy
question. That is the difference between a surface that is *less scary* and one
that is *rational*.

This change adds a second, **orthogonal**, reference-derived classification —
`version_remediation` — that names the operator's next action without touching
the stable `version_disposition` contract or the numeric churn engine. It is the
smallest durable construction that lets the notice say, per row, "this is
expected retained history" *and* "the path to make it minimal is X."

It does **not** introduce a connector-authored field, change any threshold,
trigger any compaction or migration, or alter `version_disposition`. Like
disposition, remediation is derived server-side from signals the reference
controls, so a connector cannot self-declare its way out of a needed fix.

This realizes the residual UI/disposition question both prior reports left open:
"the banner reads 'no review needed' while the retained history is non-minimal;
if the owner wants the surface to reflect semantic minimality, that is a separate
UI/disposition question."

## What Changes

- Add a derived `version_remediation` field to each row of the owner-only
  `GET /_ref/records/version-stats` envelope, computed server-side, orthogonal to
  `version_disposition`. Allowed values:
  - `none` — no operator action is available or warranted from this surface. The
    history is either already minimal, an actionable compaction candidate whose
    command is shown, or expected recurring history with no pending owner
    decision.
  - `content_fingerprint_pending` — the row is fingerprint-correct on its
    run-clock field but its retained history stays non-minimal until the
    **connector emits a stable content fingerprint** that lets the volatile
    acquisition/blob fields be excluded losslessly. Running the existing dry-run
    frees nothing; the real fix is connector work tracked by a separate change.
  - `owner_migration_pending` — the retained history is the sole surviving copy
    of real observations that must be **migrated into their canonical
    append-keyed home** before the entity history could ever be collapsed.
    Compaction is not the remediation and could destroy real history if attempted
    out of order; the row carries a pending owner-gated data migration.
  - `owner_retention_policy` — expected recurring history whose only open lever
    is an **owner retention-policy decision** (e.g. whether to bound an
    unbounded-growth snapshot stream). No defect; the owner may decline.
- Derive `version_remediation` from reference-controlled signals only:
  reference-maintained lists keyed by `(connector, stream)` that name the
  fingerprint-pending streams, the migration-pending streams, and the
  retention-policy streams, plus the already-resolved `version_disposition` to
  enforce consistency (e.g. a row may only be `owner_retention_policy` if its
  disposition is `recurring_point_in_time_snapshot`). No connector input.
- Assert in the envelope `meta` that remediation, like disposition, never alters
  the numeric `risk_thresholds`, `risk_level`, or `risk_reasons`
  (`remediation_affects_thresholds: false`).
- Console: the records-page notice renders the remediation cue per row — a short
  in-table chip plus an evidence-grounded guidance line — so a reviewed-residue
  row reads "fingerprint pending" vs. "migration pending," and a recurring
  snapshot reads "retention policy — owner decision." Headline copy and the
  "needs review = unclassified-only" behavior are unchanged.

No new HTTP route. No new connector-authored manifest field. No threshold change.
No automatic compaction, deletion, history rewrite, or data migration. No change
to `version_disposition`, PDPP Core record reads, Collection Profile messages, or
public `/v1` contracts. The version-stats route remains owner-only and
reference-only.

## Capabilities

- Modified: reference-implementation-architecture

## Impact

- `reference-implementation/server/version-disposition.js` — add a pure
  `classifyVersionRemediation({connectorId, stream, versionDisposition})` plus
  the three reference-maintained `(connector, stream)` lists it reads
  (`CONTENT_FINGERPRINT_PENDING_STREAMS`, `OWNER_MIGRATION_PENDING_STREAMS`,
  `OWNER_RETENTION_POLICY_STREAMS`). `classifyVersionDisposition` is unchanged;
  remediation consumes its output. Still `pg`/db-free and unit-testable.
- `reference-implementation/server/record-version-stats.js` —
  `buildRecordVersionStatsEnvelope` populates `version_remediation` per row from
  the already-derived disposition; `meta` gains
  `remediation_affects_thresholds: false`. The numeric path
  (`classifyRecordVersionChurn`) and the disposition wiring are untouched.
- `packages/reference-contract/src/reference/index.ts` —
  `RecordVersionStatsRowSchema` gains the required `version_remediation` enum;
  envelope `meta` gains the required `remediation_affects_thresholds` const.
  Generated `reference-implementation/openapi/reference-full.openapi.json`
  regenerated (reference-only route; public OpenAPI + docs unchanged).
- `apps/console/src/app/dashboard/lib/ref-client.ts` — add the
  `RefRecordVersionRemediation` type and the `version_remediation` field on
  `RefRecordVersionStatsRow`.
- `apps/console/src/app/dashboard/lib/version-churn-summary.ts` — surface the
  remediation cue/guidance from the server field (no re-derivation); the
  evidence-grounded copy for each remediation lives in a display-only map keyed
  by the server value, not a classifier.
- `apps/console/src/app/dashboard/components/views/records-list-view.tsx` — render
  the remediation chip in the drilldown row and prefer the remediation guidance
  line for reviewed-residue / recurring-snapshot rows.
- Tests:
  `reference-implementation/test/version-disposition.test.js`,
  `reference-implementation/test/record-version-stats.test.js`,
  `apps/console/src/app/dashboard/lib/version-churn-summary.test.ts`,
  `apps/console/src/app/dashboard/components/views/records-list-view.test.ts` —
  remediation derivation, consistency with disposition, threshold-independence,
  anti-self-declaration, and console rendering.
- `openspec/specs/reference-implementation-architecture/spec.md` — the new
  "Record-version remediation disposition" requirement (via this change's ADDED
  delta).
