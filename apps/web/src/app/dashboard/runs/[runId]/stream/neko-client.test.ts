import assert from "node:assert/strict";
import test from "node:test";

import {
  buildNekoClientProps,
  isNekoTouchPointInsideRect,
  isNekoTouchScrollIntent,
  nekoTouchScrollStepsToControlDelta,
  type NekoViewportLayout,
  selectNekoMediaDisplayForLayout,
  selectNekoMediaSizeForLayout,
  selectNekoScreenStateSizeForLayout,
  shouldUseNekoTouchScrollBridge,
  takeNekoTouchScrollSteps,
} from "./neko-client.ts";

const PORTRAIT_LAYOUT: NekoViewportLayout = {
  screenHeight: 915,
  screenWidth: 496,
  viewportHeight: 867,
  viewportWidth: 448,
};

test("n.eko layout ignores stale landscape media dimensions during portrait rotation", () => {
  const selected = selectNekoMediaSizeForLayout(PORTRAIT_LAYOUT, {
    height: 540,
    width: 960,
  });

  assert.equal(selected.source, "screen");
  assert.equal(selected.intrinsicCompatibility, "orientation-mismatch");
  assert.equal(selected.width, PORTRAIT_LAYOUT.screenWidth);
  assert.equal(selected.height, PORTRAIT_LAYOUT.screenHeight);
});

test("n.eko display crops stale-orientation media during rotation settling", () => {
  const selected = selectNekoMediaDisplayForLayout(PORTRAIT_LAYOUT, {
    height: 540,
    width: 960,
  });

  assert.equal(selected.fit, "cover");
  assert.equal(selected.settling, true);
  assert.equal(selected.source, "intrinsic");
  assert.equal(selected.intrinsicCompatibility, "orientation-mismatch");
  assert.equal(selected.width, 960);
  assert.equal(selected.height, 540);
});

test("n.eko display follows actual media when the requested screen aspect was not applied", () => {
  const selected = selectNekoMediaDisplayForLayout(
    {
      screenHeight: 1288,
      screenWidth: 1288,
      viewportHeight: 1123,
      viewportWidth: 1117,
    },
    {
      height: 1024,
      width: 1280,
    }
  );

  assert.equal(selected.fit, "cover");
  assert.equal(selected.settling, true);
  assert.equal(selected.source, "intrinsic");
  assert.equal(selected.intrinsicCompatibility, "aspect-mismatch");
  assert.equal(selected.width, 1280);
  assert.equal(selected.height, 1024);
});

test("n.eko presentation-only layout preserves current screen state when media is not ready", () => {
  const selected = selectNekoScreenStateSizeForLayout(
    PORTRAIT_LAYOUT,
    null,
    {
      height: 540,
      width: 960,
    },
    false
  );

  assert.equal(selected.source, "current");
  assert.equal(selected.width, 960);
  assert.equal(selected.height, 540);
});

test("n.eko screen state follows visible stale media during rotation settling", () => {
  const selected = selectNekoScreenStateSizeForLayout(
    PORTRAIT_LAYOUT,
    {
      height: 540,
      width: 960,
    },
    {
      height: 540,
      width: 960,
    },
    true
  );

  assert.equal(selected.source, "intrinsic");
  assert.equal(selected.width, 960);
  assert.equal(selected.height, 540);
});

test("n.eko screen state follows actual media for an unapplied requested screen aspect", () => {
  const selected = selectNekoScreenStateSizeForLayout(
    {
      screenHeight: 1288,
      screenWidth: 1288,
      viewportHeight: 1123,
      viewportWidth: 1117,
    },
    {
      height: 1024,
      width: 1280,
    },
    {
      height: 1024,
      width: 1280,
    },
    true
  );

  assert.equal(selected.source, "intrinsic");
  assert.equal(selected.width, 1280);
  assert.equal(selected.height, 1024);
});

test("n.eko layout keeps compatible media dimensions for steady-state streams", () => {
  const selected = selectNekoMediaSizeForLayout(PORTRAIT_LAYOUT, {
    height: 900,
    width: 490,
  });

  assert.equal(selected.source, "intrinsic");
  assert.equal(selected.intrinsicCompatibility, "dimension-compatible");
  assert.equal(selected.width, 490);
  assert.equal(selected.height, 900);
});

