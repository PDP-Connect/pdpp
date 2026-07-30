## Why

A bounded maintenance page could spend its complete time budget on generic
canonical repair and then invoke its terminal-event fold with zero time. An
incomplete first page correctly resumes from `NULL`, but this phase order made
the same rows repeat without advancing their durable fold checkpoints.

## What Changes

- Terminal-event checkpoint lag is no longer a generic repair candidate.
- A bounded page carries one cooperative absolute deadline through every
  repair and fold phase. Existing participants get the first finite fold
  batch; no new work unit, including an independent participant checkpoint
  write, starts after expiry.
- Missing rows remain repairable under an explicit one-page candidate cap; if
  one cold repair exhausts the deadline, a later round folds its durable row.
- Maintenance receipts expose aggregate fold progress and zero-progress state.

## Capabilities

- Modified: `reference-connector-instances`

## Impact

- `reference-implementation/server/connector-summary-evidence-engine.ts`
- `reference-implementation/server/connector-summary-read-model.ts`
- SQLite and dedicated PostgreSQL maintenance regressions, including 1 ms
  cold-page and 2,001-event mutation cases.
