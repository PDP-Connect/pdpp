## Why

Amazon order detail pages can be slow or temporarily unavailable. The connector currently treats failed detail attempts as generic gaps after spending the same retry/wait budget on each order, so a long detail tail can consume most of a four-hour run while leaving little fixture evidence for the failing page shape.

## What Changes

- Capture a failed Amazon detail page fixture when connector fixture capture is enabled.
- Classify Amazon detail failures into retry-exhausted, redirected/non-detail, parse-missing, and deferred-budget reasons.
- Bound repeated temporary detail failures by deferring later detail fetches as `DETAIL_GAP` records instead of continuing the same expensive wait pattern.
- Preserve `DETAIL_COVERAGE`, `DETAIL_GAP`, known-gap honesty, and existing checkpoint semantics.

## Capabilities

Modified:

- `polyfill-runtime`

## Impact

- Code scope: Amazon polyfill connector and focused tests.
- Runtime scope: no global watchdog change; no deploy, restart, or live run.
- Operator impact: runs remain partial-but-honest when detail pages fail repeatedly, with raw fixtures retained only under existing capture opt-ins.
