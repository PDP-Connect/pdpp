# Proposal: fix-scheduled-run-store-credential-injection

## Why

The 2026-06-09 incident: four connections were migrated env→store and verified
green via MANUAL runs, but the scheduler's launch path
(`runtime/scheduler.ts::launchRun` → `runConnector`) never consulted the
encrypted per-connection credential store — only `controller.runNow` resolved
`staticSecretEnv`. When the reference container was recreated without the old
secret exports, compose `${VAR:-}` mappings left the credential env vars as
EMPTY STRINGS, and every scheduled static-secret run raised
`credentials_required` ("github needs: GITHUB_P..."), auto-cancelled, and
reported `connector_reported_failed` while valid store rows sat unread.

The durable spec already requires the orchestrator to recover the stored
secret "when a scheduled run begins" (reference-connector-instances —
"Credential is recoverable only by the orchestrator"). The implementation
violated that on the scheduled path; this change converges it and pins the
adjacent honesty rules the incident exposed.

## What Changes

- The scheduler resolves the connection-scoped static-secret env fragment
  through the SAME resolver the controller uses for manual runs, before every
  scheduled launch, and threads it to the spawn where it merges LAST over
  `process.env`.
- A resolver throw fails closed: the launch is refused (no connector child),
  recorded as `static_secret_credential_unavailable`.
- Auto-enrollment eligibility becomes store-aware: an active per-connection
  store credential satisfies `capabilities.auth.required` when the env names
  are absent or empty-string.

## Impact

- Specs: `reference-connector-instances` (delta below).
- Code: `reference-implementation/runtime/scheduler.ts`,
  `reference-implementation/server/index.js`,
  `reference-implementation/server/auto-enroll-eligible-schedules.ts`.
- No wire-protocol change; no console change.
