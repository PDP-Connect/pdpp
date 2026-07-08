## Context

The client package already owns pure geometry helpers for contain-fit rects and pointer inversion. The missing piece is a DOM primitive that observes a container, applies those helpers, and exposes the derived geometry in a reusable form.

## Decision

Implement a small DOM-only viewer surface that:

- takes a container element and an intrinsic stream viewport,
- observes container size changes with `ResizeObserver`,
- derives fitted display geometry from the existing geometry helpers,
- exposes geometry subscriptions and point mapping,
- and tears down cleanly.

The playground should consume that primitive directly. The demo should make container adaptivity visible through different container modes, not through a separate fullscreen concept.

## Out of Scope

- New framework integrations.
- Any change to pointer or fit math beyond reuse of the existing helpers.
- Any attempt to make viewport size a user-facing control unless it is still needed as the stream's intrinsic size.

## Acceptance Checks

- The primitive reports fitted geometry for several container aspect ratios, including very small and very wide/tall containers.
- Pointer mapping stays stable across the same set of container shapes.
- The playground demonstrates inline, modal, and odd-shaped container modes with the same viewer primitive.
- The old fullscreen/viewer chrome is removed from the demo surface.
