## 1. Bounded frame delivery

- [x] 1.1 Keep frame promotion behind the presentation acknowledgement gate and report stale delivery.
- [x] 1.2 Fetch one coalesced replacement at the latest epoch when a fetched frame is stale, without creating a retry queue.

## 2. Deterministic regression coverage

- [x] 2.1 Convert the first-frame starvation oracle into a required passing test.
- [x] 2.2 Add a bounded-churn test that proves a fixed number of orientation oscillations uses at most two fetches in one polling cycle.

## 3. Acceptance checks

- [x] 3.1 Run the full n.eko adapter suite, the stream route suites, and `pnpm stream:parity:oracle`.
- [x] 3.2 Re-run the presentation safety batch and surface-reconciliation suites with unchanged test counts.
- [x] 3.3 Verify the touched source set has non-increasing complexity mass and a non-positive lint delta against `6919f542b`.
- [x] 3.4 Run `openspec validate fix-neko-first-frame-liveness --strict` and `openspec validate --all --strict`.
