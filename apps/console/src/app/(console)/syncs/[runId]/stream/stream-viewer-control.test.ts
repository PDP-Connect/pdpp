// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
  localSurfaceCanDisplayPresentation,
  nextPresentationKeyboardHoldUntilMs,
  nextPresentationOrientationHoldUntilMs,
  presentationViewportsMatch,
  replayStreamViewerControl,
  type StreamViewerControlEvent,
  shouldDebouncePresentationViewportUpdate,
  shouldHoldPresentationViewportForKeyboard,
  stablePresentationContainerRect,
} from "@opendatalabs/remote-surface/client";

type ViewportObservedEvent = Extract<StreamViewerControlEvent, { type: "viewport.observed" }>;

function viewportEvent({
  height,
  source = "test",
  timestampMs = 0,
  visualHeight = height,
  width,
}: {
  height: number;
  source?: string;
  timestampMs?: number;
  visualHeight?: number;
  width: number;
}): ViewportObservedEvent {
  return {
    observation: {
      editableFocused: false,
      layout: { width, height },
      timestampMs,
      visual: {
        width,
        height: visualHeight,
        offsetLeft: 0,
        offsetTop: 0,
        pageLeft: 0,
        pageTop: 0,
        scale: 1,
      },
    },
    source,
    type: "viewport.observed",
    viewport: {
      width,
      height,
      deviceScaleFactor: 1,
      hasTouch: true,
      mobile: true,
      userAgent: "test",
    },
  };
}

test("replay holds remote resize for keyboard-shaped visual occlusion", () => {
  const opened = viewportEvent({ width: 390, height: 844, source: "initial" });
  const keyboard = viewportEvent({ width: 390, height: 844, visualHeight: 560, source: "visualViewport.resize" });
  keyboard.observation.editableFocused = true;

  const result = replayStreamViewerControl([opened, keyboard]);

  assert.deepEqual(
    result.commands.map((command) => command.type),
    ["viewport.post", "viewport.hold"]
  );
  assert.equal(
    result.commands[1]?.type === "viewport.hold" ? result.commands[1].reason : "",
    "editable-focus-with-keyboard-shaped-occlusion"
  );
});

test("replay holds orientation transients until a stable settled sample", () => {
  const result = replayStreamViewerControl([
    viewportEvent({ width: 390, height: 844, source: "initial", timestampMs: 0 }),
    viewportEvent({ width: 810, height: 390, source: "orientationchange", timestampMs: 10 }),
    viewportEvent({ width: 844, height: 390, source: "orientationchange.settle", timestampMs: 180 }),
    viewportEvent({ width: 844, height: 390, source: "orientationchange.settle", timestampMs: 360 }),
  ]);

  assert.deepEqual(
    result.commands.map((command) => command.type),
    ["viewport.post", "viewport.hold", "viewport.hold", "viewport.post"]
  );
  assert.equal(result.commands[1]?.type === "viewport.hold" ? result.commands[1].reason : "", "orientation-settling");
  assert.equal(result.commands[3]?.type === "viewport.post" ? result.commands[3].viewport.width : 0, 844);
});

test("replay treats non-transposed mobile aspect flips as orientation settling", () => {
  const result = replayStreamViewerControl([
    viewportEvent({ width: 412, height: 915, source: "initial", timestampMs: 0 }),
    viewportEvent({ width: 916, height: 448, source: "ResizeObserver", timestampMs: 20 }),
    viewportEvent({ width: 916, height: 448, source: "ResizeObserver", timestampMs: 360 }),
  ]);

  assert.deepEqual(
    result.commands.map((command) => command.type),
    ["viewport.post", "viewport.hold", "viewport.post"]
  );
  assert.equal(result.commands[1]?.type === "viewport.hold" ? result.commands[1].reason : "", "orientation-settling");
});

