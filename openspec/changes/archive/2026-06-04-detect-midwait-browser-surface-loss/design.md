# Design: detect-midwait-browser-surface-loss

## Problem statement

The preflight readiness probe runs once, immediately before the connector child is spawned. If the browser surface dies *after* that probe passes but *during* an interaction wait (OTP, manual_action), the connector's Playwright handle eventually rejects, but only after the owner has already submitted the irreplaceable credential.

The runtime currently has no mechanism to detect surface loss mid-wait and fail closed before the owner is re-prompted.

## Approach

### Mid-wait surface-loss detector

A new `createMidWaitSurfaceLossDetector(surface, probe, options)` factory in `browser-surface-readiness.ts` returns a single-fire `Promise<BrowserSurfaceReadinessProbeFailure>` that:

1. Polls `probe.probe(surface)` at `pollIntervalMs` (default 10 s).
2. On the first failing result, resolves the promise with the typed failure.
3. Is cancelled when the caller disposes it.

The detector is intentionally simple: no exponential back-off, no grace retries. A single probe failure mid-wait is sufficient evidence that the surface is not usable, and a false positive is far less damaging than burning an OTP against a dead surface.

### Wiring in `brokerInteraction`

`brokerInteraction` in `controller.ts` already returns a `Promise<InteractionResponse>` that resolves when the owner submits a response or the interaction times out. The detector races against it:

```
Promise.race([
  ownerResponsePromise,      // existing path: owner submits OTP / acknowledges
  surfaceLossPromise,        // new: detector fires if CDP goes dark
])
```

When the detector wins the race:
- The pending interaction entry is cleared from `activeRunInteractions` so `respondToInteraction` will throw `no_pending_interaction` (stale-interaction guard already exists).
- A `run.browser_surface_lost` spine event is emitted with the probe failure code and detail.
- The promise resolves with `{ type: "INTERACTION_RESPONSE", request_id: ..., status: "cancelled" }`.
- The runtime receives `cancelled`, records `run.interaction_completed { status: "cancelled" }`, writes `INTERACTION_RESPONSE` to the connector, and the connector is expected to terminate or fail.

The detector is only created for interactions where the controller can find an active browser-surface lease for the run and the interaction kind is `manual_action` or `otp`. Non-browser interactions skip it entirely.

### Event name: `run.browser_surface_lost`

- Not `run.browser_surface_probe_failed` (that event covers the preflight).
- Not something implying provider-side failure. This is a surface availability failure: the reference's own browser-surface infrastructure went dark after the interaction opened.
- The event carries: `interaction_id`, `kind`, and a `browser_surface_probe` envelope with the typed failure `code` and `detail`, matching the preflight probe event shape.

### Fail-closed guarantee

Once the detector resolves with a surface-loss result, no subsequent call to `respondToInteraction` for the same `interaction_id` can deliver data to the connector. The pending entry is cleared before the detector result propagates, so the stale-interaction guard in `respondToInteraction` fires.

## Alternatives considered

### Re-probe on response submission (lazy)

Check the surface only when the owner submits their OTP, before forwarding the response. Pro: simpler. Con: does not protect against the case where the surface dies and the connector hangs indefinitely without a response. The owner must actively try to submit before the check fires. This does not close the re-prompt loop.

### WebSocket keep-alive on the CDP socket

Monitor the CDP WebSocket directly for disconnection events. Pro: lower latency. Con: requires opening a live WebSocket connection from the controller (not just an HTTP probe), adds a persistent connection per active wait, and the controller does not otherwise own the CDP session. The HTTP probe approach is sufficient and consistent with the preflight gate already in place.

### Connector-side surface-health signal

Have the connector emit a `SURFACE_LOST` message when its Playwright handle disconnects. Pro: most accurate. Con: requires connector-protocol changes, and the connector may already be stuck at the Playwright handle level and unable to emit. Controller-side detection is an independent defense layer.

## Acceptance checks

1. A test creates a fake surface that passes the preflight probe, starts a `manual_action` interaction, then makes the fake surface fail subsequent probes. The test asserts:
   - `run.browser_surface_lost` spine event is emitted with the probe failure code.
   - The interaction resolves with `cancelled`.
   - No re-prompt is delivered (calling `respondToInteraction` with the same interaction_id throws `no_pending_interaction`).
2. Existing controller-browser-surface-readiness tests remain green.
3. `pnpm --dir reference-implementation run typecheck` passes with no new errors.
4. `pnpm --dir reference-implementation run check` passes.
5. `openspec validate detect-midwait-browser-surface-loss --strict` passes.

## What is NOT in scope

- Patchright/n.eko stealth posture changes.
- Connector scraping logic.
- `packages/remote-surface`.
- Docker compose or deployment scripts.
- Live browser connector flows.
- Re-prompting the owner from within this change. That is a scheduler/policy concern.
