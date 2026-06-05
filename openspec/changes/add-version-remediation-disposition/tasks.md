# Tasks — version remediation disposition for retained history

This change is **proposal/packet work** (OpenSpec authored; implementation
sequenced below but NOT performed in this lane). The lane that authored it
stopped before code per the project rule that a new durable contract surface
(a new owner-only envelope field + a new normative requirement) is written as an
OpenSpec change before implementation. Section 1 is the owner gate; Sections 2–6
are the implementation lane.

## 1. Owner acceptance (gate)

- [ ] 1.1 Owner accepts the orthogonal `version_remediation` field (recommended)
      rather than a finer split of the `version_disposition` enum.
- [ ] 1.2 Owner confirms the four remediation value names (`none`,
      `content_fingerprint_pending`, `owner_migration_pending`,
      `owner_retention_policy`) or supplies preferred names.
- [ ] 1.3 Owner confirms the initial list memberships mirror the dispositions
      already accepted: `content_fingerprint_pending` = {`chase/statements`,
      `usaa/statements`}; `owner_migration_pending` = {`usaa/accounts`};
      `owner_retention_policy` = {`claude-code/sessions`, `codex/sessions`}.

## 2. Reference contract (durable surface)

- [ ] 2.1 Add `version_remediation` to `RecordVersionStatsRowSchema` in
      `packages/reference-contract/src/reference/index.ts` as a required string
      enum: `none | content_fingerprint_pending | owner_migration_pending |
      owner_retention_policy`. Mirror it on the console's
      `RefRecordVersionStatsRow` type in `ref-client.ts` (new
      `RefRecordVersionRemediation` type).
- [ ] 2.2 Add `remediation_affects_thresholds: { const: false }` to the envelope
      `meta` schema (required) and emit it from the server. Keep
      `risk_thresholds` and `disposition_affects_thresholds` byte-identical
      (pinned by AC-2).
- [ ] 2.3 Regenerate generated contract artifacts: only
      `reference-implementation/openapi/reference-full.openapi.json` SHOULD change
      (reference-only route); `reference-public.openapi.json` and generated docs
      unchanged. `node --test packages/reference-contract/test/*` green.

## 3. Server derivation (single source of truth)

- [ ] 3.1 In `reference-implementation/server/version-disposition.js`, add three
      reference-maintained `(connector, stream)` lists co-located with the
      existing disposition registries:
      `CONTENT_FINGERPRINT_PENDING_STREAMS` = [`chase/statements`,
      `usaa/statements`]; `OWNER_MIGRATION_PENDING_STREAMS` = [`usaa/accounts`];
      `OWNER_RETENTION_POLICY_STREAMS` = [`claude-code/sessions`,
      `codex/sessions`]. Match `connector` via the same `normalizeConnectorId`
      used for disposition (registry-URL + `local-device:` forms).
- [ ] 3.2 Add a pure `classifyVersionRemediation({connectorId, stream,
      versionDisposition})` that applies the consistency precedence:
      (1) retention-policy list membership AND
      `versionDisposition === 'recurring_point_in_time_snapshot'` →
      `owner_retention_policy`; (2) migration list → `owner_migration_pending`;
      (3) fingerprint list → `content_fingerprint_pending`; (4) otherwise
      `none`. An `active_defect_or_unclassified` or `lossless_compaction_candidate`
      disposition always yields `none` (assert it cannot be overridden by a list).
      `classifyVersionDisposition` is NOT modified; remediation consumes its
      output.
- [ ] 3.3 In `reference-implementation/server/record-version-stats.js`,
      `buildRecordVersionStatsEnvelope` populates `version_remediation` per row by
      calling `classifyVersionRemediation` with the disposition it already
      derived, and emits `remediation_affects_thresholds: false` on `meta`. No
      change to `classifyRecordVersionChurn` or the disposition wiring.

## 4. Console consumption (no re-derivation)

