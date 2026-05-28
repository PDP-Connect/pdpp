## Why

Record ingest and direct delete now have focused atomicity tests, but those tests are still bound to the current helper functions. Before extracting `RecordStore` or proving alternate storage profiles, PDPP needs a reusable conformance harness that states the durable record-mutation semantics once and can be run against the current SQLite implementation and future candidate implementations.

## What Changes

- Add a test-only record mutation conformance harness with a narrow driver shape for durable record writes.
- Run that harness against the current SQLite-backed reference implementation.
- Preserve the existing focused atomicity tests or replace them only if the new harness covers the same evidence.
- Include a falsifiability check so the harness is not just a green-path wrapper.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `reference-implementation-architecture`: durable record mutation behavior gains an executable conformance target before any `RecordStore` extraction.

## Impact

- Affected code: reference tests under `reference-implementation/test/**`; possibly small test-only helper modules.
- Affected behavior: no runtime behavior change intended.
- No public API shape change is intended.
- No `RecordStore`, Postgres adapter, operation capsule, sandbox host, or production storage abstraction is introduced by this change.
