# Design: Harden reference runtime against closed-pipe writes

## Motivation

Captured failure (`design-notes/reference-docker-epipe-crash-2026-04-26.md`):

```
[19:07:00.810] INFO  request completed (POST .../run -> 202)
[19:07:00.959] FATAL uncaughtException write EPIPE
```

The reference handler accepted a connector run (`202 Accepted`), then ~150ms later the process died with an uncaught `EPIPE` from `write`. The user-visible result is that an accepted run vanishes and the reference must restart. The crash is reachable from any path that writes to a pipe whose far side has gone away — which is normal under `node --watch` and Docker Compose log handoff.

## Suspected writers

Two write paths are reachable in the 150ms window between `202 Accepted` and the crash:

1. **Connector child stdio** (`reference-implementation/runtime/index.js`):
   - `proc.stdin.write(JSON.stringify(startMsg) + '\n')` immediately after `spawn`.
   - `proc.stdin.write(JSON.stringify({ ...response, status: responseStatus }) + '\n')` later for INTERACTION_RESPONSE.
   - Neither write attaches an `error` listener to `proc.stdin`. A child that exits before stdin is consumed (e.g. tsx import error, missing connector module, unsupported node version) emits `EPIPE` on the parent's `proc.stdin`.

2. **Default progress logger** (`reference-implementation/runtime/index.js`):
   - `defaultOnProgress` writes `[runtime] ${json}\n` to `process.stderr`. Inside the controller path the override is `() => {}`, but library callers (CLI, tests) hit it.
   - `process.stderr.write(...)` to a closed Docker stdio pipe surfaces an `error` event on the WriteStream that the existing CLI handler currently treats as fatal.

3. **Pino dev transport** (pino-pretty worker → `process.stdout`): less likely in the captured log because pino-pretty had clearly been running and successfully flushed the previous `[19:07:00.810] INFO request completed` line — but the same EPIPE class can hit the worker's parent pipe.

## Decision

Two narrow defenses, both at the boundary that owns the stream:

### D1. Per-stream `error` listeners on connector child stdio

When `runConnector` spawns a connector, it SHALL attach `error` listeners on the three child stdio streams it owns:

- `proc.stdin.on('error', ...)` — downgrade EPIPE / `ERR_STREAM_DESTROYED` / `ERR_STREAM_WRITE_AFTER_END` to a queued runtime failure (`reason: 'connector_stdin_closed'`) and trigger normal cleanup. Re-throw any other error class.
- `proc.stdout.on('error', ...)` and `proc.stderr.on('error', ...)` — log a single `warn` record and let the existing `'close'` handler finalize the run.

The `proc.stdin.write` call sites SHALL continue to be the same `.write()` invocations, but the runtime SHALL also check `proc.stdin.writable === true` before calling them, and treat a non-writable stdin as the same `connector_stdin_closed` operational failure rather than a thrown exception.

### D2. Process-level downgrade of EPIPE on owned log pipes

The CLI-entrypoint `uncaughtException` handler SHALL inspect the error before fatal-exiting:

- If the error is an instance of `Error`, has `syscall === 'write'`, and its `code` is in `{ 'EPIPE', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END' }`, AND the error's stack indicates the writer was `process.stdout` or `process.stderr` (or no stack-relevant signal is available — in that case the code/syscall pair alone is sufficient because no other PDPP code writes to a non-owned pipe directly), THEN the handler SHALL emit one `warn` log record (best-effort; if the warn emission itself throws EPIPE the error SHALL be swallowed once) and return without exiting.
- All other errors SHALL hit the existing fatal-log + `process.exit(1)` path unchanged.

This is intentionally narrower than a blanket `try { ... } catch {}` over uncaught exceptions: only synchronous closed-pipe writes on owned process stdio are downgraded, and only on the CLI entrypoint where the existing fatal handler already lives.

### D3. Library-mode parity

`runConnector` (library import surface) SHALL not require any global handler to survive closed connector stdio. D1 alone makes the library path safe; D2 is purely a CLI-entrypoint defense.

## Alternatives considered

- **Global `process.on('uncaughtException', () => {})`-style swallow.** Rejected. The reference deliberately fatal-exits on uncaught exceptions to preserve operator clarity (`reference-implementation-architecture` already pins this requirement). A blanket swallow would mask real bugs.
- **Pino-only fix (replace pino-pretty transport, add `sync: true`).** Rejected. The captured stack points at `write` syscall on a pipe; the connector child stdio surface is the more probable writer and the one that would still crash even if pino were silenced.
- **Wrap every `proc.stdin.write` in try/catch.** Subsumed by D1: a `.writable` check plus an `error` listener achieves the same result with no synchronous-throw races and one place to update.
- **Move connector spawning behind a pool/supervisor.** Out of scope; the captured failure is a write-site bug, not a supervision-architecture bug. Re-evaluate only if D1+D2 is not sufficient.

## What is NOT in scope

- No change to scheduler concurrency, run cancellation semantics, or run lifecycle.
- No change to connector authoring (connectors keep writing JSONL to stdout / receiving JSON on stdin).
- No change to Docker Compose, image, or volume layout.
- No change to fatal-log shape on real programmer errors.

## Acceptance checks

1. `openspec validate harden-reference-runtime-reliability --strict` passes.
2. `openspec validate --all --strict` passes.
3. `pnpm --dir reference-implementation run verify` passes.
4. New test `reference-implementation/test/runtime-pipe-resilience.test.js`:
   - Spawns a stub connector that exits before reading stdin; `runConnector` SHALL resolve with `status === 'failed'` and a typed `failure_reason`/known-gap shape, and the parent process SHALL NOT receive an unhandled EPIPE.
   - Wraps `process.stderr.write` (or directly emits an `error` event on a fake stderr) with an `EPIPE` synthetic error inside the CLI guard helper; the helper SHALL classify it as a downgradable EPIPE and other error classes SHALL be re-raised.
5. Manual verification of the original Docker Compose repro: `docker compose -f docker-compose.dev.yml up`, trigger the Claude Code connector run, observe that the parent reference process keeps serving requests.
