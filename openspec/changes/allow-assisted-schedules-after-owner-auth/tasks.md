## 1. Spec And Manifest Semantics

- [x] 1.1 Add OpenSpec deltas for refresh-policy metadata and reference manifest honesty.
- [x] 1.2 Validate `allow-assisted-schedules-after-owner-auth` with `openspec validate --strict`.

## 2. Implementation

- [x] 2.1 Extend the refresh-policy validator/type shape with `assisted_after_owner_auth`.
- [x] 2.2 Update manifest honesty tests for the `needs_human_auth` assisted exception.
- [x] 2.3 Update ChatGPT manifest to automatic/background-safe assisted scheduling.
- [x] 2.4 Update schedule/run-policy tests affected by the ChatGPT posture change.

## 3. Verification

- [x] 3.1 Run focused manifest, honesty, run-policy, and schedule tests.
- [x] 3.2 Reconcile/restart the local reference and prove ChatGPT schedule creation succeeds at the conservative interval.
- [x] 3.3 Update the owner ledger with active lanes, validation, and residual risks.
