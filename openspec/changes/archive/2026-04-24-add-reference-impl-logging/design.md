# Reference-implementation logging design

## Purpose

Give the reference implementation structured, trace-correlated logging and crash visibility without introducing new frameworks, new log-aggregation platforms, or new observability concepts. Elevate logs to the same standing the protocol event spine already enjoys. Keep the existing "import `startServer()` from tests" pattern working.

## Framing principle

**Logs are the non-protocol shoulder of the existing event spine.** The protocol defines which interactions produce structured events (`query.received`, `query.rejected`, `run.state_advanced`). Everything else that happens during a request — a DB call, a manifest lookup, a connector runtime callback, a bad input — deserves the same structured treatment, the same trace ID, and the same inspectability. Logging is not a separate track; it is the rest of the surface.

This framing is what prevents the usual logging drift where `console.log` accumulates for years and never becomes useful.

## Design choices

### Logger: Pino, as a direct dependency

Fastify 5 ships with Pino as its built-in logger and brings it in transitively. This change configures Pino via Fastify AND calls Pino's module-level utilities directly (specifically `pino.stdTimeFunctions.isoTime`). Relying on a transitive dep while importing from it is dishonest and fragile — a future Fastify version could swap loggers and our code would silently break. So:

- Add `pino` to `reference-implementation/package.json` as a direct dependency.
- Add `pino-pretty` as a devDependency (it is only invoked in non-production).

Alternatives considered:

- **Winston / Bunyan.** Older, slower, weaker structured-logging ergonomics. No reason to choose them on a greenfield Fastify substrate.
- **`@logtape/logtape`.** Newer, TS-native, nicer typed events. Compelling for `apps/web`, but adopting it on a Fastify server means fighting the framework. Revisit for apps/web separately.
- **Stick with the transitive dep.** Fragile; rejected above.

### Context propagation: Fastify request context, not manual threading

Fastify generates a request ID per request (configurable via `genReqId`) and automatically attaches a child logger (`request.log`) that carries it. Handlers use `request.log.info({...}, 'message')` and the req-id rides along.

The reference already computes a `trace_id` per logical protocol operation, generally early in the handler. The change is: as soon as `trace_id` (and `scenario_id`, `actor_type`, `actor_id`) are resolved, a lifecycle step rebinds `request.log` to a child logger carrying those fields, so every subsequent log line in that request carries them.

No `AsyncLocalStorage` gymnastics required at this layer. ALS becomes interesting only when we need a module-level logger that doesn't have access to `request` — not yet in scope.

### Dev vs prod output

Pino writes JSON lines to stdout. For a pleasant dev terminal we use `pino-pretty` as a Pino transport in non-production. Prod emits raw JSON.

The on-disk and on-wire log **shape** is identical in both modes. The only difference is a terminal-local formatting transform in dev.

### Redaction

Pino supports declarative redaction (`redact: { paths: [...], censor: '<redacted>' }`). The path list mirrors the secret set already recognized by `apps/web/src/app/dashboard/components/timeline-view.tsx`:

- `access_token`, `refresh_token`
- `device_code`, `user_code`
- `interaction_response`, `INTERACTION_RESPONSE`
- `req.headers.authorization` (Fastify's request serializer path)
- Nested `*.access_token` / `*.refresh_token` glob patterns

Redaction happens at serialization time, so a handler passing a secret object into a log call cannot accidentally leak plaintext.

### Crash visibility — scoped to the CLI entrypoint

`reference-implementation/server/index.js` is imported by tests. `test/pdpp.test.js` and `test/provider-metadata.test.js` call `startServer()` dozens of times per run. If we install `process.on('uncaughtException', ...)` inside `startServer` or at the module top level, every call accumulates a listener, and one test's error becomes another test's problem (or blocks Node's default exit behavior entirely).

The entrypoint block already exists at the bottom of `server/index.js`:

```js
if (process.argv[1] && process.argv[1].endsWith('server/index.js')) {
  startServer().catch(err => { console.error(err); process.exit(1); });
}
```

All four process-level handlers (`uncaughtException`, `unhandledRejection`, `SIGTERM`, `SIGINT`) go **inside that block**. They only register when the file is run directly as a CLI entrypoint, never when imported. Tests are unaffected.

Each handler fires at most once: a module-level `shuttingDown` flag gates them so a cascade doesn't double-log or hang exit. Signal handlers perform a graceful Fastify close (bounded by a 2-second timeout, matching the existing test-harness pattern) before exit.

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

Timestamps are ISO-8601 (Pino's `pino.stdTimeFunctions.isoTime`) — consistent with the rest of the reference.

### What Fastify emits by default — what we do and don't rely on

With `logger: {...}` enabled (no custom hooks beyond `genReqId`), Fastify emits by default:

- An incoming-request record at `info`: method, url, req_id.
- A request-completed record at `info`: statusCode, responseTime, req_id.

That's it for the baseline. We **do not** claim in the normative spec that we emit a per-handler error-level record with an error class name for every 4xx/5xx — most of our error paths build response envelopes via helpers like `oauthError` without throwing, so Fastify has no exception to serialize. Emitting a uniform error record for every non-2xx is a follow-up that would need either (a) a consistent `request.log.error({ err }, ...)` call in each envelope helper, or (b) an `onResponse` hook. Out of scope here.

What we **do** normatively require:

- Every request produces a completion log record with the correlation fields.
- Request-scoped logs emitted explicitly by handlers carry the correlation fields.
- Redaction is enforced.
- Crashes and signals at the CLI entrypoint produce exactly one final structured record.

## What this does not include

- **SQLite sink.** Follow-up.
- **Dashboard logs tab.** Depends on SQLite sink. Follow-up.
- **CLI log tail.** Same.
- **Log levels per route / dynamic level changes.** Start with a single `LOG_LEVEL` env var (default `info`). Add granular control only if a concrete need appears.
- **Uniform 4xx/5xx error records.** Follow-up, per the note above.

## Acceptance check

Reviewers can prove this change is working by:

1. Start the reference implementation as a CLI (`node reference-implementation/server/index.js`). The terminal shows a pretty-printed "listening on 7662/7663" line. With `NODE_ENV=production`, the same startup emits one JSON line instead.
2. Hit `GET /v1/streams` with a valid owner token. The terminal shows Fastify's request-start + request-complete lines, both carrying the same `req_id`. The completion line has `statusCode` and `responseTime`.
3. Any log line emitted by the handler during that request carries `trace_id` (if the handler resolved one) in addition to `req_id`.
4. Log an object containing `access_token: 'abc'`. The output shows `access_token: '<redacted>'`.
5. `kill -TERM <pid>` of the CLI process. Terminal shows one `info` log line acknowledging SIGTERM, then exit 0.
6. Inject an unhandled rejection (temporary `Promise.reject(new Error('boom'))` at the top of the CLI block). Terminal shows one `fatal` log line with the stack, then exit 1.
7. Run `pnpm --filter pdpp-reference-implementation test`. Test suite passes — no leaked listeners, no double-fire handlers, no change in test output formatting.

Checks 1–6 are reproducible in under five minutes by a reviewer. Check 7 proves the library/CLI boundary was respected.
