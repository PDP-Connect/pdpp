# Stream Report Health Rollup Design

## Problem

Connection health is currently projected from last-run status, pending gap rows,
manifest policy, freshness, attention, and local-device evidence. The per-stream
collection report is derived immediately afterward. That ordering allows a
succeeded run to make connection coverage `complete` even when the derived stream
report shows required streams with `partial` coverage and `resumable` forward
work.

The live symptom is visible on API-style connectors: the source summary can say
`Healthy` while streams such as repositories, starred items, or pull requests
show `partial` and `Next run: resumes collection`.

## Decision

Use the collection report as the final connection-coverage evidence source for
stream-level shortfalls:

1. Build the initial connection-health snapshot from existing evidence.
2. Build the stream collection report from that snapshot.
3. Roll the report's `coverage_condition` values into a connection coverage
   override.
4. Recompute connection health with the override before rendering the verdict.

This keeps the final pill, `connection_health`, stream rows, source list, and
source detail on one shared projection model. It avoids a UI-only condition and
does not add connector-specific branches.

## Rollup Rules

Only coverage conditions that are already degrading in the connection-health
model may degrade the connection:

- `terminal_gap`
- `retryable_gap`
- `gaps`
- `partial`

Accepted-policy conditions such as `inventory_only`, `deferred`, `unsupported`,
and `unavailable` do not newly degrade the connection from the report rollup.
They remain governed by the manifest policy and existing connection-health
rules. Missing measurement (`unknown`) also does not make a connection look
worse than the existing health evidence; it stays a measurement state.

## Acceptance Checks

- A succeeded run with a stream report containing `partial` coverage SHALL render
  a degraded connection, not `Healthy`.
- A succeeded run with all required streams complete SHALL remain healthy.
- The source list and source detail SHALL agree because they share the same
  projection path.
- Existing collection-report tests continue to pass.
