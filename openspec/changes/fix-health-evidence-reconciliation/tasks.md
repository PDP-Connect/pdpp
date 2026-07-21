## 1. Live-evidence investigation (read-only, no live mutation)

- [x] Query `connector_summary_evidence`, `connector_detail_gaps`,
  `scheduler_run_history`, `spine_events` for Amazon `cin_a8ec003e6d441205d646f178`
  order_items stream — confirmed durable fact block already zero pending gaps
  but the connector's own `DETAIL_COVERAGE.covered` count is stuck below
  `considered` on every one of the last 4 runs.
- [x] Query `connector_attention_records`, `connector_instance_credentials`,
  `scheduler_run_history`, `spine_events` for USAA `cin_bc1efca69a1c386d610f0924`
  — confirmed credential is `status: active`/not rejected, attention record
  for the triggering failure is `expired`, and the run's own `known_gaps`
  carry a competing `interaction_required`/`manual_action_required`
  classification of the same failure.
- [x] Query `device_source_instances`, `records` (coverage_diagnostics
  metadata only), `connector_attention_records`, `connector_instance_credentials`
  for the local-device connector's Claude Code `cin_2de5ede05c8cc8d45935c414` and Codex
  `cin_ece4bfe5096b8bf67a1468c2` instances — every axis clean; does not currently
  reproduce Degraded.

## 2. Amazon / shared gap-store fix

- [x] `connector-detail-gap-store.js` `upsertPendingGap`: split the sticky
  `IN ('recovered','terminal')` CASE into `terminal` (unconditional) and
  `recovered` (sticky only when `recovered_run_id` equals the incoming
  `last_run_id`), for both SQLite `ON CONFLICT` targets (`gap_id` and the
  natural identity key) and the Postgres path.
- [x] Rewrite `detail-coverage-recovered-gap-regression.test.js`'s
  same-identity-recovered test into a later-run/same-run pair matching the
  corrected semantics; verify `upsertPendingGap does not revive a terminal
  gap` still passes unchanged.
- [x] Full `connector-detail-gap-store.test.js` + `terminal-gap-class.test.js`
  + `terminal-gap-no-silent-skip.test.js` suites green (60 pass, 3 Postgres
  skips).

## 3. USAA / shared credential-reason-classification fix

- [x] `ref-control.ts` `credentialReasonFromGenericFailure`: add
  `hasCompetingOwnerInteractionGap` + `isDefinitiveAuthFailureMessage`; defer
  to a competing owner-interaction gap for non-definitive credential signals
  only, never for a definitive 401/403/rejection marker.
- [x] Add two `connection-health-acceptance.test.js` control tests matching
  the live USAA shape (suppressed) and a definitive-401-alongside-competing-gap
  case (not suppressed).
- [x] Full `connection-health-acceptance.test.js` suite green (59 pass),
  including the pre-existing four §10-C tests (401 flattened, ChatGPT
  session-required, non-auth control, source_unavailable control).

## 4. local-device connector — documented, no code change

- [x] Confirmed via live query that `deriveOutboxAxisFromHeartbeat` resolves
  `idle` (healthy heartbeat, zero pending), `localCoverageConditionsByStream`
  has no degrading axis (every coverage_diagnostics store is
  collected/inventory_only/missing/excluded, none unaccounted), and no open
  attention exists for either connection.
- [x] Traced the health-relevant local-device fixes already on `main`
  (`5feb26363`, `2335424d1`, `6128aa101`, landed 2026-07-07/07-09) and
  confirmed they predate and are sufficient for the current clean live state.
- [x] Documented as verified-not-reproducing in proposal.md and the final
  report, per the standing acceptance-gate discipline (code-complete vs.
  closed are never the same word) — no fabricated fix for an unconfirmed
  mechanism.

## 5. Verification (initial implementation)

- [x] `npx tsc --noEmit -p tsconfig.json` clean.
- [x] Full affected test files green: `connector-detail-gap-store.test.js`,
  `terminal-gap-class.test.js`, `terminal-gap-no-silent-skip.test.js`,
  `detail-coverage-recovered-gap-regression.test.js`,
  `connection-health-acceptance.test.js`.

## 6. Revision — P1 null recovered_run_id (independent review)

- [x] Dropped the `recovered_run_id IS NULL OR ...` disjunct from the
  `upsertPendingGap` status CASE in all three ON CONFLICT branches (SQLite
  `gap_id`, SQLite identity key, Postgres identity key) — plain
  `recovered_run_id = excluded.last_run_id` (`= EXCLUDED.last_run_id` in
  Postgres), relying on SQL NULL-comparison semantics to never match.
- [x] Added `connector-detail-gap-store.test.js`: "a gap recovered with NO
  run id reopens to pending on any later re-upsert" (reproduces the
  reviewer's exact repro shape) and "...then re-upserted with ALSO no run
  id, still reopens" (null-vs-null does not accidentally match).
- [x] `pnpm --dir reference-implementation exec tsc --noEmit` clean.
- [x] `node --test --test-force-exit test/connector-detail-gap-store.test.js` — 38 pass, 3 skip.
- [x] `node --test --test-force-exit test/detail-coverage-recovered-gap-regression.test.js` — 5/5 pass.
- [x] `node --test --test-force-exit test/connection-health-acceptance.test.js` — 59/59 pass (terminal/USAA behavior unaffected).
- [x] `node --test --test-force-exit test/terminal-gap-class.test.js test/terminal-gap-no-silent-skip.test.js` — 24/24 pass, including `upsertPendingGap does not revive a terminal gap`.
- [x] `openspec validate fix-health-evidence-reconciliation --strict` passes.
- [ ] Full reference-implementation suite (residual — see final report).
