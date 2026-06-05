# Tasks — version disposition for retained history

Implementation status (lane `ri-version-disposition-implementation-v1`): the
server derivation, reference contract, console consumption, and tests are
implemented and green, merged at `6aacee2d`, and deployed. The live probe (task
6.7) was performed against the deployed instance by the closeout lane
`ri-version-churn-watch-closeout-f625-v1` and passed (see that report). The only
items still open are the two **owner human-acceptance decisions** in Section 1
(author-location and the disposition #5 name); they are not engineering work.
The implementation adopted one derivation-rule correction vs. the first draft —
disposition #5 keys on an explicit recurring-snapshot list with precedence, NOT
on "no compaction policy," because the session streams DO carry a policy (see
`design.md` correction note).

## 1. Owner acceptance (gate)

- [ ] 1.1 Owner confirms `version_disposition` is **server-derived** (Option A),
      or requests the manifest-authored hint (Option B) as a follow-up.
      (Implementation lane proceeded on Option A as the dispatched approach.)
- [ ] 1.2 Owner confirms the disposition #5 name
      (`recurring_point_in_time_snapshot`) or supplies a preferred name.
      (Implemented as `recurring_point_in_time_snapshot`.)

## 2. Reference contract (durable surface)

- [x] 2.1 Add `version_disposition` to `RecordVersionStatsRowSchema` in
      `packages/reference-contract/src/reference/index.ts` as a required string
      enum: `active_defect_or_unclassified | reviewed_historical_residue |
      point_in_time_retained_history | lossless_compaction_candidate |
      recurring_point_in_time_snapshot`. (Also mirrored in the console's
      `RefRecordVersionStatsRow` type in `ref-client.ts`.)
- [x] 2.2 Assert in the envelope `meta` that disposition does not alter
      `risk_thresholds`: `disposition_affects_thresholds: { const: false }`
      added to the schema (required) and emitted by the server. `risk_thresholds`
      kept byte-identical (pinned by AC-2 test).
- [x] 2.3 Regenerated generated contract artifacts: only
      `reference-implementation/openapi/reference-full.openapi.json` changed
      (reference-only route); `reference-public.openapi.json` and the generated
      docs are unchanged. `node --test packages/reference-contract/test/*` green.

## 3. Server derivation (single source of truth)

- [x] 3.1 Add a pure `classifyVersionDisposition({connectorId, stream,
      lastHistoryAt, hasCompactionPolicy})` in a new `pg`-free module
      `reference-implementation/server/version-disposition.js` that derives the
      five-way disposition from: the recurring point-in-time snapshot list, the
      point-in-time split list, the reviewed-at evidence map, and the injected
      registered-compaction-policy boolean — applied with fixed precedence
      (recurring → point-in-time → reviewed → policy → unclassified). `semantics`
      is NOT an input (every relevant stream is `mutable_state`; the explicit
      lists carry the distinguishing information). Do NOT modify
      `classifyRecordVersionChurn` (numeric path stays as-is).
- [x] 3.2 `record-version-stats.js` resolves the "registered policy" signal from
      `compact-record-history.mjs`'s `COMPACTION_POLICIES` via the exported
      `findPolicy` (single source of truth; no behavior change to the tool; the
      server module already transitively loads `pg`, so no new dependency).
- [x] 3.3 Move the `REVIEWED_COMPACTION_RESIDUE_REVIEWED_AT` evidence map
      server-side (into `version-disposition.js`) so derivation reads it
      directly. `claude-code/sessions` is removed from it — it is now classified
      by the recurring-snapshot list instead.
- [x] 3.4 Define the `recurring_point_in_time_snapshot` rule: explicit
      membership in a reference-maintained recurring-snapshot list
      (`claude-code/sessions`, `codex/sessions`), evaluated with PRECEDENCE over
      the reviewed-residue and compaction-policy signals. These streams DO carry
      a registered compaction policy (the no-op regression safety net), so the
      rule cannot key on policy absence — list membership is the signal.
- [x] 3.5 Populate `version_disposition` on every row in
      `buildRecordVersionStatsEnvelope`, plus `disposition_affects_thresholds:
      false` on the envelope `meta`.

## 4. Console consumption (remove duplication)

- [x] 4.1 `apps/console/src/app/dashboard/lib/version-churn-summary.ts` consumes
      the server-derived `version_disposition` instead of the local hardcoded
      lists. The `POINT_IN_TIME_REAL_FIELD_STREAMS` /
      `LOSSLESS_COMPACTION_POLICY_STREAMS` / `REVIEWED_COMPACTION_RESIDUE_*`
      exports are removed (a display-only real-field description map remains for
      guidance copy). `ChurnRemediation` is now the server disposition union.
      Headline copy and the "needs review" = unclassified-only behavior preserved.
- [x] 4.2 Added the disposition #5 operator copy ("Recurring point-in-time
      snapshot — expected retained history … cannot be append-split or
      compacted") in `pointInTimeGuidance` and the `recurring snapshot` badge in
      `records-list-view.tsx`.
- [x] 4.3 Numeric counts, `risk_level`, and `versions_per_record` rendered
      unchanged — no row is hidden (drilldown still maps every supplied row).

## 5. Tests (acceptance contract)

- [x] 5.1 AC-1: envelope returns `version_disposition` enum on every row; no
      payload leak (`record-version-stats.test.js` "AC-1"). Owner-auth path
      unchanged (existing `/_ref/records/version-stats` owner test still green).
- [x] 5.2 AC-2: `risk_thresholds` deep-equal to the contract; disposition does
      not change `risk_level`/`risk_reasons`; `disposition_affects_thresholds`
      asserted (`record-version-stats.test.js` "AC-2").
- [x] 5.3 AC-3: unknown `(connector, stream)` → `active_defect_or_unclassified`
      (server module + envelope tests).
- [x] 5.4 AC-4: reviewed-residue row with `last_history_at > reviewed_at` →
      `lossless_compaction_candidate` (server module + envelope tests).
- [x] 5.5 AC-5: `claude-code/sessions` + `codex/sessions` →
      `recurring_point_in_time_snapshot`; not needs-review; no re-alarm on
      `last_history_at` advance (server module + envelope tests).
- [x] 5.6 AC-6: `github/user`, `slack/channels`, `ynab/accounts` →
      `point_in_time_retained_history`; no compaction command offered (server +
      console drilldown tests).
- [x] 5.7 AC-7: a connector-authored field cannot alter `version_disposition`
      (server module "only reference-controlled inputs" + envelope "AC-7").
- [x] 5.8 AC-8: `version-churn-summary.test.ts` rewritten to assert the console
      consumes the server field; the former console-source mirror tests in
      `compact-record-history.test.js` now import the server registries directly
      — no second source of truth remains.

## 6. Acceptance checks (reproducible)

- [x] 6.1 `openspec validate add-version-disposition-for-retained-history --strict` → valid
- [x] 6.2 `openspec validate --all --strict` → 43 passed, 0 failed
- [x] 6.3 `node --test reference-implementation/test/{version-disposition,record-version-stats,compact-record-history}.test.js` → 66 pass, 1 PG-gated skip
- [x] 6.4 `node --import tsx --test apps/console/.../version-churn-summary.test.ts` (+ records-list-view.test.ts) → 65 pass
- [x] 6.5 reference-contract: `node --test test/*.test.js` → 64 pass; `tsc --noEmit` clean; generated artifacts regenerated + idempotent (`ultracite check` not run in lane — see note)
- [x] 6.6 `tsc --noEmit` clean for reference-contract, reference-implementation, and console
- [x] 6.7 Owner-cookie live probe of `/_ref/records/version-stats` confirms every
      row carries a disposition and the banner reads "no review needed" with the
      session rows reclassified (owner-gated; done from the deployed instance).
      Discharged by lane `ri-version-churn-watch-closeout-f625-v1`
      (`tmp/workstreams/ri-version-churn-watch-closeout-f625-v1-report.md`):
      live owner-cookie probe returned 95 rows / 4 watch / 0 high / 0 needs-review,
      every row carried a `version_disposition`, the banner read "no review
      needed," and `claude-code/sessions` classified
      `recurring_point_in_time_snapshot` (out of the compaction-candidate bucket).
      Corroborated by a 9/9 deployed-`classifyVersionDisposition` probe (incl. the
      AC-4 live re-alarm) and a read-only `planCompaction` dry-run showing
      `removableVersions = 0` on all four watch instances. The derivation module
      `version-disposition.js` is byte-identical to HEAD: its last commit is the
      implementation merge `6aacee2d` and nothing has touched it since. The
      version-stats route (`record-version-stats.js`) DID change after the f625
      probe (`38cf79a9`, `e88d361f`: projection hot-path / churn-ratio candidate
      narrowing — neither alters the disposition wiring), so the live result was
      re-verified at the later deployed rev `43f63825` by lane
      `ri-live-records-after-43f-proof-v1`
      (`tmp/workstreams/ri-live-records-after-43f-proof-v1-report.md`): a 95-row
      `/_ref/records/version-stats` probe (200, projection clean, 30ms) showed
      every row still carrying a `version_disposition`, the banner still neutral
      ("Version churn is classified — no review needed"), and
      `claude-code/sessions` still classified `recurring_point_in_time_snapshot`.
      The disposition surface therefore holds across the post-probe route changes.