test("replay emits media settled after consecutive matching samples", () => {
  const requested = { width: 390, height: 844 };
  const result = replayStreamViewerControl([
    {
      type: "media.sampled",
      sample: {
        requested,
        screen: requested,
        media: requested,
        inbound: { frameWidth: 390, frameHeight: 844, framesDecoded: 1 },
      },
    },
    {
      type: "media.sampled",
      sample: {
        requested,
        screen: requested,
        media: requested,
        inbound: { frameWidth: 390, frameHeight: 844, framesDecoded: 2 },
      },
    },
    {
      type: "media.sampled",
      sample: {
        requested,
        screen: requested,
        media: requested,
        inbound: { frameWidth: 390, frameHeight: 844, framesDecoded: 3 },
      },
    },
  ]);

  assert.deepEqual(result.commands, [{ type: "media.settled" }]);
});

test("presentation viewport updates debounce orientation bursts only", () => {
  const holdUntil = nextPresentationOrientationHoldUntilMs({
    currentHoldUntilMs: 0,
    holdMs: 500,
    nowMs: 1000,
    source: "orientationchange",
  });

  assert.equal(holdUntil, 1500);
  assert.equal(
    shouldDebouncePresentationViewportUpdate({
      nowMs: 1100,
      orientationHoldUntilMs: holdUntil,
      source: "visualViewport.resize",
    }),
    true
  );
  assert.equal(
    shouldDebouncePresentationViewportUpdate({
      nowMs: 1600,
      orientationHoldUntilMs: holdUntil,
      source: "window.resize",
    }),
    false
  );
  assert.equal(
    nextPresentationOrientationHoldUntilMs({
      currentHoldUntilMs: holdUntil,
      holdMs: 500,
      nowMs: 1200,
      source: "orientationchange.settle.350ms",
    }),
    holdUntil
  );
});

test("presentation viewport equality ignores sub-pixel rounding churn", () => {
  assert.equal(presentationViewportsMatch({ width: 390, height: 844 }, { width: 391, height: 843 }), true);
  assert.equal(presentationViewportsMatch({ width: 390, height: 844 }, { width: 393, height: 844 }), false);
});

test("presentation viewport holds mobile keyboard churn without blocking orientation", () => {
  const holdUntil = nextPresentationKeyboardHoldUntilMs({
    currentHoldUntilMs: 0,
    holdMs: 800,
    isKeyboardActive: true,
    nowMs: 1000,
  });

  assert.equal(holdUntil, 1800);
  assert.equal(
    shouldHoldPresentationViewportForKeyboard({
      isMobileViewport: true,
      keyboardActive: true,
      keyboardHoldUntilMs: holdUntil,
      nowMs: 1100,
      source: "window.resize",
    }),
    true
  );
  assert.equal(
    shouldHoldPresentationViewportForKeyboard({
      isMobileViewport: true,
      keyboardActive: false,
      keyboardHoldUntilMs: holdUntil,
      nowMs: 1500,
      source: "visualViewport.resize",
    }),
    true
  );
  assert.equal(
    shouldHoldPresentationViewportForKeyboard({
      isMobileViewport: true,
      keyboardActive: true,
      keyboardHoldUntilMs: holdUntil,
      nowMs: 1500,
      source: "orientationchange",
    }),
    false
  );
  assert.equal(
    shouldHoldPresentationViewportForKeyboard({
      isMobileViewport: false,
      keyboardActive: true,
      keyboardHoldUntilMs: holdUntil,
      nowMs: 1500,
      source: "window.resize",
    }),
    false
  );
});

test("held mobile height-only changes can keep displaying the stable presentation viewport", () => {
  const stable = { width: 448, height: 771, screenWidth: 1008, screenHeight: 1736 };
  const addressBarCollapsed = { width: 448, height: 891, screenWidth: 1008, screenHeight: 2008 };

  assert.equal(localSurfaceCanDisplayPresentation(addressBarCollapsed, stable), true);
  assert.deepEqual(stablePresentationContainerRect({ width: 448, height: 891 }, stable), { width: 448, height: 771 });
});

test("held orientation changes do not display stale presentation viewport as ready", () => {
  const portrait = { width: 448, height: 771, screenWidth: 1008, screenHeight: 1736 };
  const landscape = { width: 947, height: 364, screenWidth: 2128, screenHeight: 816 };

  assert.equal(localSurfaceCanDisplayPresentation(landscape, portrait), false);
  assert.deepEqual(stablePresentationContainerRect({ width: 947, height: 364 }, portrait), { width: 448, height: 771 });
});
