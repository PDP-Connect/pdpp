## Why

The preflight browser-surface readiness probe (added earlier) gates connector launch on a live CDP surface. It does not cover the window between a passing preflight and the moment the owner submits their OTP or manual-action response. If the n.eko container or inner Chromium drops during that wait, the connector's Playwright handle rejects only after the owner has already consumed an irreplaceable one-shot credential. The owner is then offered another interaction prompt against a surface that is still dead.

## What Changes

- Add a periodic mid-wait surface-loss detector to `browser-surface-readiness.ts` that polls the CDP HTTP base during a `manual_action` or `otp` interaction wait.
- Wire it into the controller's `brokerInteraction` path via a racing Promise: if the detector fires before the owner responds, the interaction is auto-cancelled with a typed `browser_surface_lost` resolution, a `run.browser_surface_lost` spine event is emitted, and the interaction broker does not deliver the dead interaction to the connector.
- The detector uses the same HTTP probe logic as the preflight gate (no new network dependencies) with a configurable poll interval.
- When a mid-wait loss is detected the runtime fails the run fail-closed rather than re-prompting the owner for another OTP against the same dead surface.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `reference-run-assistance`: add requirement that the runtime SHALL detect and surface a browser-surface availability failure that occurs after an interaction is open and before it resolves.
- `reference-implementation-runtime`: add scenario to the interaction-broker requirement covering mid-wait browser-surface loss.

## Impact

- Affects `reference-implementation/runtime/browser-surface-readiness.ts` (new export: `createMidWaitSurfaceLossDetector`).
- Affects `reference-implementation/runtime/controller.ts` (wire detector into `brokerInteraction` for browser-surface-attached interactions).
- Adds `reference-implementation/test/controller-midwait-browser-surface-loss.test.js`.
- Does not change PDPP Core, resource-server public APIs, grant semantics, connector manifests, the Patchright/n.eko stealth posture, connector scraping logic, `packages/remote-surface`, Docker compose, or deployment scripts.
