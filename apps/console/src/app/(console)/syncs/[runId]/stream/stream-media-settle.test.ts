// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { assessNekoMediaSettle, createNekoMediaSettleState } from "@opendatalabs/remote-surface/backends/neko";

const requested = { height: 844, width: 390 };

test("requires consecutive matching screen, media, inbound frames, and decoded progress", () => {
  let state = createNekoMediaSettleState();
  const baseline = assessNekoMediaSettle({
    sample: {
      inbound: { frameHeight: 844, framesDecoded: 1, framesPerSecond: 24, frameWidth: 390 },
      media: requested,
      requested,
      screen: requested,
    },
    state,
  });
  assert.equal(baseline.status, "settling");
  assert.deepEqual(baseline.reasons, ["frames_not_progressing"]);
  state = baseline.state;

  const first = assessNekoMediaSettle({
    sample: {
      inbound: { frameHeight: 844, framesDecoded: 4, framesPerSecond: 24, frameWidth: 390 },
      media: requested,
      requested,
      screen: requested,
    },
    state,
  });
  assert.equal(first.status, "settling");
  assert.equal(first.state.consecutiveReadySamples, 1);
  state = first.state;

  const second = assessNekoMediaSettle({
    sample: {
      inbound: { frameHeight: 844, framesDecoded: 8, framesPerSecond: 24, frameWidth: 390 },
      media: requested,
      requested,
      screen: requested,
    },
    state,
  });
  assert.equal(second.status, "settled");
  assert.equal(second.state.consecutiveReadySamples, 2);
});

test("reports why media is still settling", () => {
  const result = assessNekoMediaSettle({
    sample: {
      inbound: { frameHeight: 640, framesDecoded: 0, frameWidth: 320 },
      media: { height: 640, width: 320 },
      requested,
      screen: { height: 844, width: 390 },
    },
    state: createNekoMediaSettleState(),
  });

  assert.equal(result.status, "settling");
  assert.deepEqual(result.reasons, [
    "media_not_covering_requested_viewport",
    "inbound_frame_not_covering_requested_viewport",
  ]);
});

test("marks repeated mismatches as degraded after the sample budget", () => {
  let state = createNekoMediaSettleState();
  let status = "settling";
  let reasons: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    const result = assessNekoMediaSettle({
      maxSettlingSamples: 3,
      sample: {
        inbound: { frameHeight: 640, framesDecoded: index + 1, frameWidth: 320 },
        media: { height: 640, width: 320 },
        requested,
        screen: { height: 640, width: 320 },
      },
      state,
    });
    state = result.state;
    status = result.status;
    reasons = result.reasons;
  }

  assert.equal(status, "degraded");
  assert.deepEqual(reasons, [
    "screen_not_covering_requested_viewport",
    "media_not_covering_requested_viewport",
    "inbound_frame_not_covering_requested_viewport",
  ]);
});

test("keeps desktop fallback media degraded instead of treating it as settled", () => {
  let state = createNekoMediaSettleState();
  let result = assessNekoMediaSettle({
    maxSettlingSamples: 3,
    sample: {
      inbound: { frameHeight: 448, framesDecoded: 10, framesPerSecond: 30, frameWidth: 920 },
      media: { height: 448, width: 920 },
      requested: { height: 856, width: 1603 },
      screen: { height: 448, width: 920 },
    },
    state,
  });
  state = result.state;
  result = assessNekoMediaSettle({
    maxSettlingSamples: 3,
    sample: {
      inbound: { frameHeight: 448, framesDecoded: 20, framesPerSecond: 30, frameWidth: 920 },
      media: { height: 448, width: 920 },
      requested: { height: 856, width: 1603 },
      screen: { height: 448, width: 920 },
    },
    state,
  });
  state = result.state;
  result = assessNekoMediaSettle({
    maxSettlingSamples: 3,
    sample: {
      inbound: { frameHeight: 448, framesDecoded: 30, framesPerSecond: 30, frameWidth: 920 },
      media: { height: 448, width: 920 },
      requested: { height: 856, width: 1603 },
      screen: { height: 448, width: 920 },
    },
    state,
  });

  assert.equal(result.status, "degraded");
  assert.deepEqual(result.reasons, [
    "screen_not_covering_requested_viewport",
    "media_not_covering_requested_viewport",
    "inbound_frame_not_covering_requested_viewport",
  ]);
});

