## Context

The desired first tranche is a shadow evaluator, not an enforcing gate. Its job
is to prove that a smaller incremental decision can be described, replayed, and
compared with the current authority without letting that decision affect merge
admission.

The contract therefore treats every shadow input as evidence. If the evaluator
cannot prove its selector, graph, diff, closure, file list, or report identity, it
must produce a typed shadow failure or no receipt. It must not silently promote a
partial result into authority-compatible evidence.

## Decision

Add a versioned shadow contract with three boundaries:

- selector schema: the explicit changed-input selector, protected-path fallback
  rule, and file-list identity used by the shadow evaluator
- graph schema: a bounded dependency closure over repository files, with explicit
  truncation/fallback when the closure cannot be proven within configured limits
- receipt schema: an append-only, authority-compatible report that can be joined
  to an existing authority/full-gate report by exact repository head and report
  identity

The shadow receipt is compatible with the authority model because it records
comparable facts. It is not itself an authority. Shadow mode may run locally or
in an opt-in harness, but this change does not activate CI, block merges, skip
the full gate, or mark acceptance as satisfied.

## Acceptance Checks

Acceptance must be reproducible from a clean checkout using checked-in fixtures
or deterministic temporary repositories. The checks are implementation tasks, but
the expected behavior is part of this design:

- NUL diff: a diff containing NUL-delimited file names, spaces, newlines, and
  shell-sensitive characters is parsed as data; the receipt records the exact
  digest and file identities without shell splitting.
- Protected fallback: a change touching a protected path forces typed fallback
  to full-gate-needed shadow evidence and cannot emit a partial green shadow
  receipt.
- Bounded closure: a dependency graph exceeding the configured node or edge
  limit records bounded fallback with the observed counts and cannot claim a
  complete closure.
- Exact file list advertise-vs-honor: every advertised file is either honored in
  the graph closure or rejected with a typed reason; any missing or extra honored
  file fails the check.
- Crash-before-receipt: a process crash after evaluation begins but before the
  receipt commit leaves no terminal success receipt; any resumable partial record
  is typed non-authoritative.
- Exact head/report: a shadow receipt joins an authority/full-gate report only
  when both record the same repository head and the exact referenced report
  identity.

## Alternatives Considered

- Activate the incremental gate in CI immediately. Rejected: the shadow contract
  must prove replayability and authority compatibility first.
- Let shadow success replace the acceptance/full gate for small changes.
  Rejected: this tranche is measurement only.
- Use an unversioned receipt shape. Rejected: later activation or schema changes
  would make old evidence ambiguous.
- Treat graph truncation as a warning. Rejected: an incomplete closure is a gate
  uncertainty and must fail closed.
