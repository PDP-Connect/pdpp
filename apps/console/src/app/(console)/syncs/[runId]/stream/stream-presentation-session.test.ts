// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { beginPresentationSession, type PresentationSessionState } from "./stream-presentation-session.ts";

interface Viewport {
  height: number;
  width: number;
}

const phonePortrait = { height: 844, width: 390 };
const desktopFrame = { height: 813, width: 1440 };

function state(overrides: Partial<PresentationSessionState<Viewport>> = {}): PresentationSessionState<Viewport> {
  return {
    browserSessionId: "phone-session",
    localSurfaceViewport: phonePortrait,
    presentationViewport: phonePortrait,
    stablePresentationViewport: phonePortrait,
    ...overrides,
  };
}

test("a desktop browser session cannot inherit a stale phone presentation viewport", () => {
  const attached = beginPresentationSession(state(), "desktop-session");

  assert.equal(attached.reset, true);
  assert.deepEqual(attached.state, {
    browserSessionId: "desktop-session",
    localSurfaceViewport: null,
    presentationViewport: null,
    stablePresentationViewport: null,
  });

  const settledDesktop = {
    ...attached.state,
    localSurfaceViewport: desktopFrame,
    presentationViewport: desktopFrame,
    stablePresentationViewport: desktopFrame,
  };
  assert.deepEqual(settledDesktop.presentationViewport, desktopFrame);
});

test("a transport reconnect to the same browser session preserves settled presentation geometry", () => {
  const previous = state({
    browserSessionId: "desktop-session",
    localSurfaceViewport: desktopFrame,
    presentationViewport: desktopFrame,
    stablePresentationViewport: desktopFrame,
  });
  const attached = beginPresentationSession(previous, "desktop-session");

  assert.equal(attached.reset, false);
  assert.equal(attached.state, previous);
});
