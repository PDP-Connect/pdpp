// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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
} from "@opendatalabs/remote-surface/client";
import { createViewportWriters, shouldPostViewport } from "./stream-viewport-writer.ts";

test("buildViewportPayload keeps viewport dimensions in CSS pixels and sends DPR separately", () => {
  assert.deepEqual(
    buildViewportPayload({
      deviceScaleFactor: 3,
      hasTouch: true,
      height: 844.8,
      mobile: true,
      screenHeight: 1920.8,
      screenWidth: 1080.2,
      userAgent: "Mobile Safari",
      width: 390.9,
    }),
    {
      deviceScaleFactor: 3,
      hasTouch: true,
      height: 844,
      mobile: true,
      screenHeight: 1920,
      screenWidth: 1080,
      userAgent: "Mobile Safari",
      width: 390,
    }
  );
});

test("buildViewportPayload clamps invalid dimensions and deviceScaleFactor", () => {
  assert.deepEqual(
    buildViewportPayload({
      deviceScaleFactor: 0,
      hasTouch: false,
      height: Number.NaN,
      mobile: false,
      userAgent: "x".repeat(600),
      width: 0,
    }),
    {
      deviceScaleFactor: 1,
      hasTouch: false,
      height: 1,
      mobile: false,
      userAgent: "x".repeat(512),
      width: 1,
    }
  );
});

test("viewportsAreEquivalent tolerates subpixel observer jitter", () => {
  assert.equal(viewportsAreEquivalent({ height: 844, width: 390 }, { height: 843, width: 391 }), true);
  assert.equal(viewportsAreEquivalent({ height: 844, width: 390 }, { height: 844, width: 394 }), false);
});

test("viewportPayloadsAreEquivalent includes capture size and DPR", () => {
  const base = buildViewportPayload({
    deviceScaleFactor: 3,
    hasTouch: true,
    height: 844,
    mobile: true,
    screenHeight: 1920,
    screenWidth: 1080,
    userAgent: "Mobile Safari",
    width: 390,
  });
  assert.equal(
    viewportPayloadsAreEquivalent(base, { ...base, height: 843, screenHeight: 1919, screenWidth: 1081, width: 391 }),
    true
  );
  assert.equal(viewportPayloadsAreEquivalent(base, { ...base, screenWidth: 960 }), false);
  assert.equal(viewportPayloadsAreEquivalent(base, { ...base, deviceScaleFactor: 2 }), false);
});

test("shouldPostViewport changes only when the payload changes materially", () => {
  const viewport = buildViewportPayload({
    deviceScaleFactor: 1,
    hasTouch: true,
    height: 390,
    mobile: true,
    screenHeight: 390,
    screenWidth: 844,
    userAgent: "Mobile Safari",
    width: 844,
  });

  assert.equal(shouldPostViewport(null, viewport), true);
  assert.equal(shouldPostViewport(viewport, { ...viewport, height: 389, width: 845 }), false);
  assert.equal(shouldPostViewport(viewport, { ...viewport, screenWidth: 960 }), true);
});

test("PDPP postViewport and viewer applyViewport share one injected transport post", () => {
  const viewport = buildViewportPayload({
    deviceScaleFactor: 1,
    hasTouch: true,
    height: 390,
    mobile: true,
    screenHeight: 390,
    screenWidth: 844,
    userAgent: "Mobile Safari",
    width: 844,
  });
  const lastPostState: { current: ReturnType<typeof buildViewportPayload> | null } = { current: null };
  const transportCalls: ReturnType<typeof buildViewportPayload>[] = [];
  const { applyViewport, postViewport } = createViewportWriters({
    lastPostState,
    prepareTransport: ({ viewport: next }) => ({
      onEquivalent: () => {
        // The integration assertion only needs to observe the shared transport.
      },
      post: () => transportCalls.push(next),
    }),
    readViewport: (width, height) => ({
      ...viewport,
      height,
      screenHeight: height,
      screenWidth: width,
      width,
    }),
  });

  assert.equal(postViewport(viewport.width, viewport.height, {}), true);
  assert.equal(applyViewport(viewport, {}), false);

  assert.deepEqual(transportCalls, [viewport], "one physical viewport change produces one transport post");
});

