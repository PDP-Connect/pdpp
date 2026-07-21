## 1. Physical cursor

- [x] 1.1 Implement and test stable LF-boundary scanning with full-prefix SHA-256.
- [x] 1.2 Prove touch, append, partial-line, full-prefix mutation beyond 64 KiB, truncation, replacement, concurrent rewrite-plus-growth rejection, and unstable-source decisions.

## 2. Claude integration

- [x] 2.1 Add tolerant v1 session and child state decoding with legacy dual-write migration; fail closed to an all-session rebuild for corrupt, partial, or missing rich session snapshots.
- [x] 2.2 Integrate independent child cursors and parser continuation.
- [x] 2.3 Integrate session cursors, aggregate snapshots, changed-record comparison, and conservative rebuilds.

## 3. Acceptance and closeout

- [x] 3.1 Add one-to-one M1–M24 subprocess/physical/runner coverage, a fixed-seed current-fold oracle, bounded-state/privacy assertions, and the actual Claude runner/outbox mtime-touch proof.
- [x] 3.2 Kill the five required mutants (zero append offset, 64 KiB head-only hash, missing parser continuation, empty incremental aggregate seed, raw-EOF commit) and add aggregate-only telemetry.
- [x] 3.3 Run focused/non-browser full package gates, typecheck, lint, strict OpenSpec, diff review, and touched-file lint delta.
- [x] 3.4 Record verified evidence and residual limits in the required report, then commit one coherent closure change.
