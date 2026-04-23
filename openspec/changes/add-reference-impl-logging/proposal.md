## Why

The reference implementation has no structured logging and no crash visibility. `server/transport.js` sets Fastify `logger: false`, and the only log output is two bare `console.error` calls (startup banner; one fatal path in `startServer`). There are no `uncaughtException` or `unhandledRejection` handlers.

The observable symptoms:

- Crashes (seen repeatedly during dev) surface as `Failed running 'server/index.js'` with no preceding stack trace. Root causes are invisible.
- Requests are not logged, so slow requests, rejected queries, and protocol errors are only discoverable by hitting the dashboard UI.
- Logs that do exist are unstructured strings, not JSON, so they cannot be queried, filtered, or correlated to trace IDs.

Meanwhile the reference already has a **protocol event spine** (`query.received`, `query.rejected`, `run.state_advanced`, ...) with request IDs, trace IDs, and scenario IDs persisted to SQLite. Logs and events are the same observability surface today, diverged by accident.

This change lands structured logging on the Fastify substrate and makes it the non-protocol shoulder of the existing event spine: same trace IDs, same structured shape, same inspection surface. It also closes the crash-visibility gap.

## What Changes

- Enable Fastify's built-in Pino logger in `reference-implementation/server/transport.js`.
- Wire request-scoped child loggers that carry `{ req_id, trace_id, scenario_id }` automatically via Fastify's request context; do not thread loggers by parameter.
- Add `pino-pretty` as a dev dependency; pretty-print in dev, raw JSON in production (env-gated).
- Add process-level handlers for `uncaughtException`, `unhandledRejection`, `SIGTERM`, `SIGINT` that emit a structured fatal log with stack and cause before exit.
- Declare a redaction allowlist covering `access_token`, `refresh_token`, `device_code`, `user_code`, and other secret paths already recognized by `apps/web/src/app/dashboard/components/timeline-view.tsx`.
- Replace the two existing `console.error` call sites (startup banner, fatal startup path) with the new logger for consistency. Other `console.*` usage elsewhere in the codebase is out of scope for this change.
- Document the logging contract in `openspec/specs/reference-implementation-architecture/spec.md` as a new requirement so the property is durable, not just an implementation detail.

Explicitly **not in this change** (captured as follow-ups in `## Follow-ups`):

- SQLite log sink and dashboard `/dashboard/traces/{id}` inline logs view.
- CLI tail surface (`pdpp logs tail --trace ...`).
- OpenTelemetry wiring (logs emit OTel-friendly field names so a later adapter is trivial).
- `@logtape/logtape` or other alternative loggers.

## Capabilities

### Modified Capabilities
- `reference-implementation-architecture`: add a requirement that the reference implementation emits structured, request-scoped logs with correlation to protocol trace IDs, and that crashes produce a final structured log record.

## Impact

- `reference-implementation/server/transport.js` (enable Fastify logger, configure redaction, expose request-scoped child logger)
- `reference-implementation/server/index.js` (replace the two `console.error` sites; add process-level handlers at startup)
- `reference-implementation/package.json` (add `pino-pretty` devDependency; Pino itself rides in via Fastify)
- `openspec/specs/reference-implementation-architecture/spec.md` (new Requirement)
- No changes to the protocol, no changes to the web app, no changes to existing spine events.

## Follow-ups

- **SQLite log sink + dashboard logs tab.** Persist structured logs to a ring-buffered `logs` table keyed on `trace_id`/`req_id`, surface inside `/dashboard/traces/{id}`. Highest-leverage next step for the "inspect the reference" audience.
- **CLI log tail.** `pdpp logs tail [--trace | --run | --grant]` over the same SQLite table.
- **Typed log events.** Codify spine event names (`query.received`, ...) as a TS union so emission is autocompleted and typo-protected. Relevant if we adopt `@logtape/logtape` for apps/web later.
- **OTel adapter.** Pino → OTLP so production deployments can export logs to any backend. Deferred until a deployment needs it.
