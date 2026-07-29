## 1. Terminal evidence handoff

- [x] 1.1 Add a device-authenticated terminal-collection client and reference route.
- [x] 1.2 Emit only after successful DONE, drained records, and coverage checkpoint acknowledgement.
- [x] 1.3 Write an attributable terminal spine event with safe per-stream facts for the existing fold.

## 2. Verification

- [x] 2.1 Add SQLite and Postgres integration coverage for successful, optional, and failed/incomplete terminal cases.
- [x] 2.2 Run typecheck, mass, diff/privacy, and OpenSpec gates.

## Residual risk

Live deployment acceptance remains owner-operated: a successful device cycle must show an attributable terminal spine event and current folded facts without disclosing payloads.
