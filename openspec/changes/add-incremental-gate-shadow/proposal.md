## Why

The incremental gate needs a shadow-only proof path before it can safely affect
developer admission or CI. The shadow path must be deterministic, fail closed on
ambiguous inputs, and produce receipts that can be compared with existing
authority checks without becoming an authority itself.

Without a versioned selector/graph schema and an authority-compatible receipt,
shadow runs can drift from the full gate, advertise files they do not honor, or
emit partial evidence after crashes. Those failures would make later activation
riskier.

## What Changes

- Implement a versioned fail-closed selector and dependency-graph schema for
  the incremental gate shadow evaluator under `scripts/test-accounting/`.
- Implement an authority-compatible shadow receipt that records the exact input
  head, advertised file list, honored file list, bounded closure, NUL diff
  digest, protected fallback state, and report identity.
- Require unactivated shadow mode only: it may report evidence and parity gaps,
  but it must not replace the acceptance/full gate or change CI outcomes.
- Add reproducible acceptance checks for NUL diff handling, protected fallback,
  bounded closure, exact file list advertise-vs-honor, crash-before-receipt,
  and exact head/report matching.

## Impact

- Test-accounting scripts and deterministic tests only.
- No reference implementation behavior changes in this change.
- No CI activation.
- No acceptance/full-gate replacement.
