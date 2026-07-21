## 1. Spec and harness

- [ ] Add OpenSpec deltas for the durable single-flight admission gate, live
      invocation retention, and terminal/returned-outcome cleanup semantics.
- [ ] Tighten the active-run conformance scenario so a second insert may throw
      or no-op, but it must never replace the incumbent live row.

## 2. SQLite and Postgres store semantics

- [ ] Change the SQLite active-run write path from overwrite-on-conflict to
      fail-closed admission.
- [ ] Change the Postgres active-run write path to match the same contract.
- [ ] Preserve run-id-scoped delete semantics.
- [ ] Preserve explicit stale-row reconciliation for boot/restart cleanup only.

## 3. Controller and scheduler behavior

- [ ] Route scheduled, manual, and recovery-continuation admission through the
      same durable gate.
- [ ] Preserve neutral conflict handling so duplicate admission is skipped or
      deferred, not escalated into a run failure or health regression.
- [ ] Verify a still-live logical invocation can retain the reservation, while
      any returned queued/deferred/failed outcome clears the reservation and
      nonce.

## 4. Regression coverage

- [ ] Add controller regressions proving an empty in-memory map after restart
      cannot bypass the durable gate.
- [ ] Add scheduler regressions proving scheduled/manual/recovery paths cannot
      bypass the same gate.
- [ ] Add store regressions proving cleanup is run-id-scoped and cannot delete a
      newer row.

## 5. Validation

- [ ] Run focused tests for the conformance harness, controller, scheduler, and
      store adapters.
- [ ] Run `pnpm --dir reference-implementation typecheck`.
- [ ] Run `pnpm --dir reference-implementation check`.
- [ ] Run `pnpm exec openspec validate harden-controller-durable-single-flight-gate --strict`.
- [ ] Run `git diff --check`.
