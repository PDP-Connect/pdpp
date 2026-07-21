/**
 * Phase-6 slice 1 acceptance instrument (remote-surface spec
 * docs/architecture/planes.md §6 VIEWPORT/GEOMETRY):
 *
 *   "Given a known container size and a known remote viewport, assert a
 *    pointer event at a known on-screen pixel maps to the expected remote
 *    coordinate through the library's own projection — then, separately,
 *    assert the host's rendered pointer-target ... is bit-identical to the
 *    library's projection. ... a geometry test that only exercises the
 *    library in isolation does not catch [re-derivation drift]."
 *
 * This file imports BOTH the console's own geometry glue
 * (`stream-viewer-geometry.ts`, the module `stream-viewer.tsx` actually
 * calls) and the library's exports directly, and asserts bit-identical
 * output for the same inputs. It is not a test of the library in isolation:
 * every assertion here would fail if a future edit reintroduced local
 * container-fit / scale / letterbox / projection math into the console
 * instead of calling the library.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildViewportPayload,
  containedStreamRect,
  pointToStreamViewport,
  viewportCaptureSize,
} from "@opendatalabs/remote-surface/client";
import { computeStreamCaptureTargetForContext } from "@opendatalabs/remote-surface/diagnostics";
import {
  mapPointerToStreamViewport,
  NEKO_NATIVE_VIEWPORT_OPTIONS,
  readViewerViewport,
  viewportLayoutFromInfo,
} from "./stream-viewer-geometry.ts";

interface WindowStubOptions {
  coarse?: boolean;
  dpr: number;
  height: number;
  ua?: string;
  width: number;
}

function stubWindow({ coarse = false, dpr, height, ua = "Mozilla/5.0 (Macintosh)", width }: WindowStubOptions): void {
  (globalThis as unknown as { window: unknown }).window = {
    devicePixelRatio: dpr,
    innerHeight: height,
    innerWidth: width,
    matchMedia: () => ({ matches: coarse }),
    navigator: { maxTouchPoints: coarse ? 5 : 0, userAgent: ua },
  };
}

function clearWindowStub(): void {
  // biome-ignore lint/performance/noDelete: test-only global cleanup, not a hot path.
  delete (globalThis as unknown as { window?: unknown }).window;
}

test.afterEach(() => {
  clearWindowStub();
});

// ─── Pointer-target projection parity ────────────────────────────────────────
// mapPointerToStreamViewport (stream-viewer-geometry.ts) is what every pointer
// dispatch and debug-payload site in stream-viewer.tsx calls. It MUST be a
// transparent forward to pointToStreamViewport with no math of its own.

test("parity: aspect-fit (one-to-one) container matches the library's own projection", () => {
  const containerBox = { height: 800, left: 0, top: 0, width: 400 };
  const imageBox = { height: 800, left: 0, top: 0, width: 400 };
  const viewport = { height: 800, width: 400 };
  const event = { clientX: 100, clientY: 200 };

  const viaConsole = mapPointerToStreamViewport({
    containerBox: containerBox as DOMRect,
    event,
    imageBox: imageBox as DOMRect,
    viewport,
  });
  const viaLibrary = pointToStreamViewport(event, { containerBox, imageBox, viewport });

  assert.deepEqual(viaConsole, viaLibrary);
  assert.deepEqual(viaConsole, { x: 100, y: 200 });
});

test("parity: horizontal letterbox (pillarbox) bars match the library's own projection", () => {
  // Wide container (1000x500), tall/narrow remote viewport (400x800) — bars on the sides.
  const containerBox = { height: 500, left: 0, top: 0, width: 1000 };
  const imageBox = containedStreamRect(containerBox, { height: 800, width: 400 });
  const viewport = { height: 800, width: 400 };
  const event = { clientX: 500, clientY: 250 };

  const viaConsole = mapPointerToStreamViewport({
    containerBox: containerBox as DOMRect,
    event,
    imageBox: imageBox as DOMRect,
    viewport,
  });
  const viaLibrary = pointToStreamViewport(event, { containerBox, imageBox, viewport });

  assert.deepEqual(viaConsole, viaLibrary);
  assert.deepEqual(viaConsole, { x: 200, y: 400 });

  // A point that lands in the side letterbox bar (outside the contained image) must
  // resolve to null on both sides identically — not silently clamp on one side only.
  const barPoint = { clientX: 100, clientY: 250 };
  assert.deepEqual(
    mapPointerToStreamViewport({
      containerBox: containerBox as DOMRect,
      event: barPoint,
      imageBox: imageBox as DOMRect,
      viewport,
    }),
    pointToStreamViewport(barPoint, { containerBox, imageBox, viewport })
  );
});

test("parity: vertical letterbox (top/bottom bars) match the library's own projection", () => {
  // Tall container (400x1000), wide remote viewport (800x400) — bars on top/bottom.
  const containerBox = { height: 1000, left: 0, top: 0, width: 400 };
  const imageBox = containedStreamRect(containerBox, { height: 400, width: 800 });
  const viewport = { height: 400, width: 800 };
  const event = { clientX: 200, clientY: 500 };

  const viaConsole = mapPointerToStreamViewport({
    containerBox: containerBox as DOMRect,
    event,
    imageBox: imageBox as DOMRect,
    viewport,
  });
  const viaLibrary = pointToStreamViewport(event, { containerBox, imageBox, viewport });

  assert.deepEqual(viaConsole, viaLibrary);
  assert.deepEqual(viaConsole, { x: 400, y: 200 });
});

test("parity: sub-pixel container sizes match the library's own projection", () => {
  const containerBox = { height: 843.6, left: 12.25, top: 4.75, width: 390.4 };
  const imageBox = containedStreamRect(containerBox, { height: 812, width: 375 });
  const viewport = { height: 812, width: 375 };
  const event = { clientX: 200.3, clientY: 400.9 };

  const viaConsole = mapPointerToStreamViewport({
    containerBox: containerBox as DOMRect,
    event,
    imageBox: imageBox as DOMRect,
    viewport,
  });
  const viaLibrary = pointToStreamViewport(event, { containerBox, imageBox, viewport });

  assert.deepEqual(viaConsole, viaLibrary);
});

test("parity: rotation (portrait -> landscape) container matches the library's own projection", () => {
  const portraitContainer = { height: 844, left: 0, top: 0, width: 390 };
  const portraitViewport = { height: 844, width: 390 };
  const portraitImage = containedStreamRect(portraitContainer, portraitViewport);
  const portraitEvent = { clientX: 195, clientY: 422 };

  const portraitConsole = mapPointerToStreamViewport({
    containerBox: portraitContainer as DOMRect,
    event: portraitEvent,
    imageBox: portraitImage as DOMRect,
    viewport: portraitViewport,
  });
  const portraitLibrary = pointToStreamViewport(portraitEvent, {
    containerBox: portraitContainer,
    imageBox: portraitImage,
    viewport: portraitViewport,
  });
  assert.deepEqual(portraitConsole, portraitLibrary);
  assert.deepEqual(portraitConsole, { x: 195, y: 422 });

  // Post-rotation: container and viewport both transpose (this is the settled,
  // post-transition state — §6's hold-during-transition obligation is a
  // separate, already-covered concern in stream-viewport-classifier.test.ts).
  const landscapeContainer = { height: 390, left: 0, top: 0, width: 844 };
  const landscapeViewport = { height: 390, width: 844 };
  const landscapeImage = containedStreamRect(landscapeContainer, landscapeViewport);
  const landscapeEvent = { clientX: 422, clientY: 195 };

  const landscapeConsole = mapPointerToStreamViewport({
    containerBox: landscapeContainer as DOMRect,
    event: landscapeEvent,
    imageBox: landscapeImage as DOMRect,
    viewport: landscapeViewport,
  });
  const landscapeLibrary = pointToStreamViewport(landscapeEvent, {
    containerBox: landscapeContainer,
    imageBox: landscapeImage,
    viewport: landscapeViewport,
  });
  assert.deepEqual(landscapeConsole, landscapeLibrary);
  assert.deepEqual(landscapeConsole, { x: 422, y: 195 });
});

// ─── viewportLayoutFromInfo parity (n.eko layout POST shape) ─────────────────

test("parity: viewportLayoutFromInfo's capture size is bit-identical to the library's viewportCaptureSize", () => {
  const cases = [
    { height: 844, width: 390 },
    { deviceScaleFactor: 2, height: 844, screenHeight: 1688, screenWidth: 780, width: 390 },
    { deviceScaleFactor: 3, height: 390, screenHeight: 1170, screenWidth: 2532, width: 844 },
  ];
  for (const viewport of cases) {
    const layout = viewportLayoutFromInfo(viewport);
    const capture = viewportCaptureSize(viewport);
    assert.deepEqual(
      { screenHeight: layout.screenHeight, screenWidth: layout.screenWidth },
      { screenHeight: capture.height, screenWidth: capture.width }
    );
    assert.deepEqual(
      { viewportHeight: layout.viewportHeight, viewportWidth: layout.viewportWidth },
      { viewportHeight: viewport.height, viewportWidth: viewport.width }
    );
  }
});

// ─── readViewerViewport parity across device-pixel-ratio 1/2/3 ──────────────
// readViewerViewport is the sole console-side constructor of a ViewportPayload
// for the mint request / resize reconciliation. It MUST forward straight to
// buildViewportPayload + computeStreamCaptureTargetForContext with no
// independent scale math (no re-derived screenWidth/screenHeight formula).

for (const dpr of [1, 2, 3]) {
  test(`parity: readViewerViewport at devicePixelRatio=${dpr} matches building the payload directly from the library`, () => {
    const width = 390;
    const height = 844;
    stubWindow({ dpr, height, width });

    const viaConsole = readViewerViewport(width, height);

    const captureTarget = computeStreamCaptureTargetForContext({
      devicePixelRatio: dpr,
      highDprCapture: false,
      viewport: { height, width },
    });
    const viaLibrary = buildViewportPayload({
      deviceScaleFactor: dpr,
      hasTouch: false,
      height,
      mobile: false,
      screenHeight: captureTarget.height,
      screenWidth: captureTarget.width,
      userAgent: "Mozilla/5.0 (Macintosh)",
      width,
    });

    assert.deepEqual(viaConsole, viaLibrary);
  });
}

test("parity: readViewerViewport with NEKO_NATIVE_VIEWPORT_OPTIONS forces deviceScaleFactor=1 and disables high-DPR capture, matching the library directly", () => {
  const width = 390;
  const height = 844;
  // Real device DPR is 3, but the n.eko-native viewport options should force
  // the library call to CSS-pixel (DPR 1, no high-DPR capture) — this is the
  // "n.eko follow-up viewport posts use native one-to-one coordinates"
  // behavior asserted at the source-shape level in
  // stream-viewer-keyboard.test.ts; this test proves the VALUE, not just the
  // source shape.
  stubWindow({ dpr: 3, height, width });

  const viaConsole = readViewerViewport(width, height, NEKO_NATIVE_VIEWPORT_OPTIONS);

  const captureTarget = computeStreamCaptureTargetForContext({
    devicePixelRatio: NEKO_NATIVE_VIEWPORT_OPTIONS.deviceScaleFactor ?? 1,
    highDprCapture: NEKO_NATIVE_VIEWPORT_OPTIONS.highDprCapture ?? false,
    viewport: { height, width },
  });
  const viaLibrary = buildViewportPayload({
    deviceScaleFactor: NEKO_NATIVE_VIEWPORT_OPTIONS.deviceScaleFactor ?? 1,
    hasTouch: false,
    height,
    mobile: false,
    screenHeight: captureTarget.height,
    screenWidth: captureTarget.width,
    userAgent: "Mozilla/5.0 (Macintosh)",
    width,
  });

  assert.deepEqual(viaConsole, viaLibrary);
  assert.equal(viaConsole?.deviceScaleFactor, 1);
});
