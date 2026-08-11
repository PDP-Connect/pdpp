## Why

The reference-only source-webhook endpoint inherits the transport-wide 200 MiB
body limit, then reparses and reserializes the body and accepts an unbounded
`records` array. On low-memory hosts this permits a signed callback to consume
multiple GiB of transient memory and substantial CPU before bounded ingest
admission applies.

## What Changes

- Add a 1 MiB maximum wire body for `POST /_ref/source-webhooks/:sourceId`.
- Add a 500-record maximum for `action: "ingest_records"`.
- Return a typed HTTP 413 resource-limit error before idempotency claim and
  before record serialization.
- Apply the 1 MiB body limit to `schedule_run` as well.
- Add deterministic operation and real-route boundary tests, including exact
  limits, one-byte overflow, and no-claim/no-ingest assertions.
- Document source-adapter chunking compatibility: chunks must stay within both
  limits and use distinct event ids under the existing dedupe key.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `reference-implementation-architecture`: bound reference-only source-webhook
  ingress resources and define its 413 behavior.

## Impact

Affected code is limited to the reference source-webhook operation and route,
the existing route-option adapter typing, source-webhook tests, and the new
OpenSpec delta. Existing callers sending larger callbacks must chunk them;
public PDPP Core surfaces and device-ingest limits are unchanged.