test("n.eko display covers the viewport for steady-state streams", () => {
  const selected = selectNekoMediaDisplayForLayout(PORTRAIT_LAYOUT, {
    height: 900,
    width: 490,
  });

  assert.equal(selected.fit, "cover");
  assert.equal(selected.settling, false);
  assert.equal(selected.source, "intrinsic");
  assert.equal(selected.intrinsicCompatibility, "dimension-compatible");
});

test("n.eko client props suppress n.eko cursor drawing without disabling input", () => {
  const props = buildNekoClientProps();

  assert.equal(props.autoplay, true);
  assert.equal(props.inputMode, "touch");
  assert.equal(typeof props.cursorDrawFunction, "function");
  assert.equal(typeof props.inactiveCursorDrawFunction, "function");
  assert.doesNotThrow(() => props.cursorDrawFunction(null));
  assert.doesNotThrow(() => props.inactiveCursorDrawFunction(null));
});

test("n.eko mobile scroll bridge defers to native n.eko touch when available", () => {
  // The fallback bridge is only useful in landscape on coarse-pointer
  // devices where n.eko has not advertised native touch. In every other
  // combination — portrait, fine pointer, native touch supported — we
  // must defer to n.eko, because the bridge eagerly cancels touchstart
  // and breaks long-press selection / focus / native click synthesis.
  assert.equal(
    shouldUseNekoTouchScrollBridge({ coarsePointer: true, landscape: true, nativeTouchSupported: false }),
    true,
    "coarse landscape with no native touch: fallback engaged"
  );
  assert.equal(
    shouldUseNekoTouchScrollBridge({ coarsePointer: true, landscape: true, nativeTouchSupported: null }),
    true,
    "coarse landscape with unknown native-touch state: fallback engaged"
  );
  assert.equal(
    shouldUseNekoTouchScrollBridge({ coarsePointer: true, landscape: true, nativeTouchSupported: true }),
    false,
    "coarse landscape WITH native touch: defer to n.eko"
  );
  assert.equal(
    shouldUseNekoTouchScrollBridge({ coarsePointer: false, landscape: true, nativeTouchSupported: false }),
    false,
    "fine pointer (desktop) landscape: defer to n.eko"
  );
  assert.equal(
    shouldUseNekoTouchScrollBridge({ coarsePointer: true, landscape: false, nativeTouchSupported: false }),
    false,
    "coarse PORTRAIT with no native touch: defer to n.eko (the bridge would " +
      "double-deliver clicks and break long-press selection)"
  );
  assert.equal(
    shouldUseNekoTouchScrollBridge({ coarsePointer: true, landscape: false, nativeTouchSupported: null }),
    false,
    "coarse portrait with unknown native-touch state: defer to n.eko"
  );
});

test("n.eko touch scroll intent prefers vertical drags and preserves taps", () => {
  assert.equal(isNekoTouchScrollIntent({ startX: 20, startY: 20, currentX: 22, currentY: 26 }), false);
  assert.equal(isNekoTouchScrollIntent({ startX: 20, startY: 20, currentX: 24, currentY: 56 }), true);
  assert.equal(isNekoTouchScrollIntent({ startX: 20, startY: 20, currentX: 70, currentY: 44 }), false);
});

test("n.eko touch scroll bridge can recover parent-targeted touches by coordinates", () => {
  const rect = { bottom: 300, left: 100, right: 500, top: 50 };
  assert.equal(isNekoTouchPointInsideRect({ clientX: 100, clientY: 50, rect }), true);
  assert.equal(isNekoTouchPointInsideRect({ clientX: 500, clientY: 300, rect }), true);
  assert.equal(isNekoTouchPointInsideRect({ clientX: 99, clientY: 200, rect }), false);
  assert.equal(isNekoTouchPointInsideRect({ clientX: 200, clientY: 301, rect }), false);
});

test("n.eko touch scroll steps preserve fractional movement between frames", () => {
  assert.deepEqual(takeNekoTouchScrollSteps(49, 50), { steps: 0, remainderPx: 49 });
  assert.deepEqual(takeNekoTouchScrollSteps(125, 50), { steps: 2, remainderPx: 25 });
  assert.deepEqual(takeNekoTouchScrollSteps(-125, 50), { steps: -2, remainderPx: -25 });
});

