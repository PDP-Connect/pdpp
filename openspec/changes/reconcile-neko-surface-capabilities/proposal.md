## Why

A reference application can require n.eko window-settle behavior that an already-running static or dynamic container does not implement. That deploy-order skew currently reaches the viewer as a downstream 404 and black frame.

## What Changes

- Probe the required n.eko window-settle behavior before stream attachment.
- Reconcile incompatible dynamic surfaces safely: preserve profiles, replace idle surfaces, and defer an active surface until its run releases it.
- Reject an incompatible surface before stream attachment with a typed retryable failure.
- Make the reference stack rebuild the n.eko image together with app changes that require this behavior.
- Add deterministic deploy-order and visual-smoke regressions.

## Capabilities

- Modified: `reference-implementation-architecture`

## Impact

Affected areas are n.eko image/Compose deployment, existing allocator/lease replacement lifecycle, stream minting, and public manual-action smoke evidence.
