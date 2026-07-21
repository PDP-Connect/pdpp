import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createStreamSurfaceMeasureCoordinator,
  createSurfaceMeasureGateState,
  drainSurfaceMeasureOnAttach,
  requestSurfaceMeasure,
} from "./stream-surface-measure-gate.ts";

const VIEWER_FILE = fileURLToPath(new URL("./stream-viewer.tsx", import.meta.url));
const SESSION_A = "bs_mrtc6sad_mh73zp";
const SESSION_B = "bs_mrtc8tpr_zn2syt";

// ─── Pure reducer: state-machine value (kept — cheap, exhaustive on the
// reducer's own contract; the production-shaped tests below are the actual
// regression oracle, not these). ────────────────────────────────────────────

test("pure gate: a fresh state defers the first request for any key (nothing attached yet)", () => {
  const state = createSurfaceMeasureGateState();
  const result = requestSurfaceMeasure(state, "neko-backend-ready", SESSION_A);

  assert.equal(result.measureSourceNow, null);
  assert.deepEqual(result.state, {
    attachedKey: null,
    pending: { source: "neko-backend-ready", surfaceKey: SESSION_A },
  });
});

test("pure gate: an attach for a DIFFERENT key never drains a pending request queued for another key", () => {
  const state = requestSurfaceMeasure(createSurfaceMeasureGateState(), "neko-backend-ready", SESSION_B).state;

  const wrongKeyAttach = drainSurfaceMeasureOnAttach(state, { tag: "node" }, SESSION_A);
  assert.equal(wrongKeyAttach.measureSource, null);
  assert.deepEqual(wrongKeyAttach.state.pending, state.pending);

  const rightKeyAttach = drainSurfaceMeasureOnAttach(wrongKeyAttach.state, { tag: "node" }, SESSION_B);
  assert.equal(rightKeyAttach.measureSource, "neko-backend-ready");
});

test("pure gate: a superseding request for a new key discards the prior one fail-closed", () => {
  let state = createSurfaceMeasureGateState();
  state = requestSurfaceMeasure(state, "neko-backend-ready", SESSION_A).state;
  state = requestSurfaceMeasure(state, "neko-backend-ready", SESSION_B).state;

  const staleAttach = drainSurfaceMeasureOnAttach(state, { tag: "node" }, SESSION_A);
  assert.equal(staleAttach.measureSource, null);

  const currentAttach = drainSurfaceMeasureOnAttach(staleAttach.state, { tag: "node" }, SESSION_B);
  assert.equal(currentAttach.measureSource, "neko-backend-ready");
});

// ─── Production-shaped oracle: drives the REAL `createStreamSurfaceMeasureCoordinator`
// factory — the same function `stream-viewer.tsx` constructs one instance of via
// `useRef(createStreamSurfaceMeasureCoordinator(...))` and calls exclusively for
// the neko backend_ready/attach path (verified by the wiring-exclusivity guard
// below). This is a real object with real methods and an injected spy; it is
// not a hand-rolled reimplementation of the sequence under test. ─────────────

interface FakeBox {
  height: number;
  width: number;
}

interface MeasureCall {
  node: FakeBox;
  source: string;
}

/**
 * Mirrors the exact two production call sites: `attachSurface` is what
 * `setStreamSurfaceNode`'s ref callback calls with whatever node is
 * currently attached; `requestBackendReady` is what the `backend_ready`
 * handler calls. `currentNode` stands in for `containerRef.current` at
 * measurement time — the coordinator's `measure` callback (injected here,
 * exactly as `stream-viewer.tsx` injects `requestViewportMeasureRef.current`)
 * reads whatever `currentNode` is AT CALL TIME, so a measurement taken
 * before the correct node has attached genuinely observes the wrong box —
 * proving the coordinator's timing, not just its state transitions.
 */
