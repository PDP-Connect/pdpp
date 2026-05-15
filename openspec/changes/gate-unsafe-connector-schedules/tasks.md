## 1. Implementation

- [x] 1.1 Add a shared refresh-policy schedule eligibility helper.
- [x] 1.2 Reject create/update/resume attempts that would enable unsafe schedules.
- [x] 1.3 Skip legacy unsafe enabled schedules during scheduler-manager refresh.

## 2. Tests

- [x] 2.1 Cover route-level rejection for unsafe connector schedule creation.
- [x] 2.2 Cover resume rejection for an unsafe disabled schedule.
- [x] 2.3 Verify automatic/background-safe schedule behavior still works.

## 3. Acceptance Checks

- [x] 3.1 Run focused controller/schedule tests.
- [x] 3.2 Run OpenSpec validation for this change.
