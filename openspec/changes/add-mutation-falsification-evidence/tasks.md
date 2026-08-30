## 1. Existing-Oracle Structured Evidence

- [x] 1.1 Define versioned adapter-specific intent, attempt, and triage schemas for `test-migration-oracle/v1`, naming RFC 8785 JSON canonicalization plus SHA-256, including golden vectors and explicit integrity-versus-authenticity language. (schemas.ts is adapter-agnostic and used by every adapter, including test-migration-oracle/v1; canonicalize.ts carries the golden vectors and integrity-vs-authenticity comment.)
- [x] 1.2 Add structured JSON output to the existing test-migration oracle without changing its named mutations, judges, positive control, fixture lifecycle, human output, or rollback proof.
- [x] 1.3 Add differential tests requiring legacy and structured modes to report identical cases, catching checks, holes, positive-control result, and rollback result.
- [ ] 1.4 Add bounded adapter-local execution evidence with issued, incomplete, and completed states, an external evidence root, finite wall and direct-output limits, and exact source-checkout unchanged proof.
- [ ] 1.5 Add corruption, unknown-version, partial-output, output-flood, timeout, missing-case, missing-control, interrupted-marker, and cleanup-evidence tests; prove a later run blocks instead of automatically reclaiming an incomplete attempt and that retirement emits a separate recovery receipt.
- [ ] 1.6 Run the legacy and structured oracle twice on clean revisions, record runtime and artifact costs, and obtain independent review before starting the domain pilot.

## 2. Trusted GroupMe Domain Pilot

- [ ] 2.1 Register two or three reviewed declarative operators for GroupMe page-ceiling and cursor-progress risks, with exact implementation preimages, permitted postimages, and immutable judge closure.
- [ ] 2.2 Implement independent no-hardlink disk-backed clones with isolated `HOME`, `TMPDIR`, XDG, pnpm, Git, accounting, and test paths; use copy-only dependency import semantics; pin and record Node/pnpm executables and dependency identity; preflight the exact clean commands.
- [ ] 2.3 Record focused clean and mutant GroupMe checks as adapter evidence; do not label them test-accounting authority receipts.
- [ ] 2.4 Run the clean complete `polyfill-connectors` backstop at each locked batch start; run the mutant backstop for every focused survivor; copy and revalidate the complete authority bundle outside the disposable clone before deletion; test evidence budgets, 30-day minimum retention, and the two-hour digest-identical reuse rule.
- [ ] 2.5 Implement the total projection table and no-automatic-retry rule; add fault-injection tests for preimage mismatch, forbidden path changes, immutable-judge changes, baseline/backstop absence, selector miss, timeout, direct-output limit, transcript/workspace soft-threshold overshoot, contradictory attempts, abandoned attempt, cleanup failure, missing retained bytes, and altered evidence.
- [ ] 2.6 Run two or three declared operators within the 10-minute locked batch and sequential local policy; capture raw execution axes, projections, selector misses, baseline reuse, runtime, setup time, artifact sizes, cleanup, and reviewer minutes.
- [ ] 2.7 Obtain independent triage for every survivor, likely-equivalent, uninteresting, or invalid-fault disposition.

## 3. Decision Gate

- [ ] 3.1 Publish metric definitions and raw pilot results, including invalid trials and excluded denominators rather than only percentages.
- [ ] 3.2 Stop or narrow on any cleanup failure, abandoned process, unexplained selector miss, authority mismatch, dominant setup cost, predominantly invalid or trivial operators, or insufficient useful evidence within budget.
- [ ] 3.3 Compare the migration and GroupMe adapters and identify any substantial repeated policy/evidence invariants; do not generalize superficial lifecycle differences.
- [ ] 3.4 Publish a continue, narrow, or stop memo. Require a new independently reviewed OpenSpec proposal before any shared coordinator, generic executor, StrykerJS experiment, CI scheduling, blocking gate, agent-generated mutant, or test-deletion automation.
