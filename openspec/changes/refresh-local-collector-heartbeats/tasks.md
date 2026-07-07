## 1. Runtime

- [x] Make local collector terminal heartbeat reporting deterministic for backlog-drain-only and blocked paths.
- [x] Ensure terminal heartbeat failure cannot be hidden behind a successful run result when it is the only current health report.

## 2. Projection

- [x] Verify recent local-device pending work projects as active/draining rather than owner repair.
- [x] Preserve stalled/dead-letter/state-read-blocked remediation semantics.

## 3. Tests

- [x] Add local collector runner regressions for backlog-drain-only and blocked path heartbeats.
- [x] Add or extend connection-health regressions for active local-device work.

## 4. Validation

- [x] `openspec validate refresh-local-collector-heartbeats --strict`
- [x] Relevant local collector tests pass.
- [x] Relevant reference connection-health tests pass.
- [x] Relevant TypeScript checks pass.
