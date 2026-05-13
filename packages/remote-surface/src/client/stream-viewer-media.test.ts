import assert from "node:assert/strict";
import test from "node:test";
import {
  nekoMediaSettleTarget,
  nekoMediaSettleTargetsMatch,
  streamViewportInfosMatch,
  toNekoNativeViewportInfo,
  viewportInfoFromPayload,
} from "./stream-viewer-media.ts";

test("viewportInfoFromPayload preserves wire viewport fields", () => {
  assert.deepEqual(
    viewportInfoFromPayload({
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      hasTouch: true,
      mobile: true,
      screenWidth: 780,
      screenHeight: 1688,
      userAgent: "test",
    }),
    { width: 390, height: 844, deviceScaleFactor: 2, screenWidth: 780, screenHeight: 1688 }
  );
});

test("toNekoNativeViewportInfo converts capture dimensions to native n.eko viewport", () => {
  assert.deepEqual(toNekoNativeViewportInfo({ width: 390, height: 844, deviceScaleFactor: 2 }), {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    screenWidth: 390,
    screenHeight: 844,
  });
  assert.equal(toNekoNativeViewportInfo(null), null);
});

test("streamViewportInfosMatch compares CSS and capture sizes with rounding tolerance", () => {
  assert.equal(
    streamViewportInfosMatch(
      { width: 390, height: 844, screenWidth: 780, screenHeight: 1688 },
      { width: 391, height: 843, screenWidth: 781, screenHeight: 1687 }
    ),
    true
  );
  assert.equal(
    streamViewportInfosMatch(
      { width: 390, height: 844, screenWidth: 780, screenHeight: 1688 },
      { width: 390, height: 844, screenWidth: 800, screenHeight: 1688 }
    ),
    false
  );
});

test("nekoMediaSettleTargetsMatch includes status path and device scale tolerance", () => {
  const base = nekoMediaSettleTarget(
    { statusPath: "/status" },
    { width: 390, height: 844, screenWidth: 780, screenHeight: 1688, deviceScaleFactor: 2 }
  );
  assert.equal(
    nekoMediaSettleTargetsMatch(base, {
      statusPath: "/status",
      viewport: { width: 390, height: 844, screenWidth: 780, screenHeight: 1688, deviceScaleFactor: 2.005 },
    }),
    true
  );
  assert.equal(nekoMediaSettleTargetsMatch(base, { ...base, statusPath: "/other" }), false);
  assert.equal(nekoMediaSettleTargetsMatch(base, { ...base, viewport: { ...base.viewport, deviceScaleFactor: 2.02 } }), false);
});
