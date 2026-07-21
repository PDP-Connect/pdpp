# Tasks — allow-owner-opt-in-manual-default-schedules

## 1. Spec delta

- [x] Write the proposal, design, and task artifacts.
- [x] Add the spec deltas for schedule capability, owner opt-in, and health
      projection.
- [x] Run `openspec validate allow-owner-opt-in-manual-default-schedules --strict`.
- [x] Run `openspec validate --all --strict`.

## 2. Implementation

- [x] Allow explicit owner-created schedules for manual-default connectors when
      `background_safe: true`.
- [x] Keep `paused` and `background_safe: false` as hard prohibitions.
- [x] Make scheduled manual-default/background-safe connections project as
      scheduled rather than `stale_manual_refresh`.
- [x] Update Amazon's manifest to stay manual-by-default with
      `background_safe: true` and `assisted_after_owner_auth: true`.
- [x] Add focused tests for explicit opt-in success, no auto-enroll, hard
      prohibition cases, scheduled-run policy, and health projection.

## 3. Verification

- [x] Run the focused unit/integration tests that cover schedule policy and
      connection-health projection.
- [x] Run any touched typechecks or test subsets needed for the runtime changes.
- [x] Write `tmp/workstreams/amazon-optin-schedule-report.md`.

## Acceptance checks

```sh
openspec validate allow-owner-opt-in-manual-default-schedules --strict
openspec validate --all --strict
git diff --check
```
