## Why

Amazon order runs can spend hours in the per-order detail lane and still be making progress when the controller watchdog terminates the run. The reference needs connector-local detail bounds so a large backfill preserves list-derived records, records honest pending detail work, and leaves enough evidence to improve the parser.

## What Changes

- Add a bounded detail-hydration policy for Amazon order runs.
- Continue list-page enumeration after the detail lane reaches its local budget, emitting durable `DETAIL_GAP` records for deferred order-item enrichment instead of exhausting the global run watchdog.
- Add recovery-only handling for Amazon `order_items` detail gaps so deferred detail work can be retried without re-walking the full order list.
- Capture one failed order-detail checkpoint when fixture capture is enabled; budget deferrals carry structured redacted gap evidence without touching the page.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `polyfill-runtime`: first-party browser connectors with optional per-record detail hydration must keep detail work bounded, recoverable, and diagnostically observable.

## Impact

- Affected connector: `packages/polyfill-connectors/connectors/amazon`.
- Affected runtime contract: existing `DETAIL_GAP` / `DETAIL_COVERAGE` behavior in `polyfill-runtime`.
- Affected tests: Amazon connector integration tests and runtime detail-gap recovery tests.
- No new external dependencies.
