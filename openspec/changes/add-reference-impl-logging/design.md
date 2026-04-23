# Reference-implementation logging design

## Purpose

Give the reference implementation structured, trace-correlated logging and crash visibility without introducing new frameworks, new log-aggregation platforms, or new observability concepts. Elevate logs to the same standing the protocol event spine already enjoys.

## Framing principle

**Logs are the non-protocol shoulder of the existing event spine.** The protocol defines which interactions produce structured events (`query.received`, `query.rejected`, `run.state_advanced`). Everything else that happens during a request — a DB call, a manifest lookup, a connector runtime callback, a bad input — deserves the same structured treatment, the same trace ID, and the same inspectability. Logging is not a separate track; it is the rest of the surface.

This framing is what prevents the usual logging drift where `console.log` accumulates for years and never becomes useful.

## Design choices

### Logger: Pino, via Fastify's built-in integration

Fastify 5 (which the reference already uses) ships with Pino as its built-in logger. Enabling it is a one-line change from `logger: false` to a logger options object. Pino is the de facto standard for Fastify apps, is maintained alongside Fastify by the same core team, and produces JSON lines with near-zero overhead in the hot path.

Alternatives considered:

- **Winston / Bunyan.** Older, slower, weaker structured-logging ergonomics. No reason to choose them on a greenfield Fastify substrate.
- **`@logtape/logtape`.** Newer, TS-native, nicer typed events. Compelling for `apps/web`, but adopting it on a Fastify server means fighting the framework. Revisit for apps/web if we want typed log events there.
- **Custom ALS-based wrapper.** We have the building blocks already (request IDs, trace IDs) but reinventing a logger is strictly worse than configuring Pino.

### Context propagation: Fastify request context, not manual threading

Fastify generates a request ID per request (configurable via `genReqId`) and automatically attaches a child logger (`request.log`) that carries it. Handlers use `request.log.info({...}, 'message')` and the req-id rides along.

The reference already has a `trace_id` per logical protocol operation, generated before any spine event fires. The change is: as soon as we compute `trace_id` (and `scenario_id`, `actor_type`, `actor_id`), we call `request.log = request.log.child({ trace_id, scenario_id, actor_type, actor_id })` so every subsequent log line in that request carries those fields.

No `AsyncLocalStorage` gymnastics required at this layer. ALS becomes interesting only when we need a module-level logger that doesn't have access to `request` — not yet in scope.

### Dev vs prod output

Pino writes JSON lines to stdout. For a pleasant dev terminal we pipe through `pino-pretty`:

```
NODE_ENV=development  →  pretty, colorized, level+time+req_id+message
NODE_ENV=production   →  raw JSON, unadorned
```

This is implemented via Pino's `transport` option in dev and no transport in prod. Fastify auto-detects and does the right thing when given standard Pino options.

### Redaction

Pino supports declarative redaction (`redact: { paths: [...], censor: '<redacted>' }`). The path list mirrors the secret set already recognized by `apps/web/src/app/dashboard/components/timeline-view.tsx`:

- `access_token`, `refresh_token`
- `device_code`, `user_code`
- `interaction_response`, `INTERACTION_RESPONSE`
- `Authorization` header (via Fastify's `serializers.req`)
- Any nested `*.token` / `*.secret` shaped keys (glob patterns)

Redaction happens at serialization time, so even if a handler passes a secret object into a log call, the output never contains the plaintext.

### Crash visibility

Top-level handlers in the server entrypoint:

- `process.on('uncaughtException', err => { logger.fatal({ err }, 'uncaughtException'); process.exit(1); })`
- `process.on('unhandledRejection', err => { logger.fatal({ err }, 'unhandledRejection'); process.exit(1); })`
- `process.on('SIGTERM', () => { logger.info('SIGTERM received'); /* graceful shutdown */ })`
- Same for `SIGINT`.

These fire exactly once; after logging they exit. They are not "recover and keep running" handlers — that would hide bugs. They are "record why we died so the next developer can fix it" handlers.

### Field naming

Align field names with OpenTelemetry log data model conventions from day one so a later OTel adapter is a config change, not a rewrite:

| Our field       | Why                                                              |
| ---             | ---                                                              |
| `trace_id`      | Matches OTel; matches our existing spine.                        |
| `span_id`       | Not emitted yet; reserved name so we don't collide later.        |
| `req_id`        | Fastify default; keep.                                           |
| `scenario_id`   | Domain-specific; prefixed naming is fine.                        |
| `actor_type`    | Domain-specific.                                                 |
| `actor_id`      | Domain-specific.                                                 |
| `err`           | Pino default serializer includes name/message/stack.              |

Timestamps are ISO-8601 (Pino's `timestamp: pino.stdTimeFunctions.isoTime`) — consistent with the rest of the reference.

## What this does not include

- **SQLite sink.** Persisting logs to the same substrate that stores spine events is clearly the right direction but belongs in a follow-up. Rationale: it adds a schema, a retention policy, and a read path; that's a change in its own right.
- **Dashboard logs tab.** Depends on the SQLite sink. Same follow-up.
- **CLI log tail.** Same.
- **Log levels per route / dynamic level changes.** Start with a single `LOG_LEVEL` env var (default `info`). Add granular control only if a concrete need appears.

## Acceptance check

You can prove this change is working by:

1. Start the reference implementation. The terminal shows a pretty-printed "listening on 7662/7663" line in dev; in prod (`NODE_ENV=production node server/index.js`) it prints one JSON line.
2. Hit `GET /v1/streams` with a valid owner token. The terminal shows one request-start line and one request-complete line, both carrying the same `req_id`, plus a response time.
3. Hit the same endpoint with an invalid token. The error line carries the same `req_id` and a `statusCode` field.
4. Inside a handler, log secret-looking fields (`access_token: 'abc'`). The output shows `access_token: '<redacted>'`.
5. Kill the server with `SIGTERM`. The terminal shows a graceful shutdown log line before exit.
6. Manually trigger an uncaught rejection (`Promise.reject(new Error('boom'))` in a handler without `await`). The terminal shows a `fatal` log line with the stack, and the process exits.

All six behaviors are reproducible in under five minutes by a reviewer.
