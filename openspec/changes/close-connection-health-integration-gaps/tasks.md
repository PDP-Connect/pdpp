## 1. Slack four-stream collection (port + re-verify)

- [x] Port `slack-api.ts`, `parsers.ts`/`types.ts` additions, manifest change,
  README fix, and generated `stream-evidence-inventory.md` from
  `waspflow/slack-full-coverage-0710` (`8a766c9f6`, `2010f4e7a`) onto current
  main.
- [x] Re-run the full `packages/polyfill-connectors` test suite (not just
  Slack) to catch cross-connector regressions from the shared
  `provider-profile.ts` addition. 2427/2433 pass, 0 fail.
- [x] Re-run `reference-implementation/test/slack-collection-report.test.js`.
  10/10 pass.
- [x] Confirm the manifest no longer declares any of `stars`, `user_groups`,
  `reminders`, `dm_read_states` as `coverage_policy:deferred` or
  `availability.state:unsupported_in_mode`. Confirmed via
  `stream-evidence:check` PASS.

## 2. USAA root-cause correction (port + re-verify)

- [x] Port `fbd553656` (revert `source_unavailable` bypass, restore
  `manual_action`, add `captureDom` threading) onto current main.
- [x] Confirm `53ff53c8c` (scheduler-retry-classifier trusting explicit
  `connector_error.retryable`) is present and untouched by the revert.
- [x] Run `packages/polyfill-connectors/src/auto-login/usaa.test.ts`,
  `connectors/usaa/**/*.test.ts`, `src/connector-runtime*.test.ts`,
  `reference-implementation/test/scheduler-retry-classifier.test.js`. All
  pass (17/17 scheduler-retry-classifier; full package suite 2427/2433).
- [x] Update `openspec/changes/fix-source-unavailable-recovery-classification`
  with the correction addendum (restored `design.md` + spec delta the LFDT
  curation had deleted); validates `--strict`.

## 3. Active-run dominance fix (port + verify stream-row consistency)

- [x] Port `41bad54e7` (`rendered-verdict.ts` amber-label softening,
  `source-actionability.ts` fix, `isStalledOutboxActionable`/
  `isOwnerPausedScheduleEligible`/`shouldOfferRefreshNowAction` extraction).
- [x] Re-verify the gate report's P1 concern: confirmed live via probe that
  `streamStatement(disposition)` in `rendered-verdict.ts` (NOT the console —
  the console's `formatStreamCollectionFacts` reads the server-synthesized
  `statement` field) rendered "Up to date once you refresh." while the
  connection-level pill read `Syncing`. Fixed: `streamStatement` now takes
  `snapshot.badges.syncing` and renders "Refreshing now." for an
  `owner_refresh_due` stream while a run is advancing.
- [x] Run `rendered-verdict.test.js`, `source-actionability.test.ts`, and the
  new regression. 82/82 and 19/19 pass respectively.

## 4. Reddit manual-freshness alignment + ratified schedule test fix

- [x] Port `be56bcf7c` (Reddit `background_safe:true` +
  `assisted_after_owner_auth:true`, corrected `human_interaction`/
  `interaction_posture`) and `c8f670457` (`minimum_interval_seconds:7200`).
- [x] Port `3d7aff2ac` (Amazon→USAA schedule-test rename fix); resolved a
  comment-only conflict with the Reddit port (both accurately describe
  Amazon+Reddit as background_safe:true) and a duplicate-test conflict
  (kept one Amazon test + one USAA test, no duplicate). No other test
  assertions changed beyond these ratified fixes.
- [x] Run `owner-connection-schedule.test.js`,
  `auto-enroll-eligible-schedules-integration.test.js`,
  `connection-health-acceptance.test.js`, `connection-health.test.js`,
  `refresh-evidence-wiring.test.js`, `run-interaction-stream-neko-compose.test.js`,
  `scheduler-doctor.test.js`. 226/226 pass.

## 5. Accepted-absence copy fix (port, re-scope)

- [x] Port `fa5be19ae` (`connection-evidence.ts` COVERAGE_LABELS copy fix).
  Its original OpenSpec home (`show-stream-coverage-proof-labels`) was
  deleted entirely by the LFDT curation with no surviving spec delta;
  documented as a new ADDED requirement in this change instead of
  resurrecting an orphaned change directory.
