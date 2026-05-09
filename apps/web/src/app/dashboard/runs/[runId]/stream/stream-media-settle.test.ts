import assert from "node:assert/strict";
import test from "node:test";
import { assessNekoMediaSettle, createNekoMediaSettleState } from "./stream-media-settle.ts";

const requested = { width: 390, height: 844 };

test("requires consecutive matching screen, media, inbound frames, and decoded progress", () => {
  let state = createNekoMediaSettleState();
  const baseline = assessNekoMediaSettle({
    sample: {
      requested,
      screen: requested,
      media: requested,
      inbound: { frameWidth: 390, frameHeight: 844, framesDecoded: 1, framesPerSecond: 24 },
    },
    state,
  });
  assert.equal(baseline.status, "settling");
  assert.deepEqual(baseline.reasons, ["frames_not_progressing"]);
  state = baseline.state;

  const first = assessNekoMediaSettle({
    sample: {
      requested,
      screen: requested,
      media: requested,
      inbound: { frameWidth: 390, frameHeight: 844, framesDecoded: 4, framesPerSecond: 24 },
    },
    state,
  });
  assert.equal(first.status, "settling");
  assert.equal(first.state.consecutiveReadySamples, 1);
  state = first.state;

  const second = assessNekoMediaSettle({
    sample: {
      requested,
      screen: requested,
      media: requested,
      inbound: { frameWidth: 390, frameHeight: 844, framesDecoded: 8, framesPerSecond: 24 },
    },
    state,
  });
  assert.equal(second.status, "settled");
  assert.equal(second.state.consecutiveReadySamples, 2);
});

test("reports why media is still settling", () => {
  const result = assessNekoMediaSettle({
    sample: {
      requested,
      screen: { width: 390, height: 844 },
      media: { width: 320, height: 640 },
      inbound: { frameWidth: 320, frameHeight: 640, framesDecoded: 0 },
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
        requested,
        screen: { width: 320, height: 640 },
        media: { width: 320, height: 640 },
        inbound: { frameWidth: 320, frameHeight: 640, framesDecoded: index + 1 },
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

test("treats screen and media that cover the requested viewport as eligible for settle", () => {
  let state = createNekoMediaSettleState();
  state = assessNekoMediaSettle({
    sample: {
      requested,
      screen: { width: 392, height: 848 },
      media: { width: 392, height: 848 },
      inbound: { frameWidth: 392, frameHeight: 848, framesDecoded: 1 },
    },
    state,
  }).state;

  state = assessNekoMediaSettle({
    sample: {
      requested,
      screen: { width: 392, height: 848 },
      media: { width: 392, height: 848 },
      inbound: { frameWidth: 392, frameHeight: 848, framesDecoded: 2 },
    },
    state,
  }).state;

  const result = assessNekoMediaSettle({
    sample: {
      requested,
      screen: { width: 392, height: 848 },
      media: { width: 392, height: 848 },
      inbound: { frameWidth: 392, frameHeight: 848, framesDecoded: 3 },
    },
    state,
  });

  assert.equal(result.status, "settled");
});

test("settles on painted media when inbound stats are missing or stale", () => {
  let state = createNekoMediaSettleState();
  const first = assessNekoMediaSettle({
    sample: {
      requested,
      screen: { width: 392, height: 848 },
      media: { width: 392, height: 848 },
      inbound: null,
    },
    state,
  });
  assert.equal(first.status, "settling");
  assert.deepEqual(first.reasons, []);
  state = first.state;

  const second = assessNekoMediaSettle({
    sample: {
      requested,
      screen: { width: 392, height: 848 },
      media: { width: 392, height: 848 },
      inbound: { frameWidth: 936, frameHeight: 432, framesPerSecond: 24 },
    },
    state,
  });

  assert.equal(second.status, "settled");
  assert.deepEqual(second.reasons, []);
});

test("accepts exact-ish landscape media and rejects visibly cropped fallbacks", () => {
  const landscape = { width: 916, height: 448 };
  let state = createNekoMediaSettleState();
  const cropped = assessNekoMediaSettle({
    sample: {
      requested: landscape,
      screen: { width: 960, height: 540 },
      media: { width: 960, height: 540 },
      inbound: { frameWidth: 960, frameHeight: 540, framesPerSecond: 24 },
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
      requested: landscape,
      screen: { width: 920, height: 448 },
      media: { width: 920, height: 448 },
      inbound: { frameWidth: 920, frameHeight: 448, framesPerSecond: 24 },
    },
    state,
  });

  assert.equal(fitted.reasons.includes("screen_not_covering_requested_viewport"), false);
  assert.equal(fitted.reasons.includes("media_not_covering_requested_viewport"), false);
});

test("rejects the Android portrait fallback that caused cover-crop and pointer drift", () => {
  const androidVisibleViewport = { width: 1008, height: 1736 };
  const result = assessNekoMediaSettle({
    sample: {
      requested: androidVisibleViewport,
      screen: { width: 1080, height: 1920 },
      media: { width: 1080, height: 1920 },
      inbound: null,
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
      requested,
      screen: requested,
      media: requested,
      inbound: { frameWidth: 390, frameHeight: 844, framesDecoded: 5000, framesPerSecond: 0 },
    },
    state: createNekoMediaSettleState(),
  });

  assert.equal(result.status, "settling");
  assert.deepEqual(result.reasons, ["frames_not_progressing"]);
});

test("does not block settling for one normal negotiation freeze", () => {
  let state = createNekoMediaSettleState();
  for (const inbound of [
    { frameWidth: 390, frameHeight: 844, framesDecoded: 1, freezeCount: 0 },
    { frameWidth: 390, frameHeight: 844, framesDecoded: 2, freezeCount: 1 },
  ]) {
    state = assessNekoMediaSettle({
      sample: { requested, screen: requested, media: requested, inbound },
      state,
    }).state;
  }

  const result = assessNekoMediaSettle({
    sample: {
      requested,
      screen: requested,
      media: requested,
      inbound: { frameWidth: 390, frameHeight: 844, framesDecoded: 3, freezeCount: 1 },
    },
    state,
  });

  assert.equal(result.status, "settled");
});
