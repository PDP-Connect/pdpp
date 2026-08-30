## Why

PostgreSQL schema bootstrap currently gives a lock loser a short fixed retry
window. On a populated database, that window can expire while the winner is
performing valid bootstrap work, causing a restart loop. Optional manifest
reconciliation and retrieval maintenance also delay the first AS/RS listeners.

## What Changes

- Make bootstrap-lock waiting one bounded, configurable, data-aware deadline
  with explicit progress and no fixed-attempt crash window.
- Bind AS/RS after required schema bootstrap, then run optional manifest and
  retrieval maintenance asynchronously with failure isolation.
- Add focused contention/readiness tests and an exact-image populated-PostgreSQL
  first-boot oracle.

## Capabilities

### Modified

- `reference-implementation-architecture`

### Added

None.

### Removed

None.

## Impact

Reference startup behavior, PostgreSQL deployment configuration, maintenance
ordering, tests, and the disposable Docker verification path. The protocol
surface is unchanged.