test("isMobileKeyboardViewportResize identifies same-width mobile keyboard occlusion", () => {
  assert.equal(
    isMobileKeyboardViewportResize({
      next: { height: 560, mobile: true, width: 390 },
      previous: { height: 844, mobile: true, width: 390 },
    }),
    true
  );
});

test("isMobileKeyboardViewportResize does not require a focused local input for keyboard-shaped mobile drops", () => {
  assert.equal(
    isMobileKeyboardViewportResize({
      hasLocalTextInputFocus: false,
      next: { height: 590, mobile: true, width: 430 },
      nextLocal: { height: 932, visualHeight: 590, visualWidth: 430, width: 430 },
      previous: { height: 932, mobile: true, width: 430 },
      previousLocal: { height: 932, visualHeight: 932, visualWidth: 430, width: 430 },
    }),
    true
  );
});

test("isMobileKeyboardViewportResize does not hide orientation or desktop resizes", () => {
  assert.equal(
    isMobileKeyboardViewportResize({
      next: { height: 390, mobile: true, width: 844 },
      previous: { height: 844, mobile: true, width: 390 },
    }),
    false
  );
  assert.equal(
    isMobileKeyboardViewportResize({
      next: { height: 600, mobile: false, width: 1280 },
      previous: { height: 800, mobile: false, width: 1280 },
    }),
    false
  );
  assert.equal(
    isMobileKeyboardViewportResize({
      next: { height: 800, mobile: true, width: 390 },
      previous: { height: 844, mobile: true, width: 390 },
    }),
    false
  );
  assert.equal(
    isMobileKeyboardViewportResize({
      next: { height: 250, mobile: true, width: 390 },
      previous: { height: 844, mobile: true, width: 390 },
    }),
    false
  );
});

test("assessMobileKeyboardViewportResize suppresses keyboard animation until the viewport restores", () => {
  const opened = assessMobileKeyboardViewportResize({
    next: { height: 600, mobile: true, width: 390 },
    previous: { height: 844, mobile: true, width: 390 },
    state: createMobileKeyboardResizeState(),
  });
  assert.equal(opened.suppress, true);
  assert.equal(opened.state.mode, "keyboard");

  const animating = assessMobileKeyboardViewportResize({
    next: { height: 570, mobile: true, width: 390 },
    previous: { height: 844, mobile: true, width: 390 },
    state: opened.state,
  });
  assert.equal(animating.suppress, true);
  assert.equal(animating.state.mode, "keyboard");

  const restored = assessMobileKeyboardViewportResize({
    next: { height: 842, mobile: true, width: 390 },
    previous: { height: 844, mobile: true, width: 390 },
    state: animating.state,
  });
  assert.equal(restored.suppress, false);
  assert.equal(restored.state.mode, "stable");
});

test("containedStreamRect removes horizontal letterbox bands for object-contain images", () => {
  assert.deepEqual(containedStreamRect({ height: 500, left: 0, top: 0, width: 1000 }, { height: 800, width: 400 }), {
    height: 500,
    left: 375,
    top: 0,
    width: 250,
  });
});

test("pointToStreamViewport maps clicks through horizontal letterboxing", () => {
  const mapped = pointToStreamViewport(
    { clientX: 500, clientY: 250 },
    {
      containerBox: { height: 500, left: 0, top: 0, width: 1000 },
      imageBox: { height: 500, left: 0, top: 0, width: 1000 },
      viewport: { height: 800, width: 400 },
    }
  );

  assert.deepEqual(mapped, { x: 200, y: 400 });
  assert.equal(
    pointToStreamViewport(
      { clientX: 100, clientY: 250 },
      {
        containerBox: { height: 500, left: 0, top: 0, width: 1000 },
        imageBox: { height: 500, left: 0, top: 0, width: 1000 },
        viewport: { height: 800, width: 400 },
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
        containerBox: { height: 1000, left: 0, top: 0, width: 400 },
        imageBox: { height: 1000, left: 0, top: 0, width: 400 },
        viewport: { height: 400, width: 800 },
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
        containerBox: { height: 200, left: 10, top: 20, width: 300 },
      }
    ),
    { x: 30, y: 50 }
  );
});