test("treats screen and media that cover the requested viewport as eligible for settle", () => {
  let state = createNekoMediaSettleState();
  state = assessNekoMediaSettle({
    sample: {
      inbound: { frameHeight: 848, framesDecoded: 1, frameWidth: 392 },
      media: { height: 848, width: 392 },
      requested,
      screen: { height: 848, width: 392 },
    },
    state,
  }).state;

  state = assessNekoMediaSettle({
    sample: {
      inbound: { frameHeight: 848, framesDecoded: 2, frameWidth: 392 },
      media: { height: 848, width: 392 },
      requested,
      screen: { height: 848, width: 392 },
    },
    state,
  }).state;

  const result = assessNekoMediaSettle({
    sample: {
      inbound: { frameHeight: 848, framesDecoded: 3, frameWidth: 392 },
      media: { height: 848, width: 392 },
      requested,
      screen: { height: 848, width: 392 },
    },
    state,
  });

  assert.equal(result.status, "settled");
});

test("settles on painted media when inbound stats are missing or stale", () => {
  let state = createNekoMediaSettleState();
  const first = assessNekoMediaSettle({
    sample: {
      inbound: null,
      media: { height: 848, width: 392 },
      requested,
      screen: { height: 848, width: 392 },
    },
    state,
  });
  assert.equal(first.status, "settling");
  assert.deepEqual(first.reasons, []);
  state = first.state;

  const second = assessNekoMediaSettle({
    sample: {
      inbound: { frameHeight: 432, framesPerSecond: 24, frameWidth: 936 },
      media: { height: 848, width: 392 },
      requested,
      screen: { height: 848, width: 392 },
    },
    state,
  });

  assert.equal(second.status, "settled");
  assert.deepEqual(second.reasons, []);
});

test("accepts exact-ish landscape media and rejects visibly cropped fallbacks", () => {
  const landscape = { height: 448, width: 916 };
  let state = createNekoMediaSettleState();
  const cropped = assessNekoMediaSettle({
    sample: {
      inbound: { frameHeight: 540, framesPerSecond: 24, frameWidth: 960 },
      media: { height: 540, width: 960 },
      requested: landscape,
      screen: { height: 540, width: 960 },
    },
    state,
  });

  assert.equal(cropped.status, "settling");
  assert.deepEqual(cropped.reasons, [
    "screen_not_covering_requested_viewport",
    "media_not_covering_requested_viewport",
  ]);
  state = cropped.state;

  const fitted = assessNekoMediaSettle({
    sample: {
      inbound: { frameHeight: 448, framesPerSecond: 24, frameWidth: 920 },
      media: { height: 448, width: 920 },
      requested: landscape,
      screen: { height: 448, width: 920 },
    },
    state,
  });

  assert.equal(fitted.reasons.includes("screen_not_covering_requested_viewport"), false);
  assert.equal(fitted.reasons.includes("media_not_covering_requested_viewport"), false);
});

test("rejects the Android portrait fallback that caused cover-crop and pointer drift", () => {
  const androidVisibleViewport = { height: 1736, width: 1008 };
  const result = assessNekoMediaSettle({
    sample: {
      inbound: null,
      media: { height: 1920, width: 1080 },
      requested: androidVisibleViewport,
      screen: { height: 1920, width: 1080 },
    },
    state: createNekoMediaSettleState(),
  });

  assert.equal(result.status, "settling");
  assert.deepEqual(result.reasons, [
    "screen_not_covering_requested_viewport",
    "media_not_covering_requested_viewport",
    "inbound_frame_not_covering_requested_viewport",
  ]);
});

test("requires a decoded-frame delta rather than trusting a stale first sample", () => {
  const result = assessNekoMediaSettle({
    sample: {
      inbound: { frameHeight: 844, framesDecoded: 5000, framesPerSecond: 0, frameWidth: 390 },
      media: requested,
      requested,
      screen: requested,
    },
    state: createNekoMediaSettleState(),
  });

  assert.equal(result.status, "settling");
  assert.deepEqual(result.reasons, ["frames_not_progressing"]);
});

test("does not block settling for one normal negotiation freeze", () => {
  let state = createNekoMediaSettleState();
  for (const inbound of [
    { frameHeight: 844, framesDecoded: 1, frameWidth: 390, freezeCount: 0 },
    { frameHeight: 844, framesDecoded: 2, frameWidth: 390, freezeCount: 1 },
  ]) {
    state = assessNekoMediaSettle({
      sample: { inbound, media: requested, requested, screen: requested },
      state,
    }).state;
  }

  const result = assessNekoMediaSettle({
    sample: {
      inbound: { frameHeight: 844, framesDecoded: 3, frameWidth: 390, freezeCount: 1 },
      media: requested,
      requested,
      screen: requested,
    },
    state,
  });

  assert.equal(result.status, "settled");
});
