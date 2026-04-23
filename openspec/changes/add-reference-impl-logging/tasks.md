## 1. Declare dependencies honestly

- [x] 1.1 Add `pino` to `reference-implementation/package.json` `dependencies` (we import from it directly; see `design.md` "Logger" section).
- [x] 1.2 Add `pino-pretty` to `reference-implementation/package.json` `devDependencies` (only used in non-production).

## 2. Enable Fastify's logger in the transport layer

- [x] 2.1 In `reference-implementation/server/transport.js`, replace `logger: false` with a Pino logger instance built by a new exported `buildLogger({ quiet })` helper:
  - `level: process.env.LOG_LEVEL ?? 'info'` (or `'silent'` when the caller passes `quiet: true`)
  - `timestamp: pino.stdTimeFunctions.isoTime`
  - `redact: { paths: [...], censor: '<redacted>' }` covering:
    - `access_token`, `refresh_token`, `device_code`, `user_code`
    - `interaction_response`, `INTERACTION_RESPONSE`
    - `req.headers.authorization`
    - `*.access_token`, `*.refresh_token` glob shapes for nested containers
  - `transport: { target: 'pino-pretty' }` **only when `NODE_ENV !== 'production'`**; in production, omit the transport entirely so stdout is raw JSON.
- [x] 2.2 Pass the pre-built logger into Fastify via `loggerInstance`, set `disableRequestLogging: true`, and emit a single `onResponse` hook that carries `{ req_id, method, url, statusCode, responseTime, trace_id? }` (trace_id sourced from the response header the reference handlers already set via `setReferenceTraceId`).
- [x] 2.3 Configure Fastify `genReqId` so request IDs prefer an inbound `Request-Id` header when present (matching existing behavior) and otherwise generate a fresh ID.

## 3. Propagate protocol context into request-scoped logs

- [x] 3.1 The `onResponse` completion hook reads `PDPP-Reference-Trace-Id` off the response after the handler ran; if present it is included on the completion record, if absent it is omitted (no synthetic `trace_id: null`). This gives us the spec-required correlation without a separate preHandler hook.
- [x] 3.2 Handler log lines inside `request.log.*` calls automatically carry `req_id` via Fastify's default child logger. Handlers that want additional trace correlation on their own log lines can do `request.log = request.log.child({ trace_id })` at the same point they call `setReferenceTraceId`. That ergonomic wrapper is deferred until we have a handler that wants it — YAGNI for this change.

## 4. Replace the two `console.error` sites

- [x] 4.1 Replace the startup-banner `console.error` in `startServer()` with `logger.info({ port, url }, 'authorization server listening')` and the RS equivalent.
- [x] 4.2 Replace the CLI-entrypoint catch-handler `console.error` with `cliLogger.fatal({ err }, 'startup failed')` before exit.

## 5. Install process-level handlers — CLI entrypoint only

- [x] 5.1 All process-level handlers are installed inside the existing `if (process.argv[1] && process.argv[1].endsWith('server/index.js'))` block at the bottom of `server/index.js`. They are NOT installed from `startServer()` or at module top level.
- [x] 5.2 Register `process.on('uncaughtException', exitOnFatal('uncaughtException'))`.
- [x] 5.3 Register `process.on('unhandledRejection', exitOnFatal('unhandledRejection'))`.
- [x] 5.4 Register `process.on('SIGTERM', exitOnSignal('SIGTERM'))` and same for `SIGINT`. Signal handler performs `closeAllConnections` + `close` on both AS and RS servers with a 2-second timeout matching the existing test-harness shutdown pattern.
- [x] 5.5 Module-local `shuttingDown` flag guards all four handlers so a cascade doesn't double-log or hang the exit.
- [x] 5.6 Section header comment explains why the handlers live here and not in `startServer()` (library-import contract).

## 6. Test-harness no-regression check

- [x] 6.1 `pnpm --filter pdpp-reference-implementation test`: 578 tests across 14 suites pass. The one pre-existing failure in `composed-origin.test.js` (dashboard AS-origin leak assertion) reproduces identically on clean `main` — unrelated to this change.
- [x] 6.2 `process.listenerCount('uncaughtException' | 'unhandledRejection' | 'SIGTERM' | 'SIGINT')` before vs after `startServer()`: all four deltas are 0. Verified with a self-contained script; see acceptance check 8.7 output.

## 7. Capability spec update

- [x] 7.1 Delta in `openspec/changes/add-reference-impl-logging/specs/reference-implementation-architecture/spec.md` covers every requirement asserted here.
- [ ] 7.2 After merge, when this change is archived, the `ADDED Requirements` will be folded into `openspec/specs/reference-implementation-architecture/spec.md` so they become durable. **(Deferred to archival time, not implementation.)**

## 8. Acceptance checks

All seven executed against the implementation. Raw output captured in-session; summary below.

- [x] 8.1 Startup — dev shows pretty-printed `authorization server listening { port, url }` + `resource server listening { port, url }`; prod with `NODE_ENV=production` emits equivalent JSON lines.
- [x] 8.2 `onResponse` hook emits a completion record per request with `req_id`, method, url, statusCode, responseTime — verified on `/.well-known/oauth-authorization-server`, `/oauth/device_authorization`, and a bad-token RS call.
- [x] 8.3 Device-auth completion record carried `trace_id: "trc_4aab675a89a187f2"`; well-known metadata record omitted `trace_id` entirely (no synthetic null).
- [x] 8.4 `buildLogger()` + `logger.info({ access_token: 'super-secret-abc', nested: { refresh_token: 'rtoken-xyz' } }, ...)` emits `access_token: '<redacted>'` and `nested.refresh_token: '<redacted>'`.
- [x] 8.5 `kill -TERM <pid>` on the CLI produced one `INFO shutdown signal received { signal: 'SIGTERM' }` record, then exit 0.
- [x] 8.6 Injected `Promise.reject(new Error('boom...'))` produced one `FATAL unhandledRejection { err: { type, message, stack } }` record, then exit 1.
- [x] 8.7 Library-import test: `startServer()` adds 0 listeners to each of `uncaughtException`, `unhandledRejection`, `SIGTERM`, `SIGINT`. Full test suite passes (modulo pre-existing `composed-origin` flake).

## 9. Follow-ups (not in this change)

- [ ] 9.1 SQLite log sink + dashboard `/dashboard/traces/{id}` logs tab.
- [ ] 9.2 Unified 4xx/5xx error-record shape (see `design.md`).
- [ ] 9.3 `pdpp logs tail [--trace | --run | --grant]` CLI surface.
- [ ] 9.4 Typed log-event contract (TS union of spine event names).
- [ ] 9.5 OTel log exporter.
