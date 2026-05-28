# Tasks

## 1. Spec delta and design

- [x] 1.1 Promote `design-notes/reference-docker-epipe-crash-2026-04-26.md` into this change folder; mark the cross-cutting note as decided/promoted.
- [x] 1.2 Author proposal, design, and spec delta against `reference-implementation-architecture`.
- [x] 1.3 `openspec validate harden-reference-runtime-reliability --strict` passes.

## 2. Runtime stream-error handling

- [x] 2.1 Attach `error` listeners on `proc.stdin`, `proc.stdout`, and `proc.stderr` immediately after `spawn` in `reference-implementation/runtime/index.js`. Downgrade closed-pipe codes (`EPIPE`, `ERR_STREAM_DESTROYED`, `ERR_STREAM_WRITE_AFTER_END`) to operational outcomes; re-throw anything else.
- [x] 2.2 Replace bare `proc.stdin.write(...)` calls with a small helper that checks `proc.stdin.writable` first and routes a non-writable child stdin to the existing failure / cleanup path with a typed reason.
- [x] 2.3 Default `onProgress` writer to `process.stderr` SHALL swallow EPIPE on the writer itself once, then become a no-op for the rest of the run. Other errors are re-thrown.

## 3. CLI-entrypoint guard

- [x] 3.1 Extract a tiny pure helper in `reference-implementation/server/index.js` (or a sibling file) that classifies an unknown error as either `downgradable_pipe_write_error` or `fatal`. Export the classifier for tests.
- [x] 3.2 Modify the CLI `exitOnFatal` path so a `downgradable_pipe_write_error` emits a single `warn` record (best-effort) and returns without exiting. Everything else stays on the existing fatal path.
- [x] 3.3 Verify there are no new `process.on(...)` listeners added from the library surface (existing requirement is unchanged).

## 4. Regression test

- [x] 4.1 Add `reference-implementation/test/runtime-pipe-resilience.test.js`:
  - Stub-connector path: spawn a child that exits before reading stdin; assert `runConnector` resolves with a typed `terminal_reason` and the parent process emits no `uncaughtException`.
  - Classifier path: feed synthetic errors into the shared closed-pipe classifier and assert only write-side closed-pipe errors are downgradable.
  - Terminal-reason path: unit-test the pure helper that maps DONE status and child-stdin-close state to the resolved run `terminal_reason`.
- [x] 4.2 Wire the new test into the test suite so `pnpm --dir reference-implementation run test` and `pnpm --dir reference-implementation run verify` exercise it.

## 5. Validation

- [x] 5.1 `openspec validate harden-reference-runtime-reliability --strict`.
- [x] 5.2 `openspec validate --all --strict`.
- [x] 5.3 `pnpm --dir reference-implementation run verify`.
- [x] 5.4 Targeted: `node --test reference-implementation/test/runtime-pipe-resilience.test.js`.

## Acceptance checks

- The captured Docker repro (Claude Code connector run via `docker compose -f docker-compose.dev.yml up`) no longer crashes the reference; instead the run either succeeds or fails with a structured outcome record.
- A real programmer error (e.g. `throw new TypeError(...)`) inside a request handler still produces exactly one `fatal` record and exits non-zero, per the existing CLI-entrypoint requirement.
- No new `process.on(...)` listeners are added when `startServer` is imported from a test harness.
