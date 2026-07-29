## Decision

The collector reports terminal evidence only after a successful DONE, no scan-budget stop, record drain, and acknowledged `coverage_diagnostics` checkpoint. The server writes a `run.completed` spine event with only connector-instance identity and stream/checkpoint facts. The existing fold remains the sole writer of `stream_latest_facts_json`.

Accepted batches, heartbeats, and stored coverage records are not promoted by themselves. They cannot prove a terminal collection boundary or which streams the collector attempted. Failed or incomplete runs do not send a successful terminal report and therefore cannot manufacture committed facts or overwrite prior proof.

The report contains no paths, record payloads, coverage reasons, or credentials. It carries each stream's raw collector coverage-status set through the existing canonical runtime collection-fact normalizer; the manifest-aware coverage-policy authority remains the sole decider of accepted absence. A successful terminal report commits its coverage checkpoint, but only `missing` or `unaccounted` statuses add unresolved pending-gap evidence. `deferred`, `inventory_only`, `unavailable`, and `unsupported` remain accepted only when the manifest declares that policy; `excluded` follows its manifest declaration and never a collector-local severity guess. A coverage diagnostic with no stream is omitted. The endpoint rejects omitted or empty raw status evidence so it cannot manufacture a complete fact. The endpoint is connector-neutral and validates the device/source binding before writing the event.

## Alternatives rejected

- Infer facts from `device_ingest_batch_outcomes`: batches have no run terminal or stream-universe semantics.
- Change the fold to read coverage records: that would couple a raw-fact projection to record payload storage and still invent a terminal boundary.