- [ ] 4.1 `apps/console/src/app/dashboard/lib/version-churn-summary.ts` exposes
      the remediation cue from `row.version_remediation` (a straight read; no
      browser classifier). The evidence-grounded guidance copy for each
      remediation lives in a display-only map keyed by the server value.
- [ ] 4.2 `apps/console/src/app/dashboard/components/views/records-list-view.tsx`
      renders a remediation chip in the drilldown row and prefers the remediation
      guidance line for `reviewed_historical_residue` /
      `recurring_point_in_time_snapshot` rows, so `chase/statements` reads
      "fingerprint pending," `usaa/accounts` reads "migration pending," and
      `claude-code/sessions` reads "retention policy — owner decision."
- [ ] 4.3 Numeric counts, `risk_level`, `versions_per_record`,
      `version_disposition`, and the "needs review = unclassified-only" headline
      behavior are rendered unchanged — no row is hidden, no headline semantics
      change.

## 5. Tests (acceptance contract)

- [ ] 5.1 AC-1: envelope returns `version_remediation` enum on every row; no
      payload leak (`record-version-stats.test.js`). Owner-auth path unchanged.
- [ ] 5.2 AC-2: `risk_thresholds`, `risk_level`, `risk_reasons`, and
      `version_disposition` unchanged by this change; `remediation_affects_thresholds`
      asserted `false` (`record-version-stats.test.js`).
- [ ] 5.3 AC-3: `chase/statements` + `usaa/statements` → `content_fingerprint_pending`
      (server module + envelope tests).
- [ ] 5.4 AC-4: `usaa/accounts` → `owner_migration_pending`, distinct from the
      statement rows (server module + envelope tests).
- [ ] 5.5 AC-5: `claude-code/sessions` + `codex/sessions` → `owner_retention_policy`
      (server module + envelope tests).
- [ ] 5.6 AC-6: `lossless_compaction_candidate`, an unlisted
      `point_in_time_retained_history`, and `active_defect_or_unclassified` →
      `none` (server module tests).
- [ ] 5.7 AC-7: a connector-authored field cannot alter `version_remediation`
      (server module "only reference-controlled inputs").
- [ ] 5.8 AC-8: `owner_retention_policy` rows always have disposition
      `recurring_point_in_time_snapshot`; remediation never contradicts
      disposition (server module consistency test).
- [ ] 5.9 AC-9: `version-churn-summary.test.ts` / `records-list-view.test.ts`
      assert the console renders the server field and distinct fingerprint-pending
      vs. migration-pending copy.

## 6. Acceptance checks (reproducible)

- [ ] 6.1 `openspec validate add-version-remediation-disposition --strict` → valid
- [ ] 6.2 `openspec validate --all --strict` → all pass
- [ ] 6.3 `node --test reference-implementation/test/{version-disposition,record-version-stats}.test.js` → green
- [ ] 6.4 `node --import tsx --test apps/console/.../version-churn-summary.test.ts`
      (+ `records-list-view.test.ts`) → green
- [ ] 6.5 reference-contract: `node --test test/*.test.js` green; `tsc --noEmit`
      clean; generated artifacts regenerated + idempotent
- [ ] 6.6 `tsc --noEmit` clean for reference-contract, reference-implementation,
      and console
- [ ] 6.7 Owner-cookie live probe of `/_ref/records/version-stats` confirms every
      row carries a `version_remediation`, the four watch rows read as
      fingerprint-pending / migration-pending / retention-policy as expected, and
      the banner's "needs review" headline is unchanged (owner-gated).

## Acceptance checks (cross-cutting)

- No threshold change: `risk_thresholds` byte-identical before/after.
- No connector input to remediation: derivation reads only reference lists + the
  server-derived disposition.
- No row hidden, no row given a remediation contradicting its disposition.
- No live compaction, deletion, history rewrite, or data migration performed.
- `git diff --check` clean.
