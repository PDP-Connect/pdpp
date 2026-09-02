## 1. Bootstrap lock

- [x] 1.1 Resolve a strict positive override or a database-size-aware default.
- [x] 1.2 Replace fixed attempts with one deadline and bounded backoff.
- [x] 1.3 Emit budget, periodic progress, acquisition, and timeout evidence.

## 2. Readiness ordering

- [x] 2.1 Keep required schema bootstrap before AS/RS listener binding.
- [x] 2.2 Defer optional manifest reconciliation until after both listeners bind.
- [x] 2.3 Preserve reconciliation-before-retrieval maintenance ordering.
- [x] 2.4 Isolate post-listener maintenance failures from serving readiness.

## 3. Verification

- [x] 3.1 Add contention, deadline, no-crash-loop, ordering, and failure-isolation tests.
- [x] 3.2 Add the disposable exact-image populated-PostgreSQL oracle.
- [x] 3.3 Run the oracle and attach its non-stale report to the repair handoff.

## Acceptance checks

- `openspec validate repair-bootstrap-readiness --strict`
- `openspec validate --all --strict`
- Focused reference tests and typecheck pass.
- The exact-image oracle runs with no production connection and reports zero
  restarts.
