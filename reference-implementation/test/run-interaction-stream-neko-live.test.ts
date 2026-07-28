// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  createNekoCompanion,
  type NekoCompanion,
  type NekoCompanionOptions,
  type NekoFrame,
} from "../server/streaming/neko-adapter.ts";

const LIVE_ENABLED = process.env.PDPP_TEST_LIVE_NEKO === "1";
const NEKO_ORIGIN = process.env.PDPP_TEST_LIVE_NEKO_ORIGIN || process.env.NEKO_ORIGIN;

function liveNekoCompanionOptions(): NekoCompanionOptions {
  return {
    env: process.env,
    ...(NEKO_ORIGIN ? { origin: NEKO_ORIGIN } : {}),
    pollIntervalMs: 100,
  };
}

function firstNekoFrame(
  companion: NekoCompanion,
  timeoutMs: number
): { cancel: () => void; promise: Promise<NekoFrame | null> } {
  let cancel: (() => void) | null = null;
  const promise = new Promise<NekoFrame | null>((resolve) => {
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    const settle = (frame: NekoFrame | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      unsubscribe?.();
      resolve(frame);
    };
    const timeout = setTimeout(() => settle(null), timeoutMs);
    const registeredUnsubscribe = companion.onFrame((frame) => settle(frame));
    unsubscribe = registeredUnsubscribe;
    if (settled) {
      registeredUnsubscribe();
    }
    cancel = (): void => settle(null);
  });
  return {
    cancel: () => {
      cancel?.();
    },
    promise,
  };
}

test("live n.eko smoke emits a screenshot frame", {
  skip: LIVE_ENABLED && NEKO_ORIGIN ? false : "set PDPP_TEST_LIVE_NEKO=1 and NEKO_ORIGIN to run",
}, async () => {
  const companion = createNekoCompanion(liveNekoCompanionOptions());
  const frameWaiter = firstNekoFrame(companion, 10_000);

  try {
    await companion.start({ height: 720, width: 1280 });
    const frame = await frameWaiter.promise;
    assert.ok(frame, "expected n.eko screenshot frame");
    assert.equal(typeof frame.data, "string");
    assert.ok(frame.data.length > 0);
  } finally {
    frameWaiter.cancel();
    await companion.stop();
  }
});

test("live n.eko mobile viewport smoke emits a mobile-shaped screenshot frame", {
  skip: LIVE_ENABLED && NEKO_ORIGIN ? false : "set PDPP_TEST_LIVE_NEKO=1 and NEKO_ORIGIN to run",
}, async () => {
  const companion = createNekoCompanion(liveNekoCompanionOptions());
  const frameWaiter = firstNekoFrame(companion, 10_000);

  try {
    await companion.start({
      deviceScaleFactor: 2,
      hasTouch: true,
      height: 844,
      mobile: true,
      screenHeight: 844,
      screenWidth: 390,
      width: 390,
    });
    const frame = await frameWaiter.promise;
    assert.ok(frame, "expected n.eko mobile screenshot frame");
    assert.equal(typeof frame.data, "string");
    assert.ok(frame.data.length > 0);
    assert.equal(frame.metadata.device_width, 390);
    assert.equal(frame.metadata.device_height, 844);
    assert.equal(frame.metadata.page_scale_factor, 2);
  } finally {
    frameWaiter.cancel();
    await companion.stop();
  }
});
