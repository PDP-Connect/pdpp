## 1. Durable controller identity

- [x] 1.1 Add a `controller_identity` table on SQLite and PostgreSQL holding one
      row, seeded from `os.hostname()` on the first boot that finds it empty.
- [x] 1.2 Resolve controller identity as `PDPP_CONTROLLER_ID`, then the durable
      row, so the hostname survives only as a first-boot seed and never as the
      live identity.
- [x] 1.3 Keep the boot epoch advancing per boot, so adjudication still separates
      "a prior incarnation owned this" from "I own this".
- [x] 1.4 Add `test/controller-identity-durability.test.ts` proving identity
      survives a simulated container replacement and that a successor's
      ownership filter then selects the predecessor's orphans.

## 2. Single writer for an interrupted terminal state

- [x] 2.1 Remove the `run.failed`/`controller_restarted` emission from the
      controller reconciliation path.
- [x] 2.2 Retain the stale-claim release as
      `releaseAbandonedControllerRunClaims`, since
      `reconcileBrowserSurfaceLeasesAfterBoot` depends on
      `controller_active_runs` to decide which leases are still held.
- [x] 2.3 Update `list-active-runs.sql` and `check-run-terminal.sql` and the
      SQLite/collection-store scheduler drivers for the new terminal vocabulary.
- [x] 2.4 Update tests to the new contract rather than relaxing them: the restart
      test asserts `terminal_status === "abandoned"` and that no `run.failed`
      exists for the run.

## 3. Drop the shutdown drain

- [x] 3.1 Remove the connector drain from the SIGTERM path in `server/index.ts`.
- [x] 3.2 Verify `drainActiveRuns` itself is retained on the controller and that
      exactly one reference is removed — 137 references on the base branch, 136
      after — so the watchdog and `awaitRun` keep working.

## 4. Epoch-fence in-flight manual uploads

- [x] 4.1 Add a NULL-tolerant `owner_epoch` column to `manual_upload_artifacts`
      on both backends, written in the same INSERT that creates the artifact.
- [x] 4.2 Replace the `MANUAL_UPLOAD_IN_FLIGHT_STALE_MS` eligibility predicate
      with the epoch predicate, spelling the NULL arm out explicitly on
      PostgreSQL so `IS DISTINCT FROM` does not reduce to `IS NOT NULL` and
      spare the legacy rows.
- [x] 4.3 Keep the atomic compare-and-swap in `claimForSweep` unchanged in kind,
      stamping `owner_epoch` on a win so a concurrent second claim loses.
- [x] 4.4 Update crash-recovery and artifact-store tests on both backends.

## 5. Repair the stranded backlog (operational)

- [x] 5.1 Add `scripts/repair/adjudicate-orphaned-runs.ts` following the sibling
      repair tools: dry-run by default, `--apply` required to write, full scope
      printed on every invocation, payload-free output, `--limit` bounding.
- [x] 5.2 Select orphans without filtering on `controller_id` — that field is
      what broke — but exclude runs belonging to the newest
      `controller.booted` epoch so live work is never adjudicated.
- [x] 5.3 Snapshot the pre-image of every targeted `run.started` event and every
      re-projected `run_history` row into an `aor_backup` table inside the same
      transaction as the write.
- [x] 5.4 Add `test/adjudicate-orphaned-runs.test.ts` covering idempotency,
      newest-epoch exclusion, and backup completeness.
- [x] 5.5 Run the dry run against production first and confirm the scope before
      `--apply`. Verified: dry run reported 121 after the newest-epoch exclusion
      (123 before it, the two extras being live runs started 90 seconds
      earlier).
- [x] 5.6 Apply. Verified on the live instance: backup table
      `aor_backup_ad8166a2__all__20260821161222` holds 121 spine-event
      pre-images spanning 2026-05-15 to 2026-07-10 across 106 distinct
      controller ids, and the orphan predicate now returns 0.

## 6. Validation

- [x] 6.1 Confirm the corrections against the live database rather than the
      research entry: newest true orphan is 2026-07-10 (the leak is not
      accruing); `manual_upload_artifacts` had no epoch column; zero of the 134
      `controller_restarted` runs also received `run.abandoned` (the reconcilers
      never raced); zero of 34,928 `run.detail_coverage_declared` events carry
      `boundary`, `slice_start`, or `slice_end`.
- [ ] 6.2 Run focused controller, controller-boot, manual-upload, and repair-tool
      suites on both backends, plus typecheck, formatting, and strict OpenSpec
      validation.
- [ ] 6.3 Owner-authorized live verification: after one deploy in a replaced
      container, `SIGKILL` the server mid-run, restart, and assert the run has
      exactly one terminal event and it is `run.abandoned`, with zero
      `needs_human` attention rows and zero pushes. This must run the successor
      in a *new container*, not just a new process — every pre-existing
      boot-orphan test shared a `controller_id` with the orphan it created,
      which is what let the defect survive.
