## Revision (independent review, 2026-07-14)

An independent review of the first implementation (commit `5712f3afe`) found
a P1: the `upsertPendingGap` status CASE used
`recovered_run_id IS NULL OR recovered_run_id = excluded.last_run_id` to
decide stickiness. Since `recovered_run_id` is `NULL` for any run-id-less
recovery — the local-collector policy-budget drain
(`ref-device-exporters.ts:recoverLocalCollectorGap`, which calls
`markGapStatus(id, 'recovered', {})` with no `runId`) is the live example —
the `IS NULL` branch made every such row match unconditionally, so it stayed
`recovered` **forever**, the exact opposite of the intended reopen-on-later-
evidence rule. Reviewer reproduced it locally. Fixed by dropping the `IS
NULL` special case entirely: the comparison is now plain
`recovered_run_id = excluded.last_run_id`, which SQL's `NULL = x` semantics
already resolve to false/unmatched for every `x` (including another `NULL`)
— so a run-id-less recovery is never treated as a same-attempt re-defer and
always reopens on the next re-upsert, in both SQLite `ON CONFLICT` targets
and the Postgres path. Two new tests
(`connector-detail-gap-store.test.js`) cover this directly: a null-recovered
row reopens on a later real-run-id re-upsert, and a null-vs-null re-upsert
also reopens (no accidental wildcard match). `terminal` stickiness and the
USAA credential-reason fix are unaffected by this revision.

## Why

`tmp/workstreams/2026-07-14-health-regression/projection-contradictions.md`
hypothesized three connection-health evidence contradictions (Amazon
stale-fact staleness, a local-device connector's evidentiary asymmetry, USAA
attention-lifecycle leak). Live read-only queries against the local Postgres
instance (`docker exec pdpp-postgres-1 psql`, metadata only — no secret
values or record payloads) confirmed two of the three are real, currently-
reproducing defects with a different, more specific mechanism than
hypothesized, and found the third (the local-device connector) does not
currently reproduce from any queryable evidence axis.

**Amazon (`cin_a8ec003e6d441205d646f178`, order_items stream):** not stale-fact
staleness. `connector_summary_evidence.stream_latest_facts_json` and the live
`connector_detail_gaps` table already agree on zero pending gaps. The actual
defect is in `connector-detail-gap-store.js`'s `upsertPendingGap`: a
`recovered` gap's status is sticky **forever**, even across a genuinely new
run re-reporting the same record as a fresh `DETAIL_GAP`. Live evidence: the
connector's own `DETAIL_COVERAGE.covered` count for order_items has been
stuck at exactly 200 while `considered` grew 210→211→212 across every one of
the last 4 "clean" 12h runs (2026-07-09 through 2026-07-13) — 12 order ids
whose detail hydration keeps failing every run, but whose durable gap rows
are frozen `recovered` from months-old prior successes and can never re-enter
either the pending-retry queue (sticky status) or the quarantine escalation
path (`maybeQuarantineGap` only fires from pending/in_progress). The items are
invisible and permanently stuck.

