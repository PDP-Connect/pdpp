# Tasks: fix-scheduled-run-store-credential-injection

## 1. Scheduled-path store resolution

- [x] 1.1 Thread `resolveStaticSecretRunEnv` through `SchedulerOptions` and
      resolve it in `launchRun` before every scheduled/retry launch
      (`runtime/scheduler.ts`).
- [x] 1.2 Wire the controller's resolver
      (`buildControllerStaticSecretRunEnvResolver`) into
      `createReferenceSchedulerManager` so scheduled and manual runs share one
      seam (`server/index.js`).
- [x] 1.3 Fail closed on resolver throw: refuse the launch, no child spawn,
      record `static_secret_credential_unavailable`.

## 2. Store-aware eligibility

- [x] 2.1 Add `hasStoredCredential` to `autoEnrollEligibleSchedules` so an
      active store row satisfies `capabilities.auth.required` when env names
      are absent or empty-string.
- [x] 2.2 Wire the presence-only probe (active instances × active credential
      rows) at the server call site.

## 3. Tests

- [x] 3.1 Env-absent scheduled-run simulation per registry connector
      (github/gmail/ynab/slack) asserting the child env carries store values
      and empty-string env never shadows them
      (`test/scheduler-static-secret-injection.test.js`).
- [x] 3.2 Store-row-suppresses-`credentials_required` regression with an
      incident-shape control case.
- [x] 3.3 Fail-closed resolver-throw test (no child spawned).
- [x] 3.4 Store-aware auto-enroll tests (absent env, empty-string env, no-row,
      probe-throw, env short-circuit).

## 4. Live verification (owner-gated)

- [x] 4.1 Build `pdpp-reference-browser:local` from the fix branch, remove the
      restored credential env lines from `.env.docker`, recreate the reference
      container, and verify owner-session runs reach `run.completed`/succeeded
      for github/ynab/slack/gmail with NO real credential values in the
      container env.
