## Why

The sandbox still contains website-local AS/RS response builders, which recreates the same category error the reference architecture work is meant to remove: public demo behavior can drift from the real reference server. `rs.streams.list` is the lowest-risk operation to prove the better shape because it is visible, read-only, and already exercised by both the local RS and sandbox.

## What Changes

- Introduce a canonical `rs.streams.list` operation implementation for the reference stream-list response.
- Mount that operation from the native Fastify reference server and from the Next sandbox route host.
- Move sandbox stream-list data behind a fixture environment profile/dependency instead of a public website-local AS/RS builder.
- Add parity tests proving the same operation semantics produce the expected response in both hosts.
- Delete or demote the public `buildLiveStreamsList` sandbox builder in the same change.
- Do not migrate stream detail, schema, records, search, grants, runs, traces, or well-known routes in this slice.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `reference-implementation-architecture`: `rs.streams.list` becomes the first concrete operation-owned AS/RS behavior.
- `reference-web-bridge-contract`: `/sandbox/v1/streams` must mount the same operation instead of constructing its own stream-list envelope.

## Impact

- Affected code: `reference-implementation/server/index.js`, `reference-implementation/server/records.js` or new operation modules, `apps/web/src/app/sandbox/v1/streams/route.ts`, sandbox demo data/dependencies, and tests.
- No public API shape change is intended; the goal is byte-compatible or deliberately documented output for existing `/v1/streams` and `/sandbox/v1/streams`.
- No storage adapter, Postgres adapter, broad `RecordStore`, generic repository, or sandbox-wide rewrite is introduced.
