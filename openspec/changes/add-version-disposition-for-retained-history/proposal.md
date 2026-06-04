# Add version disposition for retained history

## Why

The `/dashboard/records` version-churn notice still shows `watch`/`high` rows that
are neither bugs nor noise: they carry **legitimate retained history**. The four
real-field streams already shipped their append-keyed split, the run-clock streams
already gained fingerprint gates, and the banner already reads "no review needed"
when every row is classified. The remaining design gap is structural, not
cosmetic:

- The disposition that makes a churn row safe (point-in-time split, registered
  compaction policy, owner-reviewed residue, recurring session snapshot) is
  **classified entirely in the console** (`apps/console/src/app/dashboard/lib/version-churn-summary.ts`)
  via hardcoded `(connector, stream)` lists that **duplicate** the reference
  server's own registries (`COMPACTION_POLICIES` in
  `reference-implementation/scripts/compact-record-history.mjs` and the
  `POINT_IN_TIME_REAL_FIELD_STREAMS` guard set). The owner-only
  `GET /_ref/records/version-stats` envelope carries no disposition at all, so
  the meaning of a row lives in the browser bundle, not in the auditable
  reference contract.
- One legitimate case is **unmodeled**: a stream that re-versions on every real
  session-growth pass (`claude-code/sessions`, `codex/sessions`). It is mtime-gated
  (no no-op churn) and cannot be append-split (the whole record *is* the evolving
  observation, not a metric you can peel off), so it has no compaction policy and
  is not a real-field split candidate. Today it re-alarms as a
  `lossless_compaction_candidate` every time new session history post-dates the
  owner's review timestamp. That is the timestamp guard working, but it is the
  wrong label: the history is expected, retained, and never compactable.

This change makes the row's disposition a **derived, owner-only observability
field on the version-stats envelope**, so the records page can read "no review
needed" without ever claiming "no retained history exists." It distinguishes the
five dispositions the operator needs and keeps the numeric ratio engine
unchanged so the next genuine connector regression is still caught.

It does **not** introduce a connector-authored disposition field. A connector
must not be able to self-declare its churn away; disposition is computed by the
reference from signals it already trusts (manifest `semantics`, the presence of a
registered compaction policy, the shipped append-keyed split, and the
owner-maintained reviewed-residue evidence). The thresholds stay exactly where
they are; disposition is a label, never a threshold override.

This resolves owner decision 3 of
`design-notes/real-field-version-churn-point-in-time-streams-2026-06-02.md` (the
last open item from that note; decisions 1, 2, 4, 5 already shipped).

## What Changes

- Add a derived `version_disposition` field to each row of the owner-only
  `GET /_ref/records/version-stats` envelope, computed server-side. Allowed
  values:
  - `active_defect_or_unclassified` — a `watch`/`high` row with no recognized
    disposition. **The only class that counts toward "needs review."**
  - `reviewed_historical_residue` — pre-fix accumulation on a stream with a
    registered compaction policy that the owner has reviewed (dry-run showed
    `removableVersions = 0`) and whose `last_history_at` is at or before the
    review timestamp.
  - `point_in_time_retained_history` — genuine real-field movement whose
    observation has already been split into an append-keyed stream; the retained
    entity history is the sole surviving copy and is never compactable.
  - `lossless_compaction_candidate` — a stream with a registered compaction
    policy whose redundant adjacent versions are still removable (`removableVersions > 0`),
    or a reviewed-residue stream whose history grew after the review (re-alarm).
    The read-only dry-run command is a real remediation here.
  - `recurring_point_in_time_snapshot` — a stream that legitimately re-versions
    on each real-growth pass (evolving sessions), is gated against no-op churn,
    and cannot be append-split or compacted. Expected retained history; does not
    re-alarm on growth.
- Add `version_disposition_thresholds_unchanged: true` (or equivalent normative
  assertion) so the envelope makes explicit that disposition never alters the
  `risk_thresholds`. The numeric `risk_level` and `risk_reasons` are computed
  exactly as today and are independent of disposition.
- Move the disposition classification from the console's hardcoded lists to the
  reference server so it is computed once, from server-trusted signals, and
  surfaced in the auditable contract. The console consumes the field instead of
  re-deriving it. (Implementation lane only; this change authorizes it.)
- Define the new `recurring_point_in_time_snapshot` disposition and the rule that
  derives it (session-style streams: `mutable_state` semantics, no registered
  compaction policy, no append-keyed split, monotonic real-growth re-version),
  closing the `claude-code/sessions` / `codex/sessions` re-alarm gap.

No new HTTP route. No new connector-authored manifest field. No threshold change.
No automatic compaction, deletion, or history rewrite. No change to PDPP Core
record reads, Collection Profile messages, or public `/v1` contracts. The
version-stats route remains owner-only and reference-only.

## Capabilities

- Modified: reference-implementation-architecture

## Impact

- `reference-implementation/server/record-version-stats.js` —
  `buildRecordVersionStatsEnvelope` gains derived `version_disposition` per row
  (new pure classifier function; the existing numeric `classifyRecordVersionChurn`
  is unchanged).
- `packages/reference-contract/src/reference/index.ts` —
  `RecordVersionStatsRowSchema` gains the `version_disposition` enum field;
  envelope `meta` gains the thresholds-unchanged assertion.
- `apps/console/src/app/dashboard/lib/version-churn-summary.ts` — consume the
  server-derived disposition instead of the local hardcoded lists; the
  `REVIEWED_COMPACTION_RESIDUE_REVIEWED_AT` evidence map and any input lists
  needed for derivation move server-side.
- `reference-implementation/scripts/compact-record-history.mjs` — the
  `COMPACTION_POLICIES` registry becomes the single source of truth the server
  reads for the "registered policy" signal (no behavior change to the tool).
- `reference-implementation/test/record-version-stats.test.js`,
  `apps/console/src/app/dashboard/lib/version-churn-summary.test.ts` — disposition
  derivation and threshold-independence coverage.
- `openspec/specs/reference-implementation-architecture/spec.md` — the
  "Record-version churn observability" requirement delta (via this change).
