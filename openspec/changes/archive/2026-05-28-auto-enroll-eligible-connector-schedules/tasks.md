## 1. Manifest declarations

- [x] 1.1 Add `capabilities.auth` (kind=env, required=[...]) to the shipped
  manifests for Notion, Oura, and Strava so the reference can reason about
  their env requirements without importing connector code.
- [x] 1.2 Confirm the runtime `auth.required` in each connector module
  matches the manifest declaration.

## 2. Reference auto-enrollment pass

- [x] 2.1 Add a typed enrollment helper that, given the shipped manifests
  directory and a controller, inserts an enabled schedule row for every
  connector matching the five-fact eligibility test (automatic,
  background-safe, listed, proven, all required env present).
- [x] 2.2 Wire the helper into `server/index.js` boot, after
  `reconcilePolyfillManifests` and before scheduler-manager construction.
- [x] 2.3 Honor `PDPP_SKIP_AUTO_SCHEDULE_ENROLLMENT=1` and a constructor opt
  parallel to `PDPP_SKIP_MANIFEST_RECONCILE` / `opts.reconcilePolyfillManifests`.
- [x] 2.4 Never overwrite an existing schedule row. Log a one-line summary
  (`scanned`, `enrolled`, `skipped_env`, `skipped_existing`, `skipped_policy`).

## 3. Tests

- [x] 3.1 Eligible-with-env: cover a synthetic listed/proven/automatic
  manifest whose declared env vars are set on `process.env`. Expect a new
  enabled schedule row at the manifest-recommended interval.
- [x] 3.2 Eligible-without-env: cover the same manifest with one declared
  env unset. Expect no schedule row created and the doctor still emits
  `NOSCHED` (covered by the existing `scheduler-doctor` NOSCHED test, which
  remains green after this slice).
- [x] 3.3 Manual/paused/unsafe/unproven: cover at least one of each
  category. Expect no schedule row even when env is present.
- [x] 3.4 Idempotency: invoke the pass twice and confirm the second pass
  is a no-op for the row from the first pass; an operator-paused row stays
  paused.
- [x] 3.5 Doctor reflection: scheduler-doctor cross-reference behavior is
  pinned by the existing `scheduler-doctor.test.js` suite, which continues
  to pass after the boot-time enrollment slice lands.

## 4. Acceptance Checks

- [x] 4.1 Run focused enrollment + scheduler-doctor tests.
- [x] 4.2 Run `openspec validate auto-enroll-eligible-connector-schedules --strict`.
- [x] 4.3 Run `openspec validate --all --strict`. The prior no-delta note
  proposals were moved to `design-notes/`, so full validation is now green.
