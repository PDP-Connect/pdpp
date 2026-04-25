## 1. Requirements

- [x] Re-read the partial-run, cursor-finality, and gap-recovery design notes under `add-polyfill-connector-system`.
- [x] Decide the initial gap taxonomy and whether it is reference-only or Collection Profile candidate behavior.
- [x] Define the timeline payload shape for skipped streams, known gaps, and recovery hints.

## 2. Runtime

- [x] Add or normalize `SKIP_RESULT` / skip event handling where connectors already expose bounded skips.
- [x] Add a run-level known-gaps summary derived from skipped streams, failed terminal state, and checkpoint commit state.
- [x] Ensure secrets and raw interaction responses are never persisted in gap payloads.

## 3. Dashboard

- [ ] Render partial/gap status on run detail.
- [ ] Render connector-row/list hints when the latest run produced data but has known gaps.
- [ ] Keep failed protocol violations visually distinct from partial source coverage.

## 4. Validation

- [ ] Add runtime tests for skipped stream, partial flush then failure, and missing credential/manual-action gaps.
- [ ] Add dashboard rendering tests or focused component coverage for known gaps.
- [ ] Run `pnpm --dir reference-implementation run verify`.
- [ ] Run `pnpm --dir apps/web run types:check`.
- [ ] Run `openspec validate define-partial-run-honesty --strict`.
- [ ] Run `openspec validate --all --strict`.