test("n.eko native touch path does not schedule a delayed PDPP tap (no double-delivery)", async () => {
  // Prevents the "click registers twice" Brave-Android regression: when
  // n.eko has already delivered a native click for the touch, PDPP must
  // NOT also synthesize a `control.buttonDown/buttonUp` 120ms later. The
  // bridge is allowed to *observe* the native tap for telemetry, but the
  // actual click delivery stays on the native path.
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const here = fileURLToPath(new URL(".", import.meta.url));
  const src = await readFile(`${here}neko-client.ts`, "utf8");
  // The previous double-delivery code looked like:
  //   window.setTimeout(() => { ...; clickNekoAtPoint(clientX, clientY); }, 120);
  assert.doesNotMatch(
    src,
    /window\.setTimeout\([^)]*clickNekoAtPoint/,
    "no setTimeout-scheduled clickNekoAtPoint call (would double-deliver after n.eko's native click)"
  );
  assert.doesNotMatch(
    src,
    /native_tap_assist/,
    "no native_tap_assist telemetry event (the assist path itself is gone)"
  );
  // We DO still want a passive observation event so future regressions of
  // n.eko's native-click path are visible in telemetry.
  assert.match(
    src,
    /native_tap_observed/,
    "native taps are observed in telemetry without being double-delivered"
  );
});

test("n.eko getNekoControlPos prefers n.eko-authoritative coordinate basis (no PDPP CSS-viewport remap)", async () => {
  // The PDPP-derived `currentNekoControlCoordinateSize` (CSS viewport dims)
  // must NOT be used as a coordinate divisor in `getNekoControlPos`. The
  // remote browser's coordinate system is screen pixels (set by
  // `Emulation.setDeviceMetricsOverride.screenWidth/Height`); using CSS-
  // viewport dims as the divisor lands clicks on the wrong (X, Y) on the
  // remote — the "tapped here, click went somewhere else" wrong-targeting
  // signature reported on Brave Android.
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const here = fileURLToPath(new URL(".", import.meta.url));
  const src = await readFile(`${here}neko-client.ts`, "utf8");
  // Locate the body of getNekoControlPos and assert it does not use the
  // CSS-viewport divisor as a primary mapping path.
  const fn = src.split("function getNekoControlPos(")[1]?.split("\nfunction ")[0] ?? "";
  assert.doesNotMatch(
    fn,
    /controlCoordinateSize\.width\s*\/\s*rect\.width/,
    "getNekoControlPos must not divide by controlCoordinateSize (CSS-derived) as a mapping basis"
  );
  // The first preference must be n.eko's own getMousePos.
  assert.match(
    fn,
    /nekoInstance\?\._overlay\?\.getMousePos/,
    "getNekoControlPos prefers n.eko-authoritative getMousePos as first mapping"
  );
});

test("n.eko containerRect override skips height-only deltas (keyboard / visualViewport churn)", async () => {
  // The override exists to bridge a real embedded-dialog width mismatch.
  // Soft-keyboard activation only changes the height of the local
  // container (visualViewport reports innerHeight smaller); applying that
  // height to layout.viewportHeight while the remote page is still
  // rendered for the full pre-keyboard height produces cover-crop
  // (rect.left=-N) or a bottom whitespace strip (gutters.bottom>>0).
  // The override must therefore gate on a width delta and emit a
  // diagnostic event when it skips a height-only delta.
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const here = fileURLToPath(new URL(".", import.meta.url));
  const src = await readFile(`${here}neko-client.ts`, "utf8");
  assert.match(
    src,
    /NEKO_CONTAINER_OVERRIDE_MIN_WIDTH_DELTA_PX\s*=\s*\d+/,
    "container-rect override has an explicit minimum-width-delta gate"
  );
  assert.match(
    src,
    /container_rect_override\.skipped[\s\S]{0,200}height-only-delta/,
    "skipped overrides emit a diagnostic event with reason=height-only-delta"
  );
});

test("n.eko touch scroll control delta inverts to match DOM wheel direction", () => {
  assert.equal(nekoTouchScrollStepsToControlDelta(2), -1);
  assert.equal(nekoTouchScrollStepsToControlDelta(-2), 1);
  assert.equal(nekoTouchScrollStepsToControlDelta(0), 0);
});
