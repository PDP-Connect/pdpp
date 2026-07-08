## Why

The RBS technique mine identifies mobile touch handling as a concrete portability gap in the CDP remote-surface adapter. RBS used mouse-backed touch gestures for click reliability: prevent browser gestures, suppress synthetic mouse events, start drags only after an 8 px threshold, and commit taps as mouse press/release pairs.

`@opendatalabs/remote-surface` already has that convention in the n.eko pointer controller, but the CDP adapter still forwards DOM touch events as CDP touch events. That leaves the CDP path below the RBS baseline for mobile tap and drag behavior.

## What Changes

- Port the RBS tap/drag touch policy into the CDP adapter DOM listener path.
- Keep direct `sendPointer()` behavior unchanged for programmatic callers.
- Add regression tests for touch tap, touch drag threshold, touch cancel release, and synthetic mouse suppression.

## Capabilities

### Modified Capabilities

- `reference-implementation-architecture`: define the CDP remote-surface adapter's mobile touch handling contract.

### Added Capabilities

None.

### Removed Capabilities

None.

## Impact

- Affects `packages/remote-surface/src/adapters/cdp-surface-adapter.ts` and its tests.
- Does not change wire formats, package exports, protocol semantics, n.eko behavior, or live-stack operations.
- CDP strict-stealth policy is unchanged: this only changes how local DOM touch events are translated once a CDP-backed surface is already in use.
