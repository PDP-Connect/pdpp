## Context

`runConnector` creates a readline interface over `process.stdin` and waits for a
single `line` event before parsing `START`. If stdin closes or errors before the
first line, the promise never settles. Live evidence showed connector children
for multiple connectors still running for hours with only `run.started` in the
spine, and a same-container reproduction showed `node --import tsx/esm
connectors/github/index.ts </dev/null` timing out with no output.

## Goals / Non-Goals

**Goals:**

- Missing `START` fails closed through the existing failed `DONE` path.
- The runtime removes listeners after any terminal startup outcome.
- A subprocess regression proves the process exits quickly with no `START`.

**Non-Goals:**

- Do not change valid `START` behavior.
- Do not change interaction-response or detail-gap response handling.
- Do not direct-edit active-run rows; live cleanup remains a runtime/control
  operation after code is fixed.

## Decisions

- Add `close`, `end`, and `error` listeners to `readStart`, resolving exactly
  once and cleaning up all listeners. This keeps the fix local to connector
  startup and preserves the existing `parseStart` validation path.
- Reject with a normal `Error` carrying safe text such as
  `Missing START message before stdin closed`; the outer `run().catch` already
  converts unexpected startup failures into a failed `DONE` envelope with
  `retryable=false`.
- Test through a real connector subprocess with stdin ignored/closed. That
  catches the observed tsx/container behavior, not only the unit-level promise
  branch.

## Risks / Trade-offs

- A parent that intentionally delays writing `START` still works because the
  runtime waits until stdin actually closes/errors. The fix does not add a timer.
- If stdout is already broken, the failed `DONE` may not be delivered, which is
  existing behavior for any connector-child failure. The process still exits
  instead of spinning.
