## ADDED Requirements

### Requirement: The reference implementation SHALL emit a structured completion log for every request

When the reference implementation is running as a server (whether as a CLI entrypoint or as a library-embedded instance), every inbound HTTP request SHALL produce a single completion log record containing `req_id`, HTTP method, path, `statusCode`, and `responseTime` in milliseconds. The record SHALL be emitted at `info` level. The record's structured field set SHALL be identical across all environments; only terminal formatting MAY differ between development and production.

#### Scenario: Successful request produces a completion record
- **WHEN** a client calls an AS or RS endpoint
- **THEN** exactly one request-completion log record SHALL be emitted
- **AND** that record SHALL include `req_id`, method, path, `statusCode`, and `responseTime`

#### Scenario: Completion record shape is environment-independent
- **WHEN** the same request is served under `NODE_ENV=production` and under non-production
- **THEN** the set of structured fields in the completion record SHALL be identical across both environments

### Requirement: Request-scoped logs SHALL carry protocol trace correlation

The reference implementation SHALL rebind the Fastify request-scoped logger to include `trace_id`, `scenario_id`, `actor_type`, and `actor_id` as child-logger fields once those values are resolved for the request. Any log record emitted by handler code after that rebind SHALL carry those fields when they are present for the request. Requests for which no `trace_id` is established (e.g. static metadata endpoints that do not participate in the event spine) SHALL NOT have a synthetic `trace_id` fabricated.

#### Scenario: Handler log line inherits trace correlation
- **WHEN** a handler resolves a `trace_id` for a request and then calls `request.log.info(...)`
- **THEN** the emitted record SHALL include both `req_id` and `trace_id`

#### Scenario: No trace resolved means no trace_id field
- **WHEN** a request completes without the reference implementation establishing a `trace_id` for it
- **THEN** the completion record SHALL NOT include a `trace_id` field

### Requirement: The reference implementation SHALL redact known secret paths in log output

Structured log output SHALL NOT contain the plaintext of access tokens, refresh tokens, device codes, user codes, the `Authorization` header value, or the `interaction_response` payload used in hosted-UI flows. Redaction SHALL be configured declaratively at the logger, not performed per call site.

#### Scenario: A handler logs an object containing a token
- **WHEN** a handler passes an object with `access_token` or `refresh_token` into a log call
- **THEN** the emitted record SHALL show the token value as `<redacted>` (or equivalent censor value), not the plaintext

#### Scenario: An Authorization header is captured by the default request serializer
- **WHEN** the logger's request serializer records request headers
- **THEN** the `Authorization` header value SHALL appear redacted, not in plaintext

### Requirement: The CLI entrypoint SHALL produce a final structured log record on crash or signal

When `reference-implementation/server/index.js` is run as a CLI entrypoint, it SHALL install process-level handlers for `uncaughtException`, `unhandledRejection`, `SIGTERM`, and `SIGINT`. Each handler SHALL emit exactly one log record before the process exits. These handlers SHALL NOT be installed when `server/index.js` is imported as a library (for example, from a test harness); the reference implementation SHALL NOT register global `process.on` listeners from any code path other than the CLI entrypoint block.

#### Scenario: Uncaught exception at the CLI entrypoint
- **WHEN** the CLI is running and code in a request handler or background task throws and the error is not otherwise caught
- **THEN** exactly one `fatal` log record SHALL be emitted on stdout with the error name, message, and stack before the process exits with a non-zero code

#### Scenario: Unhandled promise rejection at the CLI entrypoint
- **WHEN** the CLI is running and a promise rejection propagates to the top level
- **THEN** exactly one `fatal` log record SHALL be emitted on stdout with the rejection reason and stack before the process exits with a non-zero code

#### Scenario: Termination signal at the CLI entrypoint
- **WHEN** the CLI process receives `SIGTERM` or `SIGINT`
- **THEN** exactly one `info` log record SHALL be emitted on stdout naming the signal before the process performs graceful shutdown and exits

#### Scenario: Library import does not pollute the process
- **WHEN** a test or another Node program imports `startServer` from `server/index.js` and calls it one or more times
- **THEN** the reference implementation SHALL NOT add any listeners to `process` for `uncaughtException`, `unhandledRejection`, `SIGTERM`, or `SIGINT`

### Requirement: Log shape SHALL be JSON; development output MAY be pretty-printed for the terminal only

The reference implementation SHALL produce log records as JSON objects at the point of emission. In production (`NODE_ENV === 'production'`) those JSON objects SHALL be written to stdout verbatim as one JSON line per record. In all other environments a terminal-local transform MAY reformat records for human reading. The transform SHALL NOT add, remove, or rename structured fields in the underlying record.

#### Scenario: Production deployment emits JSON lines
- **WHEN** the reference implementation starts with `NODE_ENV=production`
- **THEN** every log line on stdout SHALL be a single JSON object consumable by a downstream log aggregator without further parsing

#### Scenario: Local dev emits pretty-printed lines carrying the same structured fields
- **WHEN** the reference implementation starts without `NODE_ENV=production`
- **THEN** log output MAY be pretty-printed for the terminal
- **AND** every structured field present in the production JSON form SHALL remain observable in the pretty form

### Requirement: Log field names SHALL be compatible with the OpenTelemetry log data model

The reference implementation's log records SHALL use `trace_id` (not `traceId`, `trace`, or `traceID`) for the protocol event-spine identifier. The field `span_id` SHALL be reserved for future OpenTelemetry alignment and SHALL NOT be repurposed for other concepts. Request identifiers SHALL be named `req_id`.

#### Scenario: A reviewer inspects log output for OTel compatibility
- **WHEN** a reviewer reads log records produced by the reference implementation
- **THEN** trace identifiers SHALL appear under the field name `trace_id`
- **AND** the field name `span_id` SHALL NOT be used for anything other than an OTel-shaped span identifier if emitted
