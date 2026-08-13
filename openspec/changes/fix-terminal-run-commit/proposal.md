## Why

The local collector can acknowledge a multi-stream cursor vector before its
separate terminal-evidence request succeeds. A crash or transport failure in
that interval leaves a later cursor-aware run unable to reproduce the terminal
facts that the reference uses as collection-completeness evidence.

## What Changes

- Add a durable, replayable terminal run-commit outbox item that carries the
  acknowledged checkpoint vector and safe per-stream terminal facts.
- Gate checkpoint acknowledgement behind successful record/gap predecessors and
  a durable terminal run-commit item, then retry the run commit idempotently.
- Make the terminal endpoint deduplicate response-loss retries and emit exactly
  one attributable terminal event for a durable run-commit id.
- Replace the misleading post-checkpoint `connector_child_failure` fallback
  with terminal-run-commit-specific retry diagnostics.
- Add crash-boundary oracles for request-not-reached and committed-response-lost
  failures, plus SQLite/Postgres parity coverage.

## Capabilities

### New Capabilities

- `local-collector-terminal-run-commit`: Durable terminal evidence delivery
  coupled to a source-instance checkpoint vector, including the
  device-authenticated server commit contract.

### Modified Capabilities

- `local-collector-durable-work`: The durable outbox and checkpoint ordering
  requirements now include terminal run-commit work.

## Impact

- `packages/polyfill-connectors` collector outbox, runner, client, and tests.
- Reference device-exporter terminal route and terminal-event persistence.
- SQLite/Postgres storage behavior, backup/schema inventory, OpenSpec, and
  generated contract artifacts where the endpoint schema changes.
