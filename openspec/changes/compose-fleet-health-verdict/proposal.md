## Why

The shared stream-health authority must remain distinct from fleet scope: a
stream result does not by itself assess owner actions, runtime state, or
unassessed connections.

## What Changes

- Add a server-owned, read-only fleet-health composition over configured
  connection inventory, current connection summaries and rendered verdicts,
  runtime evidence, and the shared stream-health authority result.
- Return a strict `fully_healthy` boolean, fleet state, explicit assessed and
  excluded scope, and typed evidence buckets without persisting fleet state or
  parsing presentation copy.
- Expose the composition through one owner-only read surface and migrate the
  dashboard aggregate-health copy to use it while retaining connection detail.
- Use one stream-health authority contract from the production owner API,
  rendered Sources acceptance, and the acceptance CLI; fleet scope remains a
  separate composition concern.

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
- Server and console tests plus deterministic stream-health authority fixtures.
- No protocol, persistence schema, connector behavior, or live instance state
  changes.
