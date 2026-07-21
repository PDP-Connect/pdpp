/**
 * A backend/session transition (e.g. n.eko's `backend_ready`) can request an
 * immediate viewport measurement. `backend_ready` fires on EVERY SSE `/events`
 * GET — the first attach AND every same-session reconnect (EventSource's
 * internal auto-retry after a transport blip; see
 * `reference-implementation/server/streaming/routes.js` — `backend_ready` is
 * written unconditionally after `companion.start`, which is itself a no-op on
 * an already-started companion). On a reconnect, `<NekoSurface
 * key={browserSessionId}>` does NOT remount — its container is already
 * attached and stable, so a ref callback will never fire again for it. A gate
 * that unconditionally defers would queue a request that is never drained.
 *
 * On a genuine identity change (a NEW browserSessionId — first attach, or a
 * different browser session replacing the old one), the outgoing surface's
 * container is still attached at the instant the transition is decided —
 * measuring it immediately would echo the OUTGOING surface's box (e.g. a
 * placeholder's letterboxed frame) back as the viewport for the INCOMING
 * surface. That case must defer until the new surface's own container
 * attaches.
 *
 * So: if the requested key already matches the currently-attached surface
 * (a reconnect echo), measuring right now is safe — that container IS the
 * one the request describes, not an outgoing one. Only a genuine identity
 * change needs to defer, and then only the attach carrying that exact new
 * key may drain it.
 */
export interface SurfaceMeasureGateState {
  /** The key of the surface whose container is currently attached, if known. */
  attachedKey: string | null;
  pending: { source: string; surfaceKey: string } | null;
}

export function createSurfaceMeasureGateState(): SurfaceMeasureGateState {
  return { attachedKey: null, pending: null };
}

export interface SurfaceMeasureRequestResult {
  /** Non-null when `surfaceKey` already matches the attached surface: measure NOW, synchronously. */
  measureSourceNow: string | null;
  state: SurfaceMeasureGateState;
}

/**
 * Request a measurement for `surfaceKey`. Returns `measureSourceNow` when the
 * requested key already matches the currently-attached surface (reconnect
 * echo, or any repeat request for the surface already on screen) — the
 * caller should measure immediately, synchronously, in that case. Otherwise
 * the request is queued (replacing any prior pending request outright — a
 * superseded request is dropped, never carried forward to drain against a
 * later, unrelated attach) and `drainSurfaceMeasureOnAttach` will fire it
 * once the matching new surface attaches.
 */
export function requestSurfaceMeasure(
  state: SurfaceMeasureGateState,
  source: string,
  surfaceKey: string
): SurfaceMeasureRequestResult {
  if (state.attachedKey === surfaceKey) {
    return { measureSourceNow: source, state: { ...state, pending: null } };
  }
  return { measureSourceNow: null, state: { ...state, pending: { source, surfaceKey } } };
}

export interface SurfaceAttachResult {
  /** The source to measure now, or null if nothing matched. */
  measureSource: string | null;
  state: SurfaceMeasureGateState;
}

/**
 * Call when a surface container node attaches (ref callback receives a
 * non-null node), naming which surface just attached via `surfaceKey`.
 * Always records `surfaceKey` as the currently-attached surface (so a
 * subsequent `requestSurfaceMeasure` for the same key measures immediately
 * rather than deferring). Drains a pending request ONLY when its
 * `surfaceKey` matches this attach — an attach from a different, unrelated
 * surface leaves the pending request untouched. Draining never happens on
 * detach (`node` null): an outgoing surface's unmount cannot consume a
 * request meant for the incoming one, and does not change `attachedKey`
 * (there is a brief window between an outgoing surface's unmount and the
 * incoming surface's mount where neither is "the" attached surface; treating
 * the last-known attached key as still current during that window is safe
 * because nothing can measure through a detached container anyway).
 */
export function drainSurfaceMeasureOnAttach(
  state: SurfaceMeasureGateState,
  node: unknown,
  surfaceKey: string
): SurfaceAttachResult {
  if (!node) {
    return { measureSource: null, state };
  }
  const attachedKey = surfaceKey;
  if (state.pending && state.pending.surfaceKey === surfaceKey) {
    return { measureSource: state.pending.source, state: { attachedKey, pending: null } };
  }
  return { measureSource: null, state: { ...state, attachedKey } };
}

/**
 * Stateful coordinator wrapping the pure gate above. This is the ONLY object
 * `stream-viewer.tsx` is meant to call for a neko backend/session
 * transition's measurement request and the corresponding surface-attach
 * event — it owns the gate state internally AND is the sole caller of the
 * injected `measure` side effect, so there is exactly one call site for this
 * concern rather than two call sites (a `backend_ready` handler and a ref
 * callback) that each have to independently thread gate state and remember
 * to call `measure` correctly. A stray, uncoordinated call to the same
 * underlying measurement function elsewhere in the component (bypassing this
 * object) is exactly the "eager double-wire" regression class this exists to
 * make impossible to reintroduce silently — see the production-shaped tests
 * in `stream-surface-measure-gate.test.ts`, which construct a coordinator
 * exactly as `stream-viewer.tsx` does and assert on the injected `measure`
 * spy's exact call sequence.
 */
export interface StreamSurfaceMeasureCoordinator {
  /** Ref callback target: call with the attaching node and its surface key. */
  attachSurface(node: unknown, surfaceKey: string): void;
  /** Call from the backend_ready handler with the target browserSessionId. */
  requestBackendReady(surfaceKey: string): void;
}

export function createStreamSurfaceMeasureCoordinator(
  measure: (source: string) => void
): StreamSurfaceMeasureCoordinator {
  let state = createSurfaceMeasureGateState();
  return {
    requestBackendReady(surfaceKey: string): void {
      const result = requestSurfaceMeasure(state, "neko-backend-ready", surfaceKey);
      state = result.state;
      if (result.measureSourceNow) {
        measure(`${result.measureSourceNow}+reconnect-current-surface`);
      }
    },
    attachSurface(node: unknown, surfaceKey: string): void {
      const result = drainSurfaceMeasureOnAttach(state, node, surfaceKey);
      state = result.state;
      if (result.measureSource) {
        measure(`${result.measureSource}+surface-attached`);
      }
    },
  };
}
