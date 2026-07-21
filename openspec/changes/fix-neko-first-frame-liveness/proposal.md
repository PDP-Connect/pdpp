## Why

The presentation acknowledgement gate correctly prevents a stale n.eko screenshot from being promoted, but it can leave the stream frame-less until the next polling interval. A sequence of viewport changes can discard every fetched frame even after the newest presentation has settled.

## What Changes

- Coalesce a stale frame's replacement to the latest settled presentation epoch and fetch it immediately.
- Bound immediate replacement work to one replacement per polling cycle so continuous viewport churn cannot create an unbounded retry chain.
- Make the deterministic first-frame regression a required passing test and add a bounded-churn regression.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `reference-implementation-architecture`: n.eko frame delivery gains a bounded liveness guarantee while retaining presentation acknowledgement safety.

## Impact

Affected areas are the n.eko streaming adapter, its deterministic adapter tests, and the streaming reference-implementation architecture capability specification. No protocol, endpoint, or dependency changes are introduced.
