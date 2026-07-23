## Why

The required-stream audit can pass while the configured fleet has owner-blocking
actions, broken connectors, runtime failures, or unassessed connections. Its
coverage result is being mistaken for an instance-health verdict.

## What Changes

- Add a server-owned, read-only fleet-health composition over configured
  connection inventory, current connection summaries and rendered verdicts,
  runtime evidence, and the existing stream-coverage audit.
- Return a strict `fully_healthy` boolean, fleet state, explicit assessed and
  excluded scope, and typed evidence buckets without persisting fleet state or
  parsing presentation copy.
- Expose the composition through one owner-only read surface and migrate the
  dashboard aggregate-health copy to use it while retaining connection detail.
- Keep the stream audit as narrow coverage evidence; it does not become a
  fleet-health verdict.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `reference-connection-health`: Add the owner fleet-health composition and
  its typed state, scope, and evidence contract.
- `reference-connector-instances`: Require fleet evidence to retain each
  configured connection identity rather than collapsing by connector type.

## Impact

- `reference-implementation/server/`: pure composition module, owner summary
  read path, and owner-only route.
- `apps/console/`: dashboard aggregate-health copy.
- Server and console tests plus deterministic stream-audit fixtures.
- No protocol, persistence schema, connector behavior, or live instance state
  changes.
