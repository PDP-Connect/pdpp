## Why

The original PDPP E2E/reference plan is still the right program, but the repository no longer has one canonical artifact that expresses it. The implementation has moved materially since the original inbox program docs were written:

- `e2e/` is now `reference-implementation/`
- OpenSpec is now the intended durable project-planning layer
- several foundation tranches from the original plan are already complete
- a growing set of inbox memos and point-in-time status notes can now drift from the code, tests, and current architecture decisions

This change creates one canonical OpenSpec program artifact for the reference implementation so the repo has a single place to answer:

- what the original program is still trying to achieve
- what is already done
- what is currently in progress
- what comes next
- what is intentionally deferred

## What Changes

- Create a canonical OpenSpec program change for the PDPP reference-implementation program.
- Restate the original program shape in current repo terms:
  - `reference-implementation/` as the forkable substrate
  - `apps/web` as a downstream consumer
  - one engine with honest native and polyfill realizations
  - thin OAuth-composed provider-connect profile
  - real CLI
  - durable event/trace spine
- Track current execution state under `done`, `in progress`, `next`, and `deferred`.
- Demote the older inbox plan/status memos from active steering documents to historical working notes.

## Capabilities

### Modified Capabilities
- `reference-implementation-governance`: active multi-tranche execution for the reference implementation now has one canonical OpenSpec program artifact instead of relying on inbox memos as the steering center.
- `reference-implementation-architecture`: the active implementation program is explicitly tied back to the durable architecture boundaries already captured in OpenSpec.

## Impact

- `openspec/changes/reference-implementation-program/*`
- `docs/archive/2026-04-e2e-superseded/e2e-reference-implementation-plan.md`
- `docs/archive/2026-04-e2e-superseded/e2e-owner-status-2026-04-17.md`
- `docs/archive/2026-04-e2e-superseded/e2e-program-synthesis-2026-04-16.md`
- future implementation sequencing for:
  - `reference-implementation/`
  - `apps/web` bridge/doc truthfulness
  - provider-connect profile work
  - Collection Profile convergence
  - event spine / replay / control-plane work