function harness() {
  const calls: MeasureCall[] = [];
  let currentNode: FakeBox | null = null;
  const coordinator = createStreamSurfaceMeasureCoordinator((source) => {
    if (currentNode) {
      calls.push({ node: currentNode, source });
    }
  });
  return {
    calls,
    coordinator,
    attach(node: FakeBox, surfaceKey: string) {
      currentNode = node;
      coordinator.attachSurface(node, surfaceKey);
    },
    detach(surfaceKey: string) {
      currentNode = null;
      coordinator.attachSurface(null, surfaceKey);
    },
    backendReady(surfaceKey: string) {
      coordinator.requestBackendReady(surfaceKey);
    },
  };
}

test("production-shaped: desktop attach never posts the outgoing CDP placeholder's box", () => {
  // Exact sequence required: CDP placeholder (448x916) is attached and
  // current. backend_ready arrives for a NEW browser session B. Zero
  // measurements must happen before B's own node attaches. B's node
  // (1400x1005) attaches: exactly one measurement, of B's box.
  const h = harness();
  const cdpPlaceholder: FakeBox = { width: 448, height: 916 };
  const desktopStage: FakeBox = { width: 1400, height: 1005 };

  h.attach(cdpPlaceholder, "cdp");
  assert.deepEqual(h.calls, [], "attaching the initial CDP surface must not itself trigger a measurement");

  h.backendReady(SESSION_B);
  assert.deepEqual(h.calls, [], "backend_ready for a NEW session must defer — zero measurements before B attaches");

  h.detach("cdp");
  assert.deepEqual(h.calls, [], "the outgoing surface's detach must not trigger or drain a measurement");

  h.attach(desktopStage, SESSION_B);
  assert.notDeepEqual(desktopStage, cdpPlaceholder, "sanity: the two fixture boxes must actually differ");
  assert.deepEqual(
    h.calls,
    [{ node: desktopStage, source: "neko-backend-ready+surface-attached" }],
    "exactly one measurement must fire, on B's own attach, reading B's box — never the outgoing placeholder's"
  );
});

test("production-shaped: same-session backend_ready replay measures immediately, exactly once, with nothing left pending", () => {
  const h = harness();
  const desktopStage: FakeBox = { width: 1400, height: 1005 };

  h.attach(desktopStage, SESSION_B);
  h.calls.length = 0; // clear the initial-attach noise (nothing was pending, so this was a no-op measurement count anyway)

  // Reconnect: backend_ready replays for the SAME, still-attached session.
  h.backendReady(SESSION_B);
  assert.deepEqual(
    h.calls,
    [{ node: desktopStage, source: "neko-backend-ready+reconnect-current-surface" }],
    "a reconnect echo must measure immediately, exactly once, against the currently-attached box"
  );

  // No later, unrelated attach should fire again from this alone.
  h.calls.length = 0;
  h.attach(desktopStage, SESSION_B);
  assert.deepEqual(
    h.calls,
    [],
    "nothing was pending after the reconnect echo — a same-key re-attach must not double-fire"
  );
});

test("production-shaped: wrong-key attach does not drain a pending cross-session request", () => {
  const h = harness();
  const cdpPlaceholder: FakeBox = { width: 448, height: 916 };
  const desktopStage: FakeBox = { width: 1400, height: 1005 };

  h.attach(cdpPlaceholder, "cdp");
  h.backendReady(SESSION_B);

  // An unrelated attach for a DIFFERENT key (e.g. a straggling remount of
  // session A while B is still pending) must not consume B's request.
  h.attach(cdpPlaceholder, SESSION_A);
  assert.deepEqual(
    h.calls,
    [],
    "an attach for a different key must not drain a pending request queued for another key"
  );

  h.attach(desktopStage, SESSION_B);
  assert.deepEqual(
    h.calls,
    [{ node: desktopStage, source: "neko-backend-ready+surface-attached" }],
    "only the matching key's attach drains the request"
  );
});

