## 1. Enable Fastify's built-in Pino logger

- [ ] 1.1 Add `pino-pretty` to `reference-implementation/package.json` as a devDependency. Pino itself is transitively provided by Fastify 5; no separate dependency needed unless we pin a version.
- [ ] 1.2 In `reference-implementation/server/transport.js`, replace `logger: false` with a logger options object:
  - `level: process.env.LOG_LEVEL ?? 'info'`
  - `timestamp` using Pino's `stdTimeFunctions.isoTime`
  - `redact: { paths: [...], censor: '<redacted>' }` covering:
    - `access_token`, `refresh_token`, `device_code`, `user_code`
    - `interaction_response`, `INTERACTION_RESPONSE`
    - `req.headers.authorization`
    - `*.access_token`, `*.refresh_token` glob shapes for nested containers
  - `transport: { target: 'pino-pretty' }` gated on `NODE_ENV !== 'production'`
- [ ] 1.3 Configure Fastify `genReqId` so request IDs are either (a) the value of an incoming `Request-Id` header if present, or (b) a freshly generated ID. Emit the chosen ID on the response `Request-Id` header if not already set.

## 2. Propagate protocol context into request-scoped logs

- [ ] 2.1 Add a Fastify `onRequest` or `preHandler` hook (or extend the existing context builder in `server/index.js`) that, as soon as `trace_id`, `scenario_id`, `actor_type`, and `actor_id` are resolved, rebinds `request.log` to a child logger carrying those fields.
- [ ] 2.2 Audit the existing handlers that emit spine events (`emitQueryReceived`, `rejectQuery`, etc.) to confirm they are called *after* step 2.1's rebind, so any log line inside those paths carries the correlation fields.

## 3. Replace the two `console.error` sites

- [ ] 3.1 In `reference-implementation/server/index.js`, replace the startup banner `console.error` at line ~2506 with the top-level logger (`logger.info` on ready, with `asPort`/`rsPort` fields).
- [ ] 3.2 Replace the fatal startup-path `console.error` at line ~2594 with `logger.fatal({ err })` before the process exits.

## 4. Install process-level handlers

- [ ] 4.1 In `server/index.js` at startup (before `startServer` is called), register `process.on('uncaughtException', err => { logger.fatal({ err }, 'uncaughtException'); process.exit(1); })`.
- [ ] 4.2 Register `process.on('unhandledRejection', err => { logger.fatal({ err }, 'unhandledRejection'); process.exit(1); })`.
- [ ] 4.3 Register `process.on('SIGTERM', () => { logger.info('SIGTERM'); /* close Fastify instances, await inflight, exit 0 */ })`. Same for `SIGINT`.
- [ ] 4.4 Ensure handlers fire only once (guard with a module-level `shuttingDown` flag) so a cascade of SIGTERM + unhandledRejection doesn't produce duplicate records or hang the exit.

## 5. Capability spec update

- [ ] 5.1 Confirm the delta in `openspec/changes/add-reference-impl-logging/specs/reference-implementation-architecture/spec.md` covers every requirement asserted here.
- [ ] 5.2 After merge, when this change is archived, the five `ADDED Requirements` will be folded into `openspec/specs/reference-implementation-architecture/spec.md` so they become durable.

## 6. Acceptance checks

Reproduce each of the six checks from `design.md` and record the output (paste into a PR comment or a scratch file):

- [ ] 6.1 Startup: pretty-printed "listening" line in dev, one JSON line in prod (`NODE_ENV=production node server/index.js`).
- [ ] 6.2 Successful `/v1/streams` request with owner token: two log records sharing `req_id` + `trace_id`, second records `statusCode` + `responseTime`.
- [ ] 6.3 Same endpoint with an invalid token: error record carries matching `req_id` and a `statusCode`.
- [ ] 6.4 Handler logging an object with `access_token: 'abc'`: output shows `access_token: '<redacted>'`.
- [ ] 6.5 Signal handling: `kill -TERM <pid>` produces one `info` log line before shutdown.
- [ ] 6.6 Unhandled rejection: inject `Promise.reject(new Error('boom'))` in a handler; terminal shows a single `fatal` record with stack before the process exits.

## 7. Follow-ups (not in this change)

- [ ] 7.1 SQLite log sink + dashboard `/dashboard/traces/{id}` logs tab.
- [ ] 7.2 `pdpp logs tail [--trace | --run | --grant]` CLI surface.
- [ ] 7.3 Typed log-event contract (TS union of spine event names).
- [ ] 7.4 OTel log exporter.
