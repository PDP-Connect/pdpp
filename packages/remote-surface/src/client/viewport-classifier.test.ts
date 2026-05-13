import assert from "node:assert/strict";
import test from "node:test";
import { classifyViewportTransition, type ViewportObservation } from "./viewport-classifier.ts";

function observation(overrides: Partial<ViewportObservation> = {}): ViewportObservation {
  return {
    editableFocused: false,
    layout: { width: 390, height: 844 },
    mobile: true,
    visual: {
      width: 390,
      height: 844,
      offsetLeft: 0,
      offsetTop: 0,
      pageLeft: 0,
      pageTop: 0,
      scale: 1,
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
        width: 390,
        height: 560,
        offsetLeft: 0,
        offsetTop: 0,
        pageLeft: 0,
        pageTop: 0,
        scale: 1,
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
      layout: { width: 390, height: 560 },
      visual: {
        width: 390,
        height: 560,
        offsetLeft: 0,
        offsetTop: 0,
        pageLeft: 0,
        pageTop: 0,
        scale: 1,
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
      layout: { width: 390, height: 841 },
      visual: {
        width: 390,
        height: 800,
        offsetLeft: 0,
        offsetTop: 44,
        pageLeft: 0,
        pageTop: 44,
        scale: 1,
      },
    })
  );

  assert.equal(result.kind, "browser-chrome");
  assert.equal(result.remoteResize, "hold");
});

test("classifies same-width mobile dynamic viewport height churn as browser chrome", () => {
  const result = classifyViewportTransition(
    observation({
      layout: { width: 448, height: 819 },
      visual: { width: 448, height: 819, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1 },
    }),
    observation({
      layout: { width: 448, height: 891 },
      visual: { width: 448, height: 891, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1 },
    })
  );

  assert.equal(result.kind, "browser-chrome");
  assert.equal(result.remoteResize, "hold");
});

test("classifies viewport authority so layout and orientation resize while occlusion holds", () => {
  assert.equal(classifyViewportTransition(null, observation()).remoteResize, "post");
  assert.equal(
    classifyViewportTransition(
      observation({ layout: { width: 900, height: 600 }, mobile: false }),
      observation({ layout: { width: 960, height: 600 }, mobile: false })
    ).kind,
    "layout-resize"
  );
  assert.equal(
    classifyViewportTransition(
      observation({ orientation: { angle: 0, type: "portrait-primary" } }),
      observation({
        layout: { width: 844, height: 390 },
        orientation: { angle: 90, type: "landscape-primary" },
        visual: { width: 844, height: 390, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1 },
      })
    ).remoteResize,
    "post"
  );
  assert.equal(
    classifyViewportTransition(
      observation(),
      observation({
        editableFocused: true,
        visual: { width: 390, height: 560, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1 },
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
        width: 390,
        height: 844,
        offsetLeft: 0,
        offsetTop: 0,
        pageLeft: 0,
        pageTop: 0,
        scale: 1,
      },
    }),
    observation({
      editableFocused: true,
      visual: {
        width: 390,
        height: 780,
        offsetLeft: 0,
        offsetTop: 0,
        pageLeft: 0,
        pageTop: 0,
        scale: 1,
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
      layout: { width: 844, height: 390 },
      orientation: { angle: 90, type: "landscape-primary" },
      visual: {
        width: 844,
        height: 390,
        offsetLeft: 0,
        offsetTop: 0,
        pageLeft: 0,
        pageTop: 0,
        scale: 1,
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
        width: 300,
        height: 650,
        offsetLeft: 0,
        offsetTop: 0,
        pageLeft: 0,
        pageTop: 0,
        scale: 1.3,
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
        width: 300,
        height: 650,
        offsetLeft: 0,
        offsetTop: 0,
        pageLeft: 0,
        pageTop: 0,
        scale: 1.3,
      },
    }),
    observation({
      editableFocused: true,
      visual: {
        width: 300,
        height: 430,
        offsetLeft: 0,
        offsetTop: 0,
        pageLeft: 0,
        pageTop: 0,
        scale: 1.3,
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
      virtualKeyboard: { x: 0, y: 540, width: 390, height: 304 },
    })
  );

  assert.equal(result.kind, "keyboard-occlusion");
  assert.equal(result.keyboardInsetBottom, 304);
  assert.equal(result.remoteResize, "hold");
});
