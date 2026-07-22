// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { classifyViewportTransition, type ViewportObservation } from "@opendatalabs/remote-surface/client";

function observation(overrides: Partial<ViewportObservation> = {}): ViewportObservation {
  return {
    editableFocused: false,
    layout: { height: 844, width: 390 },
    mobile: true,
    visual: {
      height: 844,
      offsetLeft: 0,
      offsetTop: 0,
      pageLeft: 0,
      pageTop: 0,
      scale: 1,
      width: 390,
    },
    ...overrides,
  };
}

test("classifies modern mobile visual-viewport keyboard occlusion without remote resize", () => {
  const result = classifyViewportTransition(
    observation(),
    observation({
      editableFocused: true,
      visual: {
        height: 560,
        offsetLeft: 0,
        offsetTop: 0,
        pageLeft: 0,
        pageTop: 0,
        scale: 1,
        width: 390,
      },
    })
  );

  assert.equal(result.kind, "keyboard-occlusion");
  assert.equal(result.remoteResize, "hold");
  assert.equal(result.keyboardInsetBottom, 284);
});

test("classifies resizes-content keyboard occlusion without remote resize", () => {
  const result = classifyViewportTransition(
    observation(),
    observation({
      editableFocused: true,
      layout: { height: 560, width: 390 },
      visual: {
        height: 560,
        offsetLeft: 0,
        offsetTop: 0,
        pageLeft: 0,
        pageTop: 0,
        scale: 1,
        width: 390,
      },
    })
  );

  assert.equal(result.kind, "keyboard-occlusion");
  assert.equal(result.remoteResize, "hold");
});

test("classifies browser chrome visual-viewport changes separately from keyboard", () => {
  const result = classifyViewportTransition(
    observation(),
    observation({
      layout: { height: 841, width: 390 },
      visual: {
        height: 800,
        offsetLeft: 0,
        offsetTop: 44,
        pageLeft: 0,
        pageTop: 44,
        scale: 1,
        width: 390,
      },
    })
  );

  assert.equal(result.kind, "browser-chrome");
  assert.equal(result.remoteResize, "hold");
});

test("classifies same-width mobile dynamic viewport height churn as browser chrome", () => {
  const result = classifyViewportTransition(
    observation({
      layout: { height: 819, width: 448 },
      visual: { height: 819, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1, width: 448 },
    }),
    observation({
      layout: { height: 891, width: 448 },
      visual: { height: 891, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1, width: 448 },
    })
  );

  assert.equal(result.kind, "browser-chrome");
  assert.equal(result.remoteResize, "hold");
});

test("classifies viewport authority so layout and orientation resize while occlusion holds", () => {
  assert.equal(classifyViewportTransition(null, observation()).remoteResize, "post");
  assert.equal(
    classifyViewportTransition(
      observation({ layout: { height: 600, width: 900 }, mobile: false }),
      observation({ layout: { height: 600, width: 960 }, mobile: false })
    ).kind,
    "layout-resize"
  );
  assert.equal(
    classifyViewportTransition(
      observation({ orientation: { angle: 0, type: "portrait-primary" } }),
      observation({
        layout: { height: 390, width: 844 },
        orientation: { angle: 90, type: "landscape-primary" },
        visual: { height: 390, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1, width: 844 },
      })
    ).remoteResize,
    "post"
  );
  assert.equal(
    classifyViewportTransition(
      observation(),
      observation({
        editableFocused: true,
        visual: { height: 560, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1, width: 390 },
      })
    ).remoteResize,
    "hold"
  );
});

test("holds remote resize during multi-step keyboard animation", () => {
  const result = classifyViewportTransition(
    observation({
      editableFocused: true,
      visual: {
        height: 844,
        offsetLeft: 0,
        offsetTop: 0,
        pageLeft: 0,
        pageTop: 0,
        scale: 1,
        width: 390,
      },
    }),
    observation({
      editableFocused: true,
      visual: {
        height: 780,
        offsetLeft: 0,
        offsetTop: 0,
        pageLeft: 0,
        pageTop: 0,
        scale: 1,
        width: 390,
      },
    })
  );

  assert.equal(result.kind, "keyboard-occlusion");
  assert.equal(result.remoteResize, "hold");
});

test("classifies orientation as a remote resize candidate", () => {
  const result = classifyViewportTransition(
    observation({
      orientation: { angle: 0, type: "portrait-primary" },
    }),
    observation({
      layout: { height: 390, width: 844 },
      orientation: { angle: 90, type: "landscape-primary" },
      visual: {
        height: 390,
        offsetLeft: 0,
        offsetTop: 0,
        pageLeft: 0,
        pageTop: 0,
        scale: 1,
        width: 844,
      },
    })
  );

  assert.equal(result.kind, "orientation-change");
  assert.equal(result.remoteResize, "post");
});

test("classifies pinch zoom as local-only", () => {
  const result = classifyViewportTransition(
    observation(),
    observation({
      visual: {
        height: 650,
        offsetLeft: 0,
        offsetTop: 0,
        pageLeft: 0,
        pageTop: 0,
        scale: 1.3,
        width: 300,
      },
    })
  );

  assert.equal(result.kind, "zoom");
  assert.equal(result.remoteResize, "hold");
});

test("classifies keyboard before zoom when both signals are present", () => {
  const result = classifyViewportTransition(
    observation({
      visual: {
        height: 650,
        offsetLeft: 0,
        offsetTop: 0,
        pageLeft: 0,
        pageTop: 0,
        scale: 1.3,
        width: 300,
      },
    }),
    observation({
      editableFocused: true,
      visual: {
        height: 430,
        offsetLeft: 0,
        offsetTop: 0,
        pageLeft: 0,
        pageTop: 0,
        scale: 1.3,
        width: 300,
      },
    })
  );

  assert.equal(result.kind, "keyboard-occlusion");
  assert.equal(result.remoteResize, "hold");
});

test("uses VirtualKeyboard geometry when available", () => {
  const result = classifyViewportTransition(
    observation(),
    observation({
      editableFocused: false,
      virtualKeyboard: { height: 304, width: 390, x: 0, y: 540 },
    })
  );

  assert.equal(result.kind, "keyboard-occlusion");
  assert.equal(result.keyboardInsetBottom, 304);
  assert.equal(result.remoteResize, "hold");
});
