# Tasks — version disposition for retained history

This is proposal/packet work. The boxes below sequence the eventual
implementation lane; they are NOT done in this change. The owner accepts the
proposal first (see `design.md` "Owner decision"), then dispatches the
implementation lane.

## 1. Owner acceptance (gate)

- [ ] 1.1 Owner confirms `version_disposition` is **server-derived** (Option A),
      or requests the manifest-authored hint (Option B) as a follow-up.
- [ ] 1.2 Owner confirms the disposition #5 name
      (`recurring_point_in_time_snapshot`) or supplies a preferred name.

## 2. Reference contract (durable surface)

- [ ] 2.1 Add `version_disposition` to `RecordVersionStatsRowSchema` in
      `packages/reference-contract/src/reference/index.ts` as a required string
      enum: `active_defect_or_unclassified | reviewed_historical_residue |
      point_in_time_retained_history | lossless_compaction_candidate |
      recurring_point_in_time_snapshot`.
- [ ] 2.2 Assert in the envelope `meta` (or per-row) that disposition does not
      alter `risk_thresholds` (e.g. a `disposition_affects_thresholds: false`
      constant, or a doc-comment + test). Keep `risk_thresholds` byte-identical.
- [ ] 2.3 Regenerate/verify generated contract artifacts
      (`pnpm --filter @pdpp/reference-contract run verify` / `check:generated`).

## 3. Server derivation (single source of truth)

- [ ] 3.1 Add a pure `classifyVersionDisposition(row, signals)` to
      `reference-implementation/server/record-version-stats.js` that derives the
      five-way disposition from: manifest `semantics`, registered compaction
      policy presence, append-split sibling presence, the reviewed-at evidence
      map, and the session-style recurring-growth rule. Do NOT modify
      `classifyRecordVersionChurn` (numeric path stays as-is).
- [ ] 3.2 Make `compact-record-history.mjs`'s `COMPACTION_POLICIES` the source
      the server reads for the "registered policy" signal (import or shared
      module; no behavior change to the tool).
- [ ] 3.3 Move the `REVIEWED_COMPACTION_RESIDUE_REVIEWED_AT` evidence map
      server-side so derivation reads it directly.
- [ ] 3.4 Define the `recurring_point_in_time_snapshot` rule: `mutable_state`
      semantics, no registered compaction policy, no append-split sibling,
      re-versions on monotonic real growth (session-style). Cover
      `claude-code/sessions` and `codex/sessions`.
- [ ] 3.5 Populate `version_disposition` on every row in
      `buildRecordVersionStatsEnvelope`.

## 4. Console consumption (remove duplication)

- [ ] 4.1 `apps/console/src/app/dashboard/lib/version-churn-summary.ts` consumes
      the server-derived `version_disposition` instead of the local hardcoded
      `POINT_IN_TIME_REAL_FIELD_STREAMS` / `LOSSLESS_COMPACTION_POLICY_STREAMS` /
      `REVIEWED_COMPACTION_RESIDUE_*` lists. Preserve the existing headline copy
      and the "needs review" = unclassified-only behavior.
- [ ] 4.2 Add the disposition #5 operator copy ("recurring point-in-time
      snapshots — expected retained history; not compactable").
- [ ] 4.3 Keep numeric counts, `risk_level`, and `versions_per_record` rendered
      unchanged — no row is hidden.

## 5. Tests (acceptance contract)

- [ ] 5.1 AC-1: envelope returns `version_disposition` enum on every row;
      owner-only auth unchanged; no payload leak
      (`reference-implementation/test/record-version-stats.test.js`).
- [ ] 5.2 AC-2: `risk_thresholds` byte-identical; `risk_level`/`risk_reasons`
      unchanged by disposition for all fixtures.
- [ ] 5.3 AC-3: unknown `(connector, stream)` high/watch →
      `active_defect_or_unclassified`, counts toward needs-review.
- [ ] 5.4 AC-4: reviewed-residue row with `last_history_at > reviewed_at` →
      `lossless_compaction_candidate` (re-alarm).
- [ ] 5.5 AC-5: `claude-code/sessions` + `codex/sessions` →
      `recurring_point_in_time_snapshot`; not needs-review; no re-alarm on
      `last_history_at` advance.
- [ ] 5.6 AC-6: `github/user`, `slack/channels`, `ynab/accounts` →
      `point_in_time_retained_history`; no compaction command offered.
- [ ] 5.7 AC-7: a connector manifest change cannot alter a row's
      `version_disposition` (derivation reads only server registries + reviewed
      map + ground-truth).
- [ ] 5.8 AC-8: `version-churn-summary.test.ts` behavioral expectations hold
      against the relocated logic; no second source of truth remains.

## 6. Acceptance checks (reproducible)

- [ ] 6.1 `npx openspec validate add-version-disposition-for-retained-history --strict`
- [ ] 6.2 `npx openspec validate --all --strict`
- [ ] 6.3 `node --test reference-implementation/test/record-version-stats.test.js`
- [ ] 6.4 `node --import tsx --test apps/console/src/app/dashboard/lib/version-churn-summary.test.ts`
- [ ] 6.5 `pnpm --filter @pdpp/reference-contract run verify`
- [ ] 6.6 `npx tsc --noEmit` for the touched packages (console + reference-contract)
- [ ] 6.7 Owner-cookie live probe of `/_ref/records/version-stats` confirms every
      row carries a disposition and the banner reads "no review needed" with the
      session rows reclassified (owner-gated; do from a deployed instance).
