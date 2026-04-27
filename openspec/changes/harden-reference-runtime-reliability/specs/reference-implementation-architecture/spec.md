## MODIFIED Requirements

### Requirement: The CLI entrypoint SHALL produce a final structured log record on crash or signal

When `reference-implementation/server/index.js` is run as a CLI entrypoint, it SHALL install process-level handlers for `uncaughtException`, `unhandledRejection`, `SIGTERM`, and `SIGINT`. Each handler SHALL emit exactly one log record before the process exits, except that the `uncaughtException` handler SHALL downgrade closed-pipe write errors on owned process stdio (`process.stdout` / `process.stderr`) to a single `warn` record and return without exiting. These handlers SHALL NOT be installed when `server/index.js` is imported as a library (for example, from a test harness); the reference implementation SHALL NOT register global `process.on` listeners from any code path other than the CLI entrypoint block.

A "closed-pipe write error" for the purposes of this requirement is an `Error` with `syscall === 'write'` and `code` in the set `{ 'EPIPE', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END' }`. Any other error SHALL take the existing fatal-log + non-zero-exit path.

#### Scenario: Uncaught exception at the CLI entrypoint
- **WHEN** the CLI is running and code in a request handler or background task throws and the error is not otherwise caught
- **THEN** exactly one `fatal` log record SHALL be emitted on stdout with the error name, message, and stack before the process exits with a non-zero code

#### Scenario: Closed-pipe write error on owned process stdio
- **WHEN** the CLI is running and an `EPIPE` (or equivalent closed-pipe error) is raised by a write to `process.stdout` or `process.stderr` and reaches the `uncaughtException` handler
- **THEN** the handler SHALL emit at most one `warn` log record describing the closed-pipe condition
- **AND** the handler SHALL NOT exit the process
- **AND** subsequent unrelated errors SHALL still be classified by the same handler

#### Scenario: Unhandled promise rejection at the CLI entrypoint
- **WHEN** the CLI is running and a promise rejection propagates to the top level
- **THEN** exactly one `fatal` log record SHALL be emitted on stdout with the rejection reason and stack before the process exits with a non-zero code

#### Scenario: Termination signal at the CLI entrypoint
- **WHEN** the CLI process receives `SIGTERM` or `SIGINT`
- **THEN** exactly one `info` log record SHALL be emitted on stdout naming the signal before the process performs graceful shutdown and exits

#### Scenario: Library import does not pollute the process
- **WHEN** a test or another Node program imports `startServer` from `server/index.js` and calls it one or more times
- **THEN** the reference implementation SHALL NOT add any listeners to `process` for `uncaughtException`, `unhandledRejection`, `SIGTERM`, or `SIGINT`

## ADDED Requirements

### Requirement: Connector child stdio failures SHALL be handled at the runtime boundary

When the connector runtime spawns a connector child process, it SHALL attach `error` listeners to the child's `stdin`, `stdout`, and `stderr` streams before performing the first write or read. A closed-pipe error (`code` in the set `{ 'EPIPE', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END' }`) on any of those owned streams SHALL be downgraded to a typed operational outcome on the run; it SHALL NOT propagate as an uncaught exception. Any other error class on those streams SHALL still terminate the run with the existing failure shape.

The runtime SHALL also guard `proc.stdin.write` call sites against a non-writable stdin (`proc.stdin.writable === false`) and SHALL surface that condition as the same typed operational outcome rather than as a thrown synchronous exception.

#### Scenario: Connector child exits before reading START
- **WHEN** the runtime spawns a connector and the child exits before the runtime can write `START` to its stdin
- **THEN** the runtime SHALL resolve the run with a structured failure outcome whose `failure_reason` indicates the connector terminated before accepting input
- **AND** the parent process SHALL NOT emit an `uncaughtException`
- **AND** the active-run projection SHALL be cleared so subsequent runs of the same connector are unblocked

#### Scenario: Connector child closes stdin during INTERACTION_RESPONSE delivery
- **WHEN** the runtime tries to write an `INTERACTION_RESPONSE` to a connector whose stdin has already closed
- **THEN** the runtime SHALL record a typed operational failure on the run (not an uncaught exception)
- **AND** the run lifecycle SHALL still drain to a terminal record via the existing `'close'` handler

#### Scenario: Non-EPIPE error on connector stdio is not downgraded
- **WHEN** the runtime's `proc.stdin` listener receives an `error` whose `code` is not in the closed-pipe set (for example a `TypeError` synthesized by Node)
- **THEN** the runtime SHALL terminate the run via its existing failure path and the error SHALL surface to the run's caller, not be silently swallowed