**USAA (`cin_bc1efca69a1c386d610f0924`):** not an attention-lifecycle leak.
`connection-health.ts`'s attention/credential conditions are provably correct
on read — both re-derive live evidence, neither caches. The credential store
row is genuinely `status: active`, `rejected_at`/`rejection_reason` both
null. The actual defect is in `ref-control.ts`'s
`credentialReasonFromGenericFailure` (§10-C): the last USAA run
(`run_1783787246728`, 2026-07-11) emitted TWO known_gaps for the SAME
underlying login-flow stall — a connector-specific
`interaction_required`/`manual_action_required` gap (self-describing "this
exact failure has recurred") AND a generic `run_failed` gap whose message
happens to contain the substring "session_failed" (from the connector-neutral
`establishSession` terminal-error builder in
`packages/polyfill-connectors/src/connector-runtime.ts`) with a
`refresh_credentials` recovery_hint. The classifier trusted the second,
weaker signal and fabricated a `credentials_required`/`session_required`
reason, driving "Reconnect this account" for a credential that was never
rejected — with no active schedule to ever naturally supersede the stale
verdict.

**local-device connector (`cin_2de5ede05c8cc8d45935c414` Claude Code,
`cin_ece4bfe5096b8bf67a1468c2` Codex):** does not currently reproduce. Every
queryable evidence axis is clean: `device_source_instances.outbox_diagnostics_json`
shows `backlog_open: 0, dead_letter: 0, pending: 0, 10000/10000 succeeded` for
both; `last_heartbeat_status: healthy`; `coverage_diagnostics` records show
every store in an accounted status (collected/inventory_only/missing/excluded,
never unaccounted); no open/acknowledged/in_progress attention records; no
credential rows (expected — local-device connectors have none). Tracing the
code path (`deriveOutboxAxisFromHeartbeat` → `idle`,
`localCoverageConditionsByStream` → no degrading axis,
`buildLocalDeviceCollectionEvidence` gate) confirms the health-relevant fixes
already on `main` (`5feb26363`, `2335424d1`, `6128aa101`, all landed
2026-07-07/07-09, before this regression report) are sufficient for the
current live state. No code change proposed for this connector; documented as
verified-not-reproducing rather than assumed fixed.

## What Changes

- `connector-detail-gap-store.js` `upsertPendingGap`: a `recovered` gap
  reopens to `pending` when the re-upsert's `lastRunId` differs from the
  row's own `recovered_run_id` (a later run reporting fresh attempt evidence
  that a previously-closed record broke again). A same-run re-defer (the
  original §10-A regression) is unaffected — `recovered_run_id` still equals
  the current run's id in that case, so the row stays `recovered` and no
  phantom known_gap appears. `terminal` remains unconditionally sticky,
  unchanged.
- `ref-control.ts` `credentialReasonFromGenericFailure` (§10-C): when a
  competing `interaction_required`/`manual_action_required` known_gap exists
  in the same run's known_gaps array, a non-definitive credential signal (a
  bare `refresh_credentials` recovery_hint or a `session_failed`-shaped
  message with no explicit 401/403/`authentication_error`/
  `credential_rejected`/`invalid_token`/`unauthorized`/`forbidden` marker)
  defers to it instead of fabricating a `credentials_required`/
  `session_required` reason. A DEFINITIVE auth-failure signal (401/403/
  explicit rejection language) still wins unconditionally, even alongside a
  competing manual_action gap — this never suppresses a genuinely rejected
  credential.
- No change to `connection-health.ts`/`rendered-verdict.ts` projection logic
  itself in either case — both bugs are upstream input-reconciliation
  defects; the projection layer already implements the documented
  orthogonal-axis model correctly on read.

## Capabilities

- Modified: `reference-connection-health`

## Impact

- `reference-implementation/server/stores/connector-detail-gap-store.js`:
  `upsertPendingGap`'s SQL `ON CONFLICT` status CASE (both SQLite and
  Postgres paths, both conflict targets — `gap_id` and the natural identity
  key).
- `reference-implementation/server/ref-control.ts`:
  `credentialReasonFromGenericFailure` + two new helpers
  (`hasCompetingOwnerInteractionGap`, `isDefinitiveAuthFailureMessage`).
- Tests: `reference-implementation/test/detail-coverage-recovered-gap-regression.test.js`
  (rewrote the same-identity-recovered-gap test into a later-run/same-run
  pair matching the corrected semantics), `reference-implementation/test/connection-health-acceptance.test.js`
  (two new §10-C control tests: the USAA shape must not manufacture a
  credential prompt; a genuine 401/403 must still win even alongside a
  competing manual_action gap).
- Backwards compatible: a gap that never regresses after recovery, and a run
  whose only auth signal is a genuine 401/403, observe no behavior change.
  Only a gap that silently regressed after being marked recovered, and a
  login-flow stall with a competing manual_action classification, change
  behavior — both were the live, reproducing defects this change closes.
- No deploy performed. No live state mutated. All evidence gathered via
  read-only `docker exec pdpp-postgres-1 psql` queries against non-secret
  metadata columns (status/reason/counts/timestamps) — never
  `record_json`/`sealed_secret`/full DOM or error-message payloads.
