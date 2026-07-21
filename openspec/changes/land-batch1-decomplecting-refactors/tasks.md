## 1. Land accepted source commits in owner-specified order

- [x] 1.1 W3 streaming (4): `2202f623f`, `35fcc92a7`, `cd529c45a`,
      `511d7df9d` — excluding `mass-baseline.json` and root receipt
      `w3-streaming-plan.md`.
- [x] 1.2 T3 safe subset (7): `87a5788e7`, `3df4e3497`, `114d53d35`,
      `fd461cecc`, `5230171eb`, `603e2b922`, `179eda6e9` — explicitly
      excluding `9d6507064` (rejected metric-only helper), `0632db104`
      (superseded by W3 streaming's neko commit), `b42b2c423` (superseded by
      W3 streaming's CDP commit), `bc870a368` (ratchet-only; baseline
      regenerated from the final tree instead).
- [x] 1.3 W3 ref-control (4): `c281c01d4`, `f54d68614`, `b4ad00612`,
      `48f38fa1c` — excluding `mass-baseline.json` and root receipts
      `w3-refctl-plan.md`, `w3rc-report.md`.
- [x] 1.4 T6 (12): `f74a38b0b`, `373dc5349`, `b8e6198d7`, `ce3d1ff1d`,
      `71cf86790`, `994f53b0b`, `65b5bbd14`, `a39fa19d6`, `49ad4b037`,
      `eff0785fe`, `4b10abb5d`, `faef3da78` — excluding `mass-baseline.json`.
- [x] 1.5 No `rc-*` branch merged as a unit; every commit above landed as an
      exact cherry-pick.

## 2. Resolve real conflicts without changing tests

- [x] 2.1 `server/ref-control.ts` (`48f38fa1c` vs. curated tree): applied
      the incoming decomposition (`indexCollectionReportInputs`,
      `deriveCollectionReportEntryCoverage`) onto the curated
      `resolveEffectiveStreamFacts`/`EffectiveStreamFact` evidence-provenance
      model, preserving `evidence_as_of`, `required`, same-run checkpoint
      inheritance gating, and `schedule` threading into
      `deriveForwardDisposition`. No test file touched.
- [x] 2.2 `runtime/browser-surface/run-coordinator.ts` (`f74a38b0b` vs.
      curated tree): kept the curated bounded retry/backoff chain
      (`stopSurfaceWithRetry`/`stopSurfaceRetryStep`/`attemptStopSurface`/
      `announceReclaimRetry`, added for the 2026-07-10 capacity incident) and
      applied T6's extraction of `ensureStartingBrowserSurfaceReady`,
      `persistCapacityPressureReclaim`, `buildCapacityPressureReclaimResult`
      around it. No test file touched.

## 3. Regenerate the mass baseline once

- [x] 3.1 `node scripts/quality-ratchet/regenerate-mass-baseline.mjs` run
      once, after all 27 source commits were composed.
- [x] 3.2 `node scripts/quality-ratchet/check-mass-ratchet.mjs --all` passes
      against the regenerated baseline (177 files checked).
- [x] 3.3 Baseline committed as its own commit, separate from every source
      commit.

## 4. Verification gate

- [x] 4.1 `pnpm --dir reference-implementation run typecheck` clean.
- [x] 4.2 `git diff --check` clean across the full integration range.
- [x] 4.3 Targeted tests for every manually-merged file green:
      `test/collection-report-projection.test.js`,
      `test/slack-collection-report.test.js`,
      `test/stream-evidence-shipped-manifests.test.js` (88/88);
      `test/controller-browser-surface-leases.test.js` plus 6 other
      browser-surface test files (110/110).
- [x] 4.4 Full `reference-implementation` suite run with per-file isolated
      Postgres databases (`PDPP_TEST_POSTGRES_URL` against the local
      `pdpp-postgres-1` container's `postgres` admin database; each test
      file gets its own ephemeral `pdpp_test_*` database, dropped after).
      637 test files, 6855 passing assertions, 2 failures
      (`test/owner-connection-schedule.test.js` "owner-agent resume is
      blocked when the connector refresh policy forbids automation" and
      `test/run-interaction-stream-neko-compose.test.js` "Amazon remains an
      owner-present managed n.eko connector, not background-safe") — both
      reproduced identically on a clean checkout of base `8a1e0875d` in an
      isolated worktree, confirming they pre-date this integration.
- [x] 4.5 `openspec validate land-batch1-decomplecting-refactors --strict`
      and `openspec validate --all --strict` pass (one pre-existing,
      unrelated failure on `fix-source-unavailable-recovery-classification`,
      also present at base `8a1e0875d`).
- [x] 4.6 Independent inspection of the combined diff for export, wire,
      auth, and ordering changes outside the two manually-merged files.
