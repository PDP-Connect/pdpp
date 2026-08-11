## 1. Resource policy

- [x] 1.1 Add shared 1 MiB body and 500-record constants at the source-webhook boundary.
- [x] 1.2 Enforce the route-local body limit through the existing Fastify route-option adapter.
- [x] 1.3 Validate the record count before idempotency claim and record serialization; map it to typed 413.
- [x] 1.4 Add the smallest route-scoped Fastify body-limit error mapping needed for the documented envelope.

## 2. Tests

- [x] 2.1 Add pure operation tests for exactly 500 accepted and 501 rejected with no claim/no ingest.
- [x] 2.2 Add bounded low-memory tests for one-byte-under, exact, and one-byte-over body limits.
- [x] 2.3 Add real HTTP route tests proving route-option enforcement and typed 413 behavior for body overflow.
- [x] 2.4 Add real HTTP tests for bounded schedule_run and oversized schedule_run no-claim/no-run behavior.

## 3. Documentation and validation

- [x] 3.1 Document source-adapter chunking and distinct event-id compatibility in the OpenSpec delta.
- [x] 3.2 Run focused source-webhook tests, reference typecheck, targeted Biome, strict OpenSpec validation, and diff checks.
- [x] 3.3 Commit the isolated change with DCO sign-off and `Assisted-by: AI`.
