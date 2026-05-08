import assert from "node:assert/strict";
import test from "node:test";

import {
  buildNekoClientProps,
  isNekoTouchPointInsideRect,
  isNekoTouchScrollIntent,
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

test("n.eko mobile scroll bridge is scoped to coarse landscape without native touch", () => {
  assert.equal(
    shouldUseNekoTouchScrollBridge({ coarsePointer: true, landscape: true, nativeTouchSupported: false }),
    true
  );
  assert.equal(
    shouldUseNekoTouchScrollBridge({ coarsePointer: true, landscape: true, nativeTouchSupported: null }),
    true
  );
  assert.equal(
    shouldUseNekoTouchScrollBridge({ coarsePointer: true, landscape: true, nativeTouchSupported: true }),
    false
  );
  assert.equal(
    shouldUseNekoTouchScrollBridge({ coarsePointer: false, landscape: true, nativeTouchSupported: false }),
    false
  );
  assert.equal(
    shouldUseNekoTouchScrollBridge({ coarsePointer: true, landscape: false, nativeTouchSupported: false }),
    false
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
