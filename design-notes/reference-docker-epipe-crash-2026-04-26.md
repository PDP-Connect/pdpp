# Reference Docker EPIPE Crash During Connector Run

Status: captured
Owner: reference implementation
Created: 2026-04-26
Updated: 2026-04-26
Related: Docker Compose reference deployment, connector run controller, process logging

## Question

Why can a connector run in Docker crash the reference server with an uncaught `write EPIPE`, and what part of the reference runtime should own handling closed log/stdout pipes?

## Context

During a Docker Compose run, triggering the Claude Code connector returned `202 Accepted`, then the reference process crashed with an uncaught `write EPIPE`:

```text
reference-1  | [19:07:00.810] INFO (17): request completed
reference-1  |     method: "POST"
reference-1  |     url: "/_ref/connectors/https%3A%2F%2Fregistry.pdpp.org%2Fconnectors%2Fclaude-code/run"
reference-1  |     statusCode: 202
reference-1  |     responseTime: 18
reference-1  | [19:07:00.959] FATAL (17): uncaughtException
reference-1  |     err: {
reference-1  |       "type": "Error",
reference-1  |       "message": "write EPIPE",
reference-1  |       "errno": -32,
reference-1  |       "code": "EPIPE",
reference-1  |       "syscall": "write"
reference-1  |     }
reference-1  | Failed running 'reference-implementation/server/index.js'. Waiting for file changes before restarting...
```

`EPIPE` from process output should not be able to take down the reference server. In Docker/dev mode, log consumers, stream pipes, or child-process stdio can disappear. The server should treat this as a handled operational failure, not an uncaught exception.

## Stakes

- Connector runs should fail or continue with typed operational diagnostics; they should not crash the AS/RS process.
- Docker/dev mode is especially exposed because Node watch, Compose logging, and child process pipes can restart independently.
- If the failing writer is connector child-process stdio, the fix belongs near the runtime/process boundary, not in individual connectors.

## Current Leaning

Investigate the writer that emitted to a closed pipe during connector execution. Add an error handler for process or child stdio streams that ignores or downgrades `EPIPE` when the receiving side closes. Add a regression test or harness reproduction if the failing writer is owned by the reference runtime.

## Promotion Trigger

Promote to OpenSpec before changing reference process-supervision semantics, connector child-process lifecycle behavior, or the operator-facing failure contract for Docker connector runs.

## Decision Log

- 2026-04-26: Captured from Docker Compose failure during a Claude Code connector run.
