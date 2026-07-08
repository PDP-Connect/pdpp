# Tasks — Add CDP Mobile Touch Parity

## 0. OpenSpec

- [x] 0.1 Author proposal, design, tasks, and spec delta.
- [x] 0.2 Validate with `openspec validate add-cdp-mobile-touch-parity --strict`.

## 1. Implementation

- [x] 1.1 Port RBS-style DOM touch state into `CdpSurfaceAdapter`.
- [x] 1.2 Preserve programmatic `sendPointer()` behavior.
- [x] 1.3 Clear touch gesture state and motion throttles on unmount.

## 2. Tests

- [x] 2.1 Add a tap regression test that emits CDP mouse press/release, not CDP touch events.
- [x] 2.2 Add a drag regression test for the 8 px threshold and `buttons: 1` moves.
- [x] 2.3 Add a touch-cancel regression test that releases a held drag.
- [x] 2.4 Add a synthetic mouse suppression regression test.

## 3. Validation

- [x] 3.1 Run the CDP adapter test file.
- [x] 3.2 Run remote-surface typecheck.
- [x] 3.3 Run OpenSpec validation.
