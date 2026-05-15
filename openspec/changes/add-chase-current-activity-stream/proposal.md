## Why

Chase's live account activity UI can show pending and current-cycle rows that are not present in QFX/Web Connect downloads. The reference connector should expose that fresh activity without weakening the existing posted-only, append-only `transactions` stream.

## What Changes

- Add a Chase `current_activity` stream for UI-visible account activity, including pending rows and recently posted rows when Chase shows them.
- Keep `transactions` unchanged as the canonical posted-only QFX stream keyed by `account_id|fitid`.
- Model `current_activity` as `mutable_state` because UI-visible activity may change, disappear, or post under a different durable identity.
- Treat UI-derived activity as a freshness/visibility surface, not a settled ledger or automatic replacement for QFX transactions.

## Capabilities

### New Capabilities

### Modified Capabilities

- `reference-implementation-architecture`: Adds reference behavior for exposing Chase UI-visible current activity separately from posted-only QFX transactions.

## Impact

- `packages/polyfill-connectors/manifests/chase.json`
- Chase connector schemas and parser/collector code
- Chase fixture capture and validation coverage
- Reference dataset consumers that choose to request or display fresh Chase activity
