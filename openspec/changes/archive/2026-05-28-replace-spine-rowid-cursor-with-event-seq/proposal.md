## Why

Disclosure-spine pagination is now bounded, but its cursor still uses SQLite `rowid` as an ordering tiebreaker. `rowid` is an implementation detail and should not be part of a reference-runtime contract or future storage-adapter shape.

## What Changes

- Add an explicit stable spine event sequence for timeline pagination.
- Replace rowid-derived spine cursors with opaque tokens over stable event ordering.
- Extend disclosure-spine conformance coverage for tied timestamps and interleaved appends.

## Capabilities

Modified:

- `reference-implementation-architecture`

## Impact

- Production code: spine schema/query/cursor helpers.
- Tests: disclosure-spine conformance and `_ref` timeline pagination tests.
- Out of scope: extracting a production `DisclosureSpineStore` or changing public event payload fields.
