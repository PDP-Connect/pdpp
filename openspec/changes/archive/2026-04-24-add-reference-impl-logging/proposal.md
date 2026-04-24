## Why

The reference implementation has no structured logging and no crash visibility. `server/transport.js` sets Fastify `logger: false`, and the only log output is two bare `console.error` calls (startup banner; one fatal path in the entrypoint). There are no `uncaughtException` or `unhandledRejection` handlers at the CLI entrypoint.

The observable symptoms:

- Crashes (seen repeatedly during dev) surface as `Failed running 'server/index.js'` with no preceding stack trace. Root causes are invisible.
- Requests are not logged, so slow requests and protocol errors are only discoverable by hitting the dashboard UI.
- Logs that do exist are unstructured strings, not JSON, so they cannot be queried, filtered, or correlated to trace IDs.

Meanwhile the reference already has a **protocol event spine** (`query.received`, `query.rejected`, `run.state_advanced`, ...) with request IDs, trace IDs, and scenario IDs persisted to SQLite. Logs and events are the same observability surface today, diverged by accident.

This change lands structured logging on the Fastify substrate and makes it the non-protocol shoulder of the existing event spine: same trace IDs, same structured shape, same inspection surface. It also closes the crash-visibility gap **at the CLI entrypoint only**, so tests and other importers of `startServer` are not affected.

## What Changes

- Add `pino` and `pino-pretty` as direct dependencies of `reference-implementation/` (rationale: this change uses Pino API surface directly, so declaring it explicitly is more honest than riding Fastify's transitive dep).
- Enable Fastify's Pino logger in `reference-implementation/server/transport.js`, configured with:
  - ISO timestamps (`pino.stdTimeFunctions.isoTime`)
  - A redaction allowlist covering known secret paths
  - `pino-pretty` transport gated on `NODE_ENV !== 'production'`
- Wire a Fastify request-lifecycle hook that, once `trace_id` / `scenario_id` / `actor_type` / `actor_id` are resolved for a request, rebinds `request.log` to a child logger carrying those fields.
- Install `uncaughtException`, `unhandledRejection`, `SIGTERM`, and `SIGINT` handlers **only inside the CLI-entrypoint block** (`if (process.argv[1] && process.argv[1].endsWith('server/index.js'))` at the bottom of `server/index.js`). The library export `startServer()` itself SHALL NOT register process-level listeners, so tests that import and call `startServer` many times in one process are unaffected.
- Replace the two existing `console.error` call sites (startup banner; entrypoint's catch block) with the logger for consistency.
- Document the logging contract in `openspec/specs/reference-implementation-architecture/spec.md` as a new set of requirements scoped to the reference implementation running as a server process (not library imports).

Explicitly **not in this change** (captured as follow-ups in `## Follow-ups`):

- SQLite log sink and dashboard `/dashboard/traces/{id}` inline logs view.
- CLI tail surface (`pdpp logs tail --trace ...`).
- OpenTelemetry log exporter wiring.
- Per-handler error-object logging enrichment. Fastify already logs a completion record with `statusCode` and `responseTime` for every request; this change does not attempt to surface additional error-class detail beyond what Fastify's default request serializer provides. Handlers that *want* to log exception detail can do so explicitly with `request.log.error({ err }, '...')`; shaping 4xx/5xx records uniformly is a separate follow-up.

## Capabilities

### Modified Capabilities
- `reference-implementation-architecture`: add requirements that the reference implementation, when run as a server process, emits structured trace-correlated logs and produces a final structured log record on crash or signal.

## Impact

- `reference-implementation/server/transport.js` (enable Fastify logger, configure redaction)
- `reference-implementation/server/index.js` (request-scope child logger hook; replace `console.error` call sites; install process-level handlers inside the CLI-entrypoint block only)
- `reference-implementation/package.json` (add `pino` and `pino-pretty` as dependencies)
- `openspec/specs/reference-implementation-architecture/spec.md` (new Requirements once archived)
- No changes to the protocol, no changes to `apps/web`, no changes to existing spine events, no changes to test harness behavior.

## Follow-ups

- **SQLite log sink + dashboard logs tab.** Persist structured logs to a ring-buffered `logs` table keyed on `trace_id` / `req_id`, surface inside `/dashboard/traces/{id}`. Highest-leverage next step for the "inspect the reference" audience.
- **Unified 4xx/5xx error-record shape.** Today handler errors go through the reference's `oauthError` / `rejectQuery` / etc. paths, which build response envelopes rather than throwing. A follow-up can define a single `request.log.error(...)` call site (or Fastify `onResponse` hook) that emits a normalized record for every non-2xx response.
- **CLI log tail.** `pdpp logs tail [--trace | --run | --grant]` over the SQLite sink.
- **Typed log events.** Codify spine event names as a TS union so emission is autocompleted and typo-protected.
- **OTel adapter.** Pino → OTLP so production deployments can export logs to any backend.
