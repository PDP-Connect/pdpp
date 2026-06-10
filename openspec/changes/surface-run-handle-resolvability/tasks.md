# Tasks: surface-run-handle-resolvability

## 1. Run-handle status route

- [x] 1.1 Add bounded run lifecycle-event lookups: `getRunTerminalEvent` /
  `getRunStartedEvent` in `lib/spine.ts`, backed by
  `server/queries/spine/get-run-started-event.sql` (new) and the extended
  `get-run-terminal-event.sql` (`trace_id`, `actor_id`) for SQLite, and
  `postgresGetRunStartedEvent` / extended `postgresGetRunTerminalEvent` for
  Postgres.
- [x] 1.2 Add `controller.findActiveRunByRunId(runId)` — run-id-keyed lookup
  over the in-process active-run bookkeeping.
- [x] 1.3 Add `server/routes/ref-run-status.ts` mounting owner-session
  `GET /_ref/runs/:runId`: terminal spine event wins, then in-process active
  run, then started-without-terminal, else typed `not_found` 404; mount it in
  `server/index.js`.

## 2. Launch-path honesty fixes

- [x] 2.1 Include `run_id` and `trace_id` in the run-now catch path's failure
  log line.
- [x] 2.2 Emit a typed terminal `run.failed` (`reason: launch_failed`,
  bounded message, zero records) from the run-now catch path when no
  terminal event exists for the run, guarded by the same terminal-existence
  probe the boot reconciler uses so post-spawn rejections never double-emit.

## 3. Verification

- [x] 3.1 Route tests (`test/ref-run-status-route.test.js`): owner-session
  gating, active run, terminal run from a real spine fixture, terminal
  precedence over flight state, started-only fallback, unknown id typed 404,
  URL decoding.
- [x] 3.2 Controller tests (`test/controller-run-launch-failure.test.js`):
  launch crash emits exactly one `run.failed` with `reason: launch_failed`;
  log line carries `run_id` + `trace_id`; no duplicate terminal when the
  runtime already recorded one; `findActiveRunByRunId` resolves in-flight and
  clears after settle.
- [x] 3.3 `openspec validate surface-run-handle-resolvability --strict` and
  `openspec validate --all --strict` pass; reference-implementation suite,
  `pnpm typecheck`, and lint pass.
