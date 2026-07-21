## 1. Physical cursor

- [x] 1.1 Implement and test stable LF-boundary scanning with full-prefix SHA-256.
- [x] 1.2 Prove touch, append, partial-line, prefix mutation, truncation, replacement, and unstable-source decisions.

## 2. Claude integration

- [x] 2.1 Add tolerant v1 session and child state decoding with legacy dual-write migration.
- [x] 2.2 Integrate independent child cursors and parser continuation.
- [x] 2.3 Integrate session cursors, aggregate snapshots, changed-record comparison, and conservative rebuilds.

## 3. Acceptance and closeout

- [x] 3.1 Add subprocess mutation-grade coverage and state-shape assertions; existing runner checkpoint tests remain the crash/retry barrier oracle.
- [x] 3.2 Run focused/full package gates, typecheck, lint, strict OpenSpec, diff review, and touched-file lint delta.
- [x] 3.3 Record verified evidence and residual limits in the required report, then commit one coherent change.
