## Why

Multi-account connectors can record successful runs in scheduler history while their operator connection summaries still show no latest run when spine run summaries are connector-wide. This leaves owners with false "checking" or unknown states even though the scheduler has exact per-connection evidence.

## What Changes

- Add a semantic scheduler-store read for the latest run-history row for one `connector_instance_id`.
- Teach connection summaries to use exact scheduler history before legacy connector-wide spine fallback.
- Add regression coverage for sibling connections under one connector.

## Capabilities

Modified:

- `reference-connector-instances`

## Impact

- Reference implementation only.
- No protocol or public PDPP wire contract change.
- Improves owner-console/diagnostics evidence for multi-account connectors.
