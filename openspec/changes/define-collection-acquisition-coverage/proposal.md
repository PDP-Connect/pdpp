## Why

Google Maps Timeline, WhatsApp exports, Apple Health exports, Takeout archives,
device media folders, and similar sources expose a stale gap in the Collection
Profile: collection can arrive through multiple acquisition methods, often
partially and out of order, while still populating the same logical streams.

Without a shared acquisition/coverage model, each source needs bespoke setup,
dedupe, provenance, and health language. That creates incidental complexity and
lets owner-facing surfaces overclaim "connected" or "synced" when the honest
state is partial coverage from one or more acquisition batches.

## What Changes

- Define acquisition batches as the durable Collection Profile concept for one
  upload, sync pass, backup import, browser-polyfill pass, or provider API
  window.
- Keep acquisition method, trigger/setup posture, and stream identity orthogonal.
- Allow multiple acquisition methods to populate the same streams for one
  connection when provenance and identity rules make that safe.
- Require acquisition batches to carry coverage claims, provenance, counts, gaps,
  and parser/source-format facts sufficient for idempotent re-imports and honest
  owner UX.
- Update reference health semantics so owner surfaces show coverage receipts,
  missing-media/stale/manual-refresh advisories, and "re-export/refresh" actions
  without treating expected partial coverage as a generic failure.

## Capabilities

Modified:
- `polyfill-runtime`
- `reference-connection-health`
- `reference-connector-instances`

Added:
- None.

Removed:
- None.

## Impact

- No runtime implementation in this change.
- No PDPP Core change; grant-scoped reads remain collection-method agnostic.
- Future implementation will touch connector manifest schema, upload/import
  setup, connection health projection, acquisition-batch storage, and connector
  validators.
- Existing connectors remain valid until they opt into acquisition-batch
  reporting.
