## 1. Key-scoped surface measure gate + production coordinator

- [x] Add `stream-surface-measure-gate.ts`: `requestSurfaceMeasure` (measure
      now on matching attached key, else queue fail-closed) and
      `drainSurfaceMeasureOnAttach` (drain only on matching-key attach).
- [x] Add `createStreamSurfaceMeasureCoordinator(measure)`: a single stateful
      object wrapping the pure reducer, exposing `requestBackendReady` and
      `attachSurface`. `stream-viewer.tsx` constructs exactly one instance
      and routes BOTH the `backend_ready` handler and `setStreamSurfaceNode`'s
      ref callback through it exclusively — neither calls
      `requestViewportMeasureRef` directly.

## 2. Regression coverage

- [x] Desktop attach: 1400x1005 controlling attachment seeds from the
      desktop stage, never a letterboxed placeholder box.
- [x] Mobile portrait/landscape/rotation presentation unaffected.
- [x] Production-shaped same-session `backend_ready` replay (reconnect)
      measures immediately and leaves nothing pending.
- [x] Transition-identity mismatch: an attach for a different key never
      drains an unrelated pending request.
- [x] Superseding request discards the prior one fail-closed.
- [x] Production-shaped tests drive the REAL `createStreamSurfaceMeasureCoordinator`
      factory (not a reimplementation), asserting on an injected measurement
      spy's exact call sequence — including zero measurements before the
      correct surface attaches, wrong-key attach, null detach, supersede, and
      same-session mobile rotation.
- [x] Wiring-exclusivity guard (narrow complement, not the primary oracle):
      the `backend_ready` handler's bounded source block contains zero
      direct `requestViewportMeasureRef` calls and exactly one coordinator
      call.
- [x] Mutation-proof: reintroducing the exact double-wire an independent
      review specified (`requestViewportMeasureRef.current?.("neko-backend-ready")`
      immediately before the coordinator call, in production
      `stream-viewer.tsx`) fails the wiring guard. Both gate directions
      (always-defer, always-measure-now) fail the corresponding production-
      shaped behavioral tests.

## 3. Validation

- [x] `node --test` across the full stream test directory (191/191 pass).
- [x] `tsc --noEmit` clean.
- [x] `biome check` clean on touched files.
- [x] Parity oracle (`stream-parity-geometry.test.ts`) unaffected, passes.
- [x] `openspec validate --strict` passes.
