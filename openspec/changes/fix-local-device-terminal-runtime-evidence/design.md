## Decision

The collector reports terminal evidence only after a successful DONE, no scan-budget stop, record drain, and acknowledged `coverage_diagnostics` checkpoint. The server writes a `run.completed` spine event with only connector-instance identity and stream/checkpoint facts. The existing fold remains the sole writer of `stream_latest_facts_json`.

Accepted batches, heartbeats, and stored coverage records are not promoted by themselves. They cannot prove a terminal collection boundary or which streams the collector attempted. Failed or incomplete runs do not send a successful terminal report and therefore cannot manufacture committed facts or overwrite prior proof.

The report contains no paths, record payloads, coverage reasons, or credentials. It carries the existing canonical runtime collection-fact fields. A collected diagnostic may establish a committed zero-gap fact; deferred, inventory-only, missing, unsupported, excluded, or unaccounted diagnostics remain non-committed facts with their unresolved diagnostic count and a safe skip reason. A coverage diagnostic with no stream is omitted. The endpoint reuses the existing collection-fact normalizer and rejects a report that omits `pending_detail_gaps`, rather than accepting its defensive zero fallback. The endpoint is connector-neutral and validates the device/source binding before writing the event.

## Alternatives rejected

- Infer facts from `device_ingest_batch_outcomes`: batches have no run terminal or stream-universe semantics.
- Change the fold to read coverage records: that would couple a raw-fact projection to record payload storage and still invent a terminal boundary.
