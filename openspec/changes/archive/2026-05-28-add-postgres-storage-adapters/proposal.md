## Why

The reference implementation now has operation-owned route semantics, so the
next risk is proving that selected storage capabilities can run on Postgres
without changing PDPP behavior. This is the first of two Postgres slices: prove
low-risk storage adapters before attempting the records/search runtime slice.

## What Changes

- Add Postgres-backed reference storage adapters for low-risk capability stores
  that already have conformance harnesses.
- Keep SQLite as the default runtime backend.
- Keep Postgres opt-in through explicit test/runtime configuration and the
  existing profile-gated proof service.
- Run SQLite, memory, and Postgres adapters through shared conformance tests.
- Preserve operation modules as storage-driver-agnostic consumers of explicit
  capability contracts.
- Exclude records, blobs, disclosure spine, lexical retrieval, semantic
  retrieval, hybrid retrieval, and full app-wide Postgres runtime migration.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `reference-implementation-architecture`: add architecture requirements for
  profile-gated Postgres storage adapter proofs and the two-slice Postgres
  migration boundary.

## Impact

- Affected areas: `reference-implementation/server/stores/**`,
  `reference-implementation/test/helpers/**`, Postgres conformance tests,
  README/env documentation, and OpenSpec architecture docs.
- SQLite remains the default local reference implementation behavior.
- Postgres remains a proof/test backend for this slice unless explicitly
  selected by environment.
