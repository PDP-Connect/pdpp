# Durable record rejections

The reference server retains a hosted-ingest input when it rejects that input as a permanent per-record error. The receipt lets a connector run advance its cursor without making the rejected source item irrecoverable.

This behavior applies only to ordinary hosted connector ingest. Device exporters keep their existing retry and checkpoint rules.

## Ingest response

A successful hosted ingest response reports every non-empty NDJSON input as accepted or durably rejected:

```json
{
  "records_attempted": 2,
  "records_accepted": 1,
  "records_rejected": 1,
  "rejections": [
    {
      "input_index": 1,
      "receipt_id": "rr_...",
      "code": "invalid_record_identity"
    }
  ]
}
```

`input_index` is zero-based over non-empty NDJSON lines. Blank lines do not consume an index. The response contains metadata only. It does not contain the rejected payload or an internal parser or storage error.

The runtime requires a complete, balanced response before it stages later state. A new runtime fails closed when an older server returns only counts. An older runtime can ignore the additive fields, but a new server still stores each rejection before it acknowledges the request.

## Owner inspection

The reference server provides two read-only owner-session routes:

- `GET /_ref/connections/{connection_id}/record-rejections`
- `GET /_ref/connections/{connection_id}/record-rejections/{receipt_id}`

The list route has a maximum page size of 100 and uses an opaque cursor. It returns the receipt, connection, connector, stream, reason code, byte count, digest, timestamps, replay count, run id, and status. It does not return payload text.

The detail route returns the exact retained line as `payload_base64` with `payload_encoding: "base64"` and a nullable `payload_text` preview when strict UTF-8 decoding is lossless. The server first verifies that the current owner controls the connection. A missing receipt and a receipt outside that owner's connection use the same not-found response.

There are no retry, edit, resolve, or discard routes in this change.

## Storage and limits

Rejected payloads use the configured SQLite or PostgreSQL storage backend. They stay inside the same owner boundary as records.

The default pending-payload quota is 10 MiB per owner. Set `PDPP_RECORD_REJECTION_OWNER_QUOTA_BYTES` to a non-negative integer byte count to change the deployment quota. `0` disables new rejection storage and therefore makes affected hosted ingest fail closed. A malformed value is rejected instead of being rounded or silently replaced.

One retained line cannot exceed the hosted request ceiling. The current ceiling is 50 MiB. The server measures UTF-8 bytes before it starts the quota transaction.

The 50 MiB value is a buffered hosted request/line ceiling, not a universal container memory bound. The current Fastify/Node hosted path buffers the request body before operation-level LF slicing and stores durable rejection payload bytes in the same process. The split-cgroup hard-memory oracle runs the server in a constrained Docker container and the load generator in the host process:

```bash
pnpm --dir reference-implementation run test:hosted-ingest-memory-cgroup -- --memory 512m --line-bytes 52428800 --no-trailing-newline --expect success
pnpm --dir reference-implementation run test:hosted-ingest-memory-cgroup -- --memory 512m --line-bytes 52428801 --no-trailing-newline --expect refusal
```

Measured on Docker `node:22-bookworm-slim` with server memory and swap both capped, a read-only repo mount, and a tmpfs server workspace: with the ceiling lowered to 50 MiB, a 512 MiB server container completes an exact 50 MiB invalid-UTF-8 request body and returns exact 413 with `FST_ERR_CTP_BODY_TOO_LARGE` for a 50 MiB + 1 byte body. Each successful run also verifies protected-resource metadata after the request. These are representative oracle facts for the reference container shape, not a portable deployment guarantee. Larger buffered payload support requires materially higher memory evidence or a streaming follow-up.

Pending entries do not expire automatically. Exact replay returns the existing receipt and does not consume quota twice. Deleting a connection deletes its rejection rows and releases their quota in the same source-of-truth transaction.

The list route never returns payload bytes. Runtime results, run accounting, and terminal evidence contain counts and receipt metadata only. Treat the detail route as personal-data access and protect owner sessions accordingly.

Retained-size accounting includes rejected line payload bytes in the global, connection, and stream grains as `record_rejection_payload_bytes` and `record_rejection_count`. `total_retained_bytes` includes those payload bytes once. Audit events, quota rows, hashes, and receipt metadata are not counted as retained payload bytes.

## Deployment and rollback

Deploy the schema and server before the new runtime. The server must persist rejection receipts before a runtime may rely on them for cursor progress.

You may roll back the runtime while the new server remains. Do not roll the server back below receipt persistence while hosted connector runs are enabled. Disable and drain hosted runs first; otherwise the earlier cursor-advance data-loss defect returns. Keep the additive rejection tables during rollback.

SQLite and PostgreSQL use different transaction mechanisms but the same receipt contract. Run the configured backend's journey tests before rollout. A skipped PostgreSQL test is not PostgreSQL evidence.

## Deferred work

Atomic retry, discard, payload replacement, and resolution need a separate reviewed design. That design must commit record acceptance and receipt resolution together in each backend. Device-exporter adoption also needs a separate outbox and checkpoint contract. This tranche adds no mutation route and no generic unit-of-work abstraction.
