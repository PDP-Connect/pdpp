## 1. Store Fix (connector-neutral)

- [x] Recover the aging-bucket `ORDER BY` (attempt_count minus a capped
      age-bonus, tie-broken by last_attempt_at/created_at/gap_id) from
      a prior unmerged branch in both the SQLite and
      Postgres `listPendingGaps` implementations.
- [x] Reconcile the recovered diff against current `main` (typecheck + full
      store test suite green).

## 2. Gmail Connector Fix

- [x] Recover the Gmail attachment-recovery wiring: match served
      `START.detail_gaps` attachments by id/message_id/part_index, emit
      `DETAIL_GAP_RECOVERED` on successful hydration.
- [x] Recover activating historical attachment backfill when a pending
      attachment detail backlog exists (not only on explicit
      `streamsToBackfill`).
- [x] Add a Gmail-local served-gap recovery pass that treats valid served
      attachment gaps as the current bounded work unit, streaming Gmail
      `X-GM-MSGID` probes via `search({ emailId })`, caching same-message
      lookups, admitting a positional byte-budget prefix, capping provider
      metadata work at 32 unique lookups, emitting `phase=hydrating`
      progress immediately after admission and settled progress after record
      emission, and leaving unadmitted gaps untouched; when no valid served
      gaps are handed to the connector, the ordinary historical
      crawl/cursor advancement resumes.
- [x] Thread `START.recovery_only` through the Gmail entrypoint so a
      recovery-only continuation stops after served attachment recovery and
      returns before the ordinary labels/thread/message/delta walk, while the
      normal run path remains unchanged.
- [x] Reconcile the recovered diff against current `main` (typecheck + full
      Gmail connector test suite green).

## 3. Additional Regression Tests (beyond the recovered branch)

- [x] Reproduce a backlog larger than one recovery page across many
      successive 15-minute-cadence runs and prove every eligible row
      eventually advances (not just single-selection ordering).
- [x] Prove backoff-deferred rows stay excluded across runs regardless of
      attempt_count or age.
- [x] Prove terminal rows never resurface across runs regardless of
      attempt_count or age.
- [x] Prove a backlog within one page is unaffected (membership, not just
      order).
- [x] Prove the multi-run drain test is mutation-resistant (fails under the
      original `ORDER BY created_at` behavior).

## 4. Validation

- [x] Run focused `connector-detail-gap-store.test.js`,
      `detail-gap-page-request-oracle.test.js`, `recovery-decision.test.js`,
      terminal-gap suites, Gmail connector suites, Chase gap-recovery suite.
- [x] Run typecheck for `reference-implementation` and
      `packages/polyfill-connectors`.
- [x] Lint touched `.ts` files (`.js` store files are exempt from lint per
      repo policy pending TS migration).
- [x] `openspec validate fix-gap-recovery-page-starvation --strict`.

## 5. Revision (independent gate review, 2026-07-15)

- [x] Fix B1: gate `DETAIL_GAP_RECOVERED` on `hydration_status === "hydrated"`
      only (not merely "record emitted") — `failed`/`deferred` never recover.
- [x] Decide `too_large`: excluded from recovery (never the subject of a
      durable `DETAIL_GAP`; already covered via `optional_skip_keys`), and
      documented in code comments + spec.
- [x] Add mutation-resistant regression: served gap re-fails hydration → no
      `DETAIL_GAP_RECOVERED`, attachment lands in `gapKeys`/`failedRecords`
      (the ordinary requeue path) so the durable gap stays pending/retryable.
- [x] Add observability regression: slow admitted hydration emits
      `phase=hydrating` progress before the promise resolves, then only
      settles recovery after hydration and record emission complete.
- [x] Make SQLite's `last_attempt_at` fallback symmetric with Postgres via
      `NULLIF(last_attempt_at, '')` in both engines' `ORDER BY`.
- [x] Re-run focused SQLite suite, isolated-throwaway-Postgres suite (never
      touching the live `pdpp-postgres-1`), Gmail suite, typecheck, lint,
      `openspec validate --strict`, diff review.
- [x] Amend commit `d66f38302`; update maker report.

## 6. Revision (live-instance follow-on: quarantine-threshold selection deadlock, 2026-07-21)

- [x] Diagnose: 256 Gmail attachment gaps pinned at `attempt_count=107` (past
      the quarantine threshold of 8), 6+ days untouched, while the rest of the
      backlog kept cycling — a row whose `attempt_count` is unbounded above
      the threshold sinks to a permanently-worse rank than the age bonus
      (capped at 8 buckets) can ever offset, so it is never selected again and
      never reaches `maybeQuarantineGap`.
- [x] Fix: clamp the `attempt_count` term in `pendingGapOrderBySql` (both
      SQLite and Postgres) at `DEFAULT_QUARANTINE_POLICY.maxNoProgressAttempts`
      (`reference-implementation/server/stores/connector-detail-gap-store.js`).
- [x] Add a mutation-resistant regression proving a row past the quarantine
      threshold, once fully aged, ranks at or ahead of a genuinely fresh
      arrival (fails without the clamp, passes with it).
      (`reference-implementation/test/connector-detail-gap-store.test.js`)
- [x] Re-run focused SQLite suite (`connector-detail-gap-store.test.js`,
      `recovery-quarantine.test.js`, `recovery-decision.test.js`), typecheck,
      `openspec validate --strict`, diff review.

## 7. Revision (independent gate review near-miss: Postgres clamp had zero coverage, 2026-07-21)

An independent adversarial review found the section-6 regression test only
exercised `createSqliteConnectorDetailGapStore`, while the live incident
instance runs Postgres. `pendingGapOrderBySql` has separate SQLite (`MIN`)
and Postgres (`LEAST`) clamp branches; only the SQLite branch was proven.

- [x] Add the Postgres twin of the attempt-count rank-clamp regression test,
      using the existing `PDPP_TEST_POSTGRES_URL`-gated pattern, run against
      a dedicated throwaway Postgres container (never the live database).
      (`reference-implementation/test/connector-detail-gap-store.test.js`)
- [x] Verify the Postgres-only mutation (revert `LEAST(attempt_count, 8)` →
      `attempt_count`, keep the SQLite `MIN` clamp intact): the Postgres twin
      fails while the SQLite test stays green — proving the two branches are
      independently covered, not accidentally coupled.
- [x] Re-run both tests against the fix restored (both green), typecheck,
      `openspec validate --strict`.
