import assert from "node:assert/strict";
import test from "node:test";
import {
  assessMobileKeyboardViewportResize,
  buildViewportPayload,
  containedStreamRect,
  createMobileKeyboardResizeState,
  isMobileKeyboardViewportResize,
  pointToStreamViewport,
  viewportPayloadsAreEquivalent,
  viewportsAreEquivalent,
} from "./stream-geometry.ts";

test("buildViewportPayload keeps viewport dimensions in CSS pixels and sends DPR separately", () => {
  assert.deepEqual(
    buildViewportPayload({
      width: 390.9,
      height: 844.8,
      deviceScaleFactor: 3,
      hasTouch: true,
      mobile: true,
      screenWidth: 1080.2,
      screenHeight: 1920.8,
      userAgent: "Mobile Safari",
    }),
    {
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      hasTouch: true,
      mobile: true,
      screenWidth: 1080,
      screenHeight: 1920,
      userAgent: "Mobile Safari",
    }
  );
});

test("buildViewportPayload clamps invalid dimensions and deviceScaleFactor", () => {
  assert.deepEqual(
    buildViewportPayload({
      width: 0,
      height: Number.NaN,
      deviceScaleFactor: 0,
      hasTouch: false,
      mobile: false,
      userAgent: "x".repeat(600),
    }),
    {
      width: 1,
      height: 1,
      deviceScaleFactor: 1,
      hasTouch: false,
      mobile: false,
      userAgent: "x".repeat(512),
    }
  );
});

test("viewportsAreEquivalent tolerates subpixel observer jitter", () => {
  assert.equal(viewportsAreEquivalent({ width: 390, height: 844 }, { width: 391, height: 843 }), true);
  assert.equal(viewportsAreEquivalent({ width: 390, height: 844 }, { width: 394, height: 844 }), false);
});

test("viewportPayloadsAreEquivalent includes capture size and DPR", () => {
  const base = buildViewportPayload({
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    hasTouch: true,
    mobile: true,
    screenWidth: 1080,
    screenHeight: 1920,
    userAgent: "Mobile Safari",
  });
  assert.equal(
    viewportPayloadsAreEquivalent(base, { ...base, width: 391, height: 843, screenWidth: 1081, screenHeight: 1919 }),
    true
  );
  assert.equal(viewportPayloadsAreEquivalent(base, { ...base, screenWidth: 960 }), false);
  assert.equal(viewportPayloadsAreEquivalent(base, { ...base, deviceScaleFactor: 2 }), false);
});

test("isMobileKeyboardViewportResize identifies same-width mobile keyboard occlusion", () => {
  assert.equal(
    isMobileKeyboardViewportResize({
      previous: { width: 390, height: 844, mobile: true },
      next: { width: 390, height: 560, mobile: true },
    }),
    true
  );
});

test("isMobileKeyboardViewportResize does not require a focused local input for keyboard-shaped mobile drops", () => {
  assert.equal(
    isMobileKeyboardViewportResize({
      hasLocalTextInputFocus: false,
      previous: { width: 430, height: 932, mobile: true },
      next: { width: 430, height: 590, mobile: true },
      previousLocal: { width: 430, height: 932, visualHeight: 932, visualWidth: 430 },
      nextLocal: { width: 430, height: 932, visualHeight: 590, visualWidth: 430 },
    }),
    true
  );
});

test("isMobileKeyboardViewportResize does not hide orientation or desktop resizes", () => {
  assert.equal(
    isMobileKeyboardViewportResize({
      previous: { width: 390, height: 844, mobile: true },
      next: { width: 844, height: 390, mobile: true },
    }),
    false
  );
  assert.equal(
    isMobileKeyboardViewportResize({
      previous: { width: 1280, height: 800, mobile: false },
      next: { width: 1280, height: 600, mobile: false },
    }),
    false
  );
  assert.equal(
    isMobileKeyboardViewportResize({
      previous: { width: 390, height: 844, mobile: true },
      next: { width: 390, height: 800, mobile: true },
    }),
    false
  );
  assert.equal(
    isMobileKeyboardViewportResize({
      previous: { width: 390, height: 844, mobile: true },
      next: { width: 390, height: 250, mobile: true },
    }),
    false
  );
});

test("assessMobileKeyboardViewportResize suppresses keyboard animation until the viewport restores", () => {
  const opened = assessMobileKeyboardViewportResize({
    previous: { width: 390, height: 844, mobile: true },
    next: { width: 390, height: 600, mobile: true },
    state: createMobileKeyboardResizeState(),
  });
  assert.equal(opened.suppress, true);
  assert.equal(opened.state.mode, "keyboard");

  const animating = assessMobileKeyboardViewportResize({
    previous: { width: 390, height: 844, mobile: true },
    next: { width: 390, height: 570, mobile: true },
    state: opened.state,
  });
  assert.equal(animating.suppress, true);
  assert.equal(animating.state.mode, "keyboard");

  const restored = assessMobileKeyboardViewportResize({
    previous: { width: 390, height: 844, mobile: true },
    next: { width: 390, height: 842, mobile: true },
    state: animating.state,
  });
  assert.equal(restored.suppress, false);
  assert.equal(restored.state.mode, "stable");
});

test("containedStreamRect removes horizontal letterbox bands for object-contain images", () => {
  assert.deepEqual(containedStreamRect({ left: 0, top: 0, width: 1000, height: 500 }, { width: 400, height: 800 }), {
    left: 375,
    top: 0,
    width: 250,
    height: 500,
  });
});

test("pointToStreamViewport maps clicks through horizontal letterboxing", () => {
  const mapped = pointToStreamViewport(
    { clientX: 500, clientY: 250 },
    {
      containerBox: { left: 0, top: 0, width: 1000, height: 500 },
      imageBox: { left: 0, top: 0, width: 1000, height: 500 },
      viewport: { width: 400, height: 800 },
    }
  );

  assert.deepEqual(mapped, { x: 200, y: 400 });
  assert.equal(
    pointToStreamViewport(
      { clientX: 100, clientY: 250 },
      {
        containerBox: { left: 0, top: 0, width: 1000, height: 500 },
        imageBox: { left: 0, top: 0, width: 1000, height: 500 },
        viewport: { width: 400, height: 800 },
      }
    ),
    null
  );
});

test("pointToStreamViewport maps clicks through vertical letterboxing", () => {
  assert.deepEqual(
    pointToStreamViewport(
      { clientX: 200, clientY: 500 },
      {
        containerBox: { left: 0, top: 0, width: 400, height: 1000 },
        imageBox: { left: 0, top: 0, width: 400, height: 1000 },
        viewport: { width: 800, height: 400 },
      }
    ),
    { x: 400, y: 200 }
  );
});

test("pointToStreamViewport falls back to container-local coordinates before a frame is available", () => {
  assert.deepEqual(
    pointToStreamViewport(
      { clientX: 40, clientY: 70 },
      {
        containerBox: { left: 10, top: 20, width: 300, height: 200 },
      }
    ),
    { x: 30, y: 50 }
  );
});
