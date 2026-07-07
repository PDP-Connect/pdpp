# Tasks

## 1. Spec

- [x] 1.1 Create OpenSpec proposal, design, and requirement delta.
- [x] 1.2 Validate with `openspec validate treat-owner-cancelled-runs-neutral-in-health --strict`.

## 2. Implementation

- [x] 2.1 Exclude owner-cancelled terminal runs from source-health failure classification.
- [x] 2.2 Keep non-owner cancellation and real connector failures classified as before.
- [x] 2.3 Preserve prior successful coverage facts when the latest run was owner-cancelled.

## 3. Tests

- [x] 3.1 Add regression coverage for owner-cancelled latest run projection.
- [x] 3.2 Run targeted connection-health / connector-summary tests and `git diff --check`.
- [x] 3.3 Add stream-report coverage regression for owner-cancelled latest run plus prior successful facts.