- [x] Confirmed the copy fix is safe now that Slack no longer has any stream
  in accepted-absence state: `coverage-policy-manifest-honesty.test.ts`
  (2/2) and `stream-evidence:check` both confirm zero required+accepted
  -absence contradictions anywhere in the manifest set.
- [x] Run `collection-report.test.ts`, `connection-evidence.test.ts`.
  178/178 pass.

## 6. Production-ready connector roster (test-only, no manifest field, no source scan)

- [x] Write `packages/polyfill-connectors/src/connector-conformance-roster.ts`:
  `PRODUCTION_READY_CONNECTORS` (17 entries, each naming its own existing
  collection/integration test file as the behavioral oracle) and
  `KNOWN_SCAFFOLD_CONNECTORS` (the 9 no-collection connectors: `anthropic`,
  `doordash`, `heb`, `linkedin`, `loom`, `meta`, `shopify`, `uber`,
  `wholefoods`).
- [x] Write `packages/polyfill-connectors/src/connector-conformance.test.ts`:
  cross-checks the roster's connector set against every manifest declaring
  `capabilities.public_listing.listed === true` (drift either direction
  fails); asserts every roster `testFile` exists; asserts the two rosters
  are disjoint; asserts known scaffolds are never listed; asserts every
  roster key resolves to a real manifest file.
- [x] Confirmed all 9 scaffolds already satisfy `public_listing.listed:false`
  (verified programmatically against all 33 manifests, not assumed).
- [x] Ran the new test (5/5 pass) plus `coverage-policy-manifest-honesty.test.ts`
  (2/2) and `browser-manifest-honesty.test.ts` (1/1) — no regression.
- Residual, explicitly not attempted: no generic runner executes every
  connector's `collect()`. Each connector's own named test file remains the
  sole behavioral oracle for whether it really collects real data; this
  gate only proves the roster and the manifest listing state agree.

## 7. Mass-ratchet complexity reduction (owner-mandated gate)

- [x] Reduced `runtime/connection-health.ts` complexity mass from measured 93
  to 92 (extracted `isExternalToolUnavailableReason`).
- [x] Reduced `runtime/connector-verdict-input.ts` from measured 3 to 2
  (extracted `scheduledProgressMode`).
- [x] Reduced `runtime/rendered-verdict.ts` from measured 83 (post active-run
  port) to exactly 75 (extracted `retryGapStuckSinceText` and
  `staleRefreshPolicyText` out of `freshnessAnnotationText`).
- [x] Did not touch `server/ref-control.ts` (separate lane; still fails at
  206 vs baseline 203 — left for the owner's separate lane as instructed).
- [x] Did not raise any baseline ceiling; `--all` run only tightened
  (`run-coordinator.ts` 103→102, `connector-gap-bounding.ts` 84→80,
  `index.js` 761→678, `search.js` 205→87 — all strictly downward).
- [x] Re-ran `check-mass-ratchet.mjs --all`: only `server/ref-control.ts`
  fails (explicitly out of scope).

## 8. Validation

- [x] `openspec validate close-connection-health-integration-gaps --strict`
- [x] `openspec validate --all --strict` (47/47 pass)
- [x] `pnpm --dir reference-implementation typecheck`
- [ ] `pnpm --dir apps/console types:check`
- [x] `pnpm --dir packages/polyfill-connectors typecheck && pnpm --dir packages/polyfill-connectors test`
  (2432/2438 pass, 0 fail, 6 pre-existing skips)
- [ ] `pnpm --dir reference-implementation check` (full, not just touched files)
- [ ] Full `apps/console` test suite for touched files
- [x] Mass ratchet full-repo check (`--all`) — only `server/ref-control.ts`
  fails (out of scope).
- [ ] Personally inspect the final combined diff before reporting complete.

## 9. Reporting

- [ ] Commit in logical tranches (one per section above), each with an
  explicit reference to the source commit(s) ported and any rework applied.
- [ ] Report exact included/rejected/reworked commits, gates passed, and
  residual live-only proof items (deployed-revision check, live
  `stream-health:audit`, next USAA live capture, live schedule re-pull) for
  the owner. No push, merge, or deploy.
