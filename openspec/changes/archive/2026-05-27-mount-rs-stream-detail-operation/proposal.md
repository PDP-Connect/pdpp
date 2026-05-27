## Why

`rs.streams.list` now proves the operation-host pattern for one read-only RS surface, but `/sandbox/v1/streams/:stream` still constructs live-shaped AS/RS behavior through a website-local builder. Stream detail is the next smallest slice to remove sandbox fork behavior while reusing the stream operation dependency seam.

## What Changes

- Introduce a canonical `rs.streams.detail` operation for stream metadata/detail behavior.
- Mount the operation from native `GET /v1/streams/:stream` and sandbox `GET /sandbox/v1/streams/:stream`.
- Reuse the fixture dependency pattern established by `rs.streams.list`.
- Delete or demote the public `buildLiveStreamMetadataResponse` sandbox builder in the same change.
- Add operation, host-parity, and import-boundary tests.
- Do not migrate schema, records, search, grants, runs, traces, well-known, or `_ref` routes in this slice.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `reference-implementation-architecture`: `rs.streams.detail` becomes operation-owned AS/RS behavior.
- `reference-web-bridge-contract`: `/sandbox/v1/streams/:stream` must mount the same operation instead of constructing its own stream-metadata envelope.

## Impact

- Affected code: native stream metadata route, sandbox stream detail route, sandbox fixture dependencies, operation modules, package exports, and tests.
- No public JSON shape change is intended for either native or sandbox stream detail responses.
- No storage adapter, Postgres adapter, broad `RecordStore`, or sandbox-wide rewrite is introduced.
