## 1. Implementation

- [x] 1.1 Add a shared refresh-policy schedule eligibility helper.
- [x] 1.2 Reject create/update/resume attempts that would enable unsafe schedules.
- [x] 1.3 Skip legacy unsafe enabled schedules during scheduler-manager refresh.
- [x] 1.4 Skip automatic scheduler runs when deployment/runtime prerequisites are not ready.
- [x] 1.5 Surface `ineligibility_reason` for stale enabled rows on schedule list/get API and dashboard.
- [x] 1.6 Extend `scheduler-doctor` to cross-reference `/_ref/connectors` against `/_ref/schedules` and surface `NOSCHED` (auto-eligible, not enrolled) and `MANUAL` (gated, correctly unscheduled) verdicts so operators can tell enrollment gaps from gated connectors at a glance.

## 2. Tests

- [x] 2.1 Cover route-level rejection for unsafe connector schedule creation.
- [x] 2.2 Cover resume rejection for an unsafe disabled schedule.
- [x] 2.3 Verify automatic/background-safe schedule behavior still works.
- [x] 2.4 Verify scheduler not-ready skips are recorded once per stable reason.
- [x] 2.5 Cover schedule list/get API surfacing `ineligibility_reason` for a stale enabled row.
- [x] 2.6 Cover `scheduler-doctor` `NOSCHED`/`MANUAL` cross-reference verdicts and verify connectors that have a persisted row are not double-counted.

## 3. Acceptance Checks

- [x] 3.1 Run focused controller/schedule tests.
- [x] 3.2 Run OpenSpec validation for this change.
- [x] 3.3 Run focused scheduler readiness tests.
