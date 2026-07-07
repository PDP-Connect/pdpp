## Why

A live Amazon connection stayed permanently non-green with pending
`connector_detail_gaps` that could never recover. Root cause: the durable gap
identity includes the full `detail_locator_json`. The Amazon connector's locator
shape changed (it began emitting `order_date`), so a re-discovery of the same
order minted a new identity instead of matching the existing pending row. The
old-shape pending row was never closed when the order was later recovered under
the new-shape locator, so it re-attempted under a locator it could not satisfy.
The locator is volatile; it must not be part of gap identity when `record_key` is
available.

## What Changes

- Durable detail-gap identity SHALL be `(connector_instance_id, grant_id,
  stream, parent_stream, record_key)` when `record_key` is present. The volatile
  `detail_locator_json` is excluded from that identity. When no `record_key`
  exists the locator remains the disambiguator, namespaced so it cannot collide
  with a record-key gap.
- A re-discovery of the same record under a new locator shape SHALL re-upsert
  the same durable row, update the stored locator to the newer shape, and allow
  recovery to close the pre-existing pending row.
- The storage migration SHALL reconcile pre-existing locator-drift duplicate
  rows before rebuilding the identity index, so it is safe over existing
  duplicate data.

## Capabilities

Modified:
- `polyfill-runtime`

## Impact

- `connector_detail_gaps` unique identity index changes on both storage
  backends (SQLite and Postgres). The migration is idempotent and reconciles
  pre-existing duplicate rows. No collected record data is altered; only
  redundant orphan gap rows are collapsed.
- Store identity (`gap_id`) derivation changes for new rows whose connector did
  not supply an explicit `gap_id`. Connector-supplied `gap_id` override behavior
  is unchanged.
- No wire-format or connector-facing contract change: `DETAIL_GAP` and
  `DETAIL_GAP_RECOVERED` messages are unaffected.
