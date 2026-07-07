## Context

The current runner recovers expired leases and drains ready outbox rows before scanning. Dead-letter rows are intentionally excluded so malformed payloads or terminal server rejections do not loop forever. The observed live failure was narrower: hundreds of rows dead-lettered with the single redacted class `local device request failed: 502` after a reference-server outage. The existing recovery command can requeue them, but scheduled runs never do.

## Design

Add a small transient-dead-letter recovery step before the pre-scan drain. It reads only dead-letter ids and redacted `last_error` classes, never payloads, and requeues rows whose class is a known transient local-device request failure:

- `local device request failed: 408`
- `local device request failed: 429`
- `local device request failed: 5xx`
- local-device request timeout
- fetch/network transient classes such as `fetch failed`, `ECONN*`, `ETIMEDOUT`, or `EAI_AGAIN`

Terminal classes such as payload-shape failures, `400 invalid_request`, `401`, `403`, or protocol mismatch remain dead-lettered. The drain policy still bounds attempts after requeue; if the server remains unhealthy, rows can return to dead-letter state and the next run can retry only after another scheduled interval, not in an unbounded loop.

The CLI recovery note currently adds `pending + retrying`, but `retrying` is a subset of `pending` in the local outbox summary. Fix the local summary math to count open rows once and render claimable-ready and retrying rows separately where useful.

## Alternatives

- Requeue all dead letters on every run. Rejected: this would loop terminal bad rows and hide real operator-required failures.
- Leave manual `recover --apply` as the only repair. Rejected: transient reference outages should self-heal when the next scheduled local collector run can reach the server.
- Move recovery to the server/dashboard. Rejected: the server cannot mutate the device-local SQLite outbox safely.

## Acceptance Checks

- A collector run seeded with a `502` dead-letter requeues and drains it when the server is healthy.
- A collector run seeded with a terminal `400 invalid_request` dead-letter leaves it dead-lettered and reports blocked state.
- Recovery notes do not double-count retrying rows.
- CLI output to a closed pipe exits without an unhandled `EPIPE`.
