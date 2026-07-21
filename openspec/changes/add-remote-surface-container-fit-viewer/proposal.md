## Why

The playground currently treats "fullscreen" as a special UI state and reimplements container fitting in the demo. That does not exercise the real capability the product needs: a viewer primitive that adapts to whatever box it is placed in.

## What Changes

- Add a framework-agnostic container-fit viewer primitive to `packages/remote-surface/src/client/`.
- Export the primitive from the client entry.
- Update the playground to use the primitive and remove the bespoke fullscreen/viewer chrome and viewport-sizing control.
- Keep the existing telemetry surfaces live while the viewer is shown in multiple container shapes.

## Capabilities

- Modified: `reference-implementation-architecture`

## Impact

This adds a reusable client primitive and changes the acceptance playground from a faux fullscreen demo into a container-adaptivity demo.