test("production-shaped: a superseding backend_ready for a new session discards the prior one fail-closed", () => {
  const h = harness();
  const cdpPlaceholder: FakeBox = { width: 448, height: 916 };
  const staleDesktopA: FakeBox = { width: 1280, height: 900 };
  const desktopB: FakeBox = { width: 1400, height: 1005 };

  h.attach(cdpPlaceholder, "cdp");
  h.backendReady(SESSION_A);
  h.backendReady(SESSION_B); // supersedes A before A's surface ever attached

  // A's straggling attach (a discarded transition's remount) must not
  // resurrect A's discarded request.
  h.attach(staleDesktopA, SESSION_A);
  assert.deepEqual(h.calls, [], "a superseded session's own attach must not fire a measurement");

  h.attach(desktopB, SESSION_B);
  assert.deepEqual(
    h.calls,
    [{ node: desktopB, source: "neko-backend-ready+surface-attached" }],
    "only the superseding session's attach drains"
  );
});

test("production-shaped: same-session mobile rotation (same key) measures the rotated box immediately, not deferred", () => {
  const h = harness();
  const phonePortrait: FakeBox = { width: 390, height: 844 };
  const phoneLandscape: FakeBox = { width: 844, height: 390 };

  h.attach(phonePortrait, SESSION_A);
  h.calls.length = 0;

  // Rotation within the SAME browser session (no new browser_session_id) —
  // the surface's container is still attached, just resized. A resize is
  // reported through the ResizeObserver path in production, not
  // backend_ready — but if backend_ready DID replay mid-rotation (e.g. a
  // reconnect racing a rotation), it must still resolve against whatever is
  // currently attached, immediately, matching the reconnect-echo behavior.
  h.attach(phoneLandscape, SESSION_A); // container resized in place, same key
  h.backendReady(SESSION_A);
  assert.deepEqual(
    h.calls,
    [{ node: phoneLandscape, source: "neko-backend-ready+reconnect-current-surface" }],
    "a same-key backend_ready during/after rotation measures the rotated box immediately, not the pre-rotation one"
  );
});

// ─── Wiring-exclusivity guard: a narrow COMPLEMENT to the behavioral oracles
// above, not a substitute for them. Confirms the neko backend_ready branch
// has exactly one measurement call site (the coordinator) and never calls
// `requestViewportMeasureRef`/`measureAndPost` directly — which the
// behavioral tests above cannot see, because they exercise the extracted
// coordinator in isolation and would not notice a SECOND, independent call
// added elsewhere in stream-viewer.tsx. ──────────────────────────────────────

test("wiring guard: the neko backend_ready branch has exactly one measurement call site — the coordinator", async () => {
  // Complement to the production-shaped behavioral oracles above, not a
  // substitute: those exercise the extracted coordinator in isolation and
  // cannot see a SECOND, independent call added elsewhere in the
  // backend_ready handler (an accidental double-wire that retains the
  // correct coordinator call alongside a stray direct one). This asserts,
  // within the handler's own bounded source block, that
  // `requestViewportMeasureRef` is never called directly and the
  // coordinator is invoked exactly once.
  const src = await readFile(VIEWER_FILE, "utf8");
  const brStart = src.indexOf('source.addEventListener("backend_ready"');
  const brEnd = src.indexOf('source.addEventListener("frame"', brStart);
  assert.notEqual(brStart, -1, "the backend_ready listener must be present");
  assert.notEqual(brEnd, -1, "the backend_ready listener has a bounded source block");
  const backendReadyBlock = src.slice(brStart, brEnd);

  const directMeasureCalls = (backendReadyBlock.match(/requestViewportMeasureRef\.current\?\.\(/g) ?? []).length;
  assert.equal(
    directMeasureCalls,
    0,
    "the backend_ready handler must never call requestViewportMeasureRef directly — only through requestNekoSurfaceMeasure"
  );

  const coordinatorCalls = (backendReadyBlock.match(/requestNekoSurfaceMeasure\(browserSessionId\)/g) ?? []).length;
  assert.equal(coordinatorCalls, 1, "the neko branch must route through the coordinator exactly once");

  const coordinatorConstruction = src.includes(
    "createStreamSurfaceMeasureCoordinator((source) => requestViewportMeasureRef.current?.(source))"
  );
  assert.ok(
    coordinatorConstruction,
    "the coordinator must be constructed with requestViewportMeasureRef as its measure sink"
  );
});
