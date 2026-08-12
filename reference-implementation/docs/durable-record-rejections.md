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

One retained line cannot exceed the hosted request ceiling. The current ceiling is 200 MiB. The server measures UTF-8 bytes before it starts the quota transaction.

Pending entries do not expire automatically. Exact replay returns the existing receipt and does not consume quota twice. Deleting a connection deletes its rejection rows and releases their quota in the same source-of-truth transaction.

The list route never returns payload bytes. Runtime results, run accounting, and terminal evidence contain counts and receipt metadata only. Treat the detail route as personal-data access and protect owner sessions accordingly.

## Deployment and rollback

Deploy the schema and server before the new runtime. The server must persist rejection receipts before a runtime may rely on them for cursor progress.

You may roll back the runtime while the new server remains. Do not roll the server back below receipt persistence while hosted connector runs are enabled. Disable and drain hosted runs first; otherwise the earlier cursor-advance data-loss defect returns. Keep the additive rejection tables during rollback.

SQLite and PostgreSQL use different transaction mechanisms but the same receipt contract. Run the configured backend's journey tests before rollout. A skipped PostgreSQL test is not PostgreSQL evidence.

## Deferred work

Atomic retry, discard, payload replacement, and resolution need a separate reviewed design. That design must commit record acceptance and receipt resolution together in each backend. Device-exporter adoption also needs a separate outbox and checkpoint contract. This tranche adds no mutation route and no generic unit-of-work abstraction.
