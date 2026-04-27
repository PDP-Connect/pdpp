## Why

A real Docker Compose connector run on 2026-04-26 returned `202 Accepted` and then crashed the reference AS/RS process with an uncaught `write EPIPE` ~150ms later (see `design-notes/reference-docker-epipe-crash-2026-04-26.md`). The fatal handler honored the existing CLI-entrypoint contract — it logged once and exited — but the underlying write came from a non-essential pipe (connector child stdio or the dev-mode pretty-print transport) whose disappearance should not be a process-killing event. `node --watch` plus Docker Compose log handoff make those pipes routinely transient.

Connector-run handlers reply `202 Accepted` immediately and execute the run fire-and-forget, so a write to a closed log/stdio pipe takes the AS/RS down while a successful 202 is already on the wire. That is the wrong failure mode: the run has been accepted, but the substrate that owns the run has crashed.

## What Changes

- Treat `EPIPE` (and the related closed-pipe codes `EPIPE`, `ERR_STREAM_DESTROYED`, `ERR_STREAM_WRITE_AFTER_END`) on **non-essential output pipes** — connector child `stdin`/`stdout`/`stderr` and process-level `stdout`/`stderr` log writes — as a handled operational condition. The reference SHALL downgrade these to a structured warning record and keep running.
- Attach `error` listeners directly on the streams the reference owns (connector child stdio, `process.stdout`, `process.stderr`) so a closed-pipe write does not become an `uncaughtException` in the first place.
- Keep the existing CLI-entrypoint `uncaughtException`/`unhandledRejection` contract intact for true programmer errors. The narrow EPIPE downgrade SHALL only apply to pipe-write errors emitted on owned streams; everything else SHALL still produce a fatal log record and exit per the existing requirement.
- Add a regression test that simulates a closed log pipe and a closed connector child stdin and asserts the runtime returns a typed failure (or completes with a logged warning) without crashing the host process.

Out of scope: scheduler/controller lifecycle redesign, connector scraping logic, Docker compose stdio reshaping, owner-auth redirect loops, broad `try/catch and continue` policies anywhere else in the runtime.

## Capabilities

### Modified Capabilities

- `reference-implementation-architecture`: extend the CLI-entrypoint crash-record requirement with an EPIPE-on-non-essential-pipes downgrade clause, and add a new requirement for per-stream error handling on owned non-essential pipes.

## Impact

- `reference-implementation/runtime/index.js` — attach `error` handlers on `proc.stdin`, `proc.stdout`, `proc.stderr`, and treat EPIPE on `process.stderr` writes as a downgraded warning. Wrap `proc.stdin.write(...)` (START, INTERACTION_RESPONSE) so a closed child stdin produces a typed runtime failure rather than an uncaught throw.
- `reference-implementation/server/index.js` — narrow the `uncaughtException` handler to short-circuit closed-pipe write errors on `process.stdout` / `process.stderr` (log a `warn` record and continue) and rethrow everything else into the existing fatal-exit path.
- `reference-implementation/test/runtime-pipe-resilience.test.js` (new) — regression coverage for closed log pipe and closed child stdin during a connector run.
- `design-notes/reference-docker-epipe-crash-2026-04-26.md` — promoted; mark decided.
