## Why

Explore rendered record identity independently in the feed row, stream table, mobile card, and detail header. That allowed id-only records to appear as confident detail-page titles even when no manifest-authored display role existed.

## What Changes

- Add a shared RecordIdentity renderer for Explore record identity surfaces.
- Treat manifest-authored display roles as the only source of confident primary titles.
- Demote derived record keys to mono, muted, secondary treatment across feed, table, card, and detail header.

## Capabilities

Modified:
- `reference-implementation-architecture`

## Impact

- Affects the reference console Explore and records surfaces only.
- Does not change PDPP protocol shapes, remote surface APIs, record storage, or connector manifests.
