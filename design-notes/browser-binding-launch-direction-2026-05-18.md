# Browser Binding Launch Direction

Status: captured
Owner: reference implementation owner
Created: 2026-05-18
Updated: 2026-05-18
Related: root Collection Profile binding vocabulary; `declare-polyfill-browser-runtime-binding`; `add-run-interaction-streaming-companion`

## Question

Should the Collection Profile browser binding model only describe runtime-provided browser automation, or should it also standardize the reference implementation's connector-self-launched browser pattern?

## Context

The Collection Profile spec defines `browser_automation` as a binding the runtime provides to the connector, including a CDP WebSocket. The reference implementation's browser-backed connectors currently do the inverse: the connector launches Patchright/Chromium and registers the resulting target for runtime streaming/assistance.

The current reference manifests also use an unqualified `browser` binding, which is not one of the spec-defined binding names.

## Stakes

The spec-pure runtime-provided CDP model is cleaner, but may weaken Patchright stealth because Patchright's strongest behavior depends on the launching module. The self-launch model reflects the working RI and keeps browser-library control inside the connector, but needs an explicit spec/manifest vocabulary if it is durable.

## Current Leaning

Do not silently absorb the mismatch. The likely SLVP direction is to acknowledge both patterns explicitly: keep `browser_automation` for runtime-provided browser sessions and add a separate self-launch capability/binding if connector-launched browsers remain a supported first-class pattern.

## Promotion Trigger

Promote this to an OpenSpec/root spec change before changing manifest binding vocabulary, connector runtime binding validation, or browser-backed connector launch architecture.

## Decision Log

- 2026-05-18: Moved from invalid no-delta OpenSpec change `reconcile-browser-binding-launch-direction` into design notes because this is an unresolved design question, not an implementable change.
