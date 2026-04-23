## ADDED Requirements

### Requirement: The reference implementation SHALL emit structured, trace-correlated logs for every request
The reference implementation SHALL emit one structured log record per inbound HTTP request at completion, as JSON lines on stdout. Each request log SHALL include `req_id`, HTTP method, path, `statusCode`, and response duration in milliseconds. When a `trace_id` is established for the request (the protocol event-spine identifier), it SHALL also appear on every log line produced during that request.

#### Scenario: Successful request is logged with correlation fields
- **WHEN** a client calls an AS or RS endpoint that resolves a `trace_id`
- **THEN** the request-complete log record SHALL include `req_id`, `trace_id`, `statusCode`, and `responseTime`
- **AND** any logs emitted inside the handler SHALL carry the same `req_id` and `trace_id`

#### Scenario: Failing request is logged with correlation fields
- **WHEN** a request ends in a 4xx or 5xx status
- **THEN** the request-complete log record SHALL include the same fields as the success case plus the error class name and message
- **AND** the record SHALL be emitted at `warn` level for 4xx and `error` level for 5xx

### Requirement: The reference implementation SHALL redact known secret paths in log output
Structured log output SHALL NOT contain the plaintext of access tokens, refresh tokens, device codes, user codes, the `Authorization` header value, or the `interaction_response` payload used in hosted-UI flows. Redaction SHALL be configured declaratively at the logger, not performed per call site.

#### Scenario: A handler logs an object containing a token
- **WHEN** a handler passes an object with `access_token` or `refresh_token` into a log call
- **THEN** the emitted record SHALL show the token value as `<redacted>` (or equivalent censor value), not the plaintext

#### Scenario: An Authorization header is captured by the default request serializer
- **WHEN** the logger's request serializer records request headers
- **THEN** the `Authorization` header value SHALL appear redacted, not in plaintext

### Requirement: The reference implementation SHALL produce a final structured log record before crashing
The reference implementation SHALL install process-level handlers for `uncaughtException` and `unhandledRejection` that emit one `fatal` log record — including the error stack — before the process exits. The reference implementation SHALL install handlers for `SIGTERM` and `SIGINT` that emit one `info` log record acknowledging the signal before shutdown.

#### Scenario: An uncaught exception terminates the process
- **WHEN** code in a request handler or background task throws and the error is not otherwise caught
- **THEN** a single `fatal` log record SHALL be emitted on stdout with the error name, message, and stack before the process exits with a non-zero code

#### Scenario: An unhandled promise rejection terminates the process
- **WHEN** a promise rejection propagates to the top level
- **THEN** a single `fatal` log record SHALL be emitted on stdout with the rejection reason and stack before the process exits with a non-zero code

#### Scenario: A termination signal is received
- **WHEN** the process receives `SIGTERM` or `SIGINT`
- **THEN** a single `info` log record SHALL be emitted on stdout naming the signal before the process exits

### Requirement: Log output SHALL be JSON in production and pretty-formatted in development
The reference implementation SHALL emit raw JSON lines on stdout in production (`NODE_ENV === 'production'`) and SHALL format records for human reading (colorized, single-line-per-record) in all other environments. The pretty-print transformation SHALL be a process-local concern, not a change to the underlying log shape.

#### Scenario: Production deployment emits JSON lines
- **WHEN** the reference implementation starts with `NODE_ENV=production`
- **THEN** every log line on stdout SHALL be a single JSON object consumable by a downstream log aggregator

#### Scenario: Local dev emits pretty-printed lines
- **WHEN** the reference implementation starts without `NODE_ENV=production`
- **THEN** log lines SHALL be pretty-printed with level, timestamp, and message in a human-readable layout

### Requirement: Log field names SHALL be compatible with the OpenTelemetry log data model
The reference implementation's log records SHALL use `trace_id` (not `traceId`, `trace`, or `traceID`) for the protocol event-spine identifier. The field `span_id` SHALL be reserved for future OpenTelemetry alignment and SHALL NOT be repurposed for other concepts. Request identifiers SHALL be named `req_id`.

#### Scenario: A reviewer inspects log output for OTel compatibility
- **WHEN** a reviewer reads log records produced by the reference implementation
- **THEN** trace identifiers SHALL appear under the field name `trace_id`
- **AND** the field name `span_id` SHALL NOT be used for anything other than an OTel-shaped span identifier if emitted
