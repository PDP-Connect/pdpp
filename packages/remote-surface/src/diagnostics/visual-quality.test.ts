import assert from "node:assert/strict";
import test from "node:test";
import {
  computePixelFitTelemetry,
  computeSharpnessTelemetryFromLuma,
  computeStreamCaptureTarget,
  computeStreamCaptureTargetForContext,
} from "./visual-quality.ts";

test("computePixelFitTelemetry identifies exact CSS-pixel mapping separately from physical pixels", () => {
  const fit = computePixelFitTelemetry({
    devicePixelRatio: 3,
    intrinsic: { width: 390, height: 844 },
    mediaRect: { left: 0, top: 0, width: 390, height: 844 },
    visualViewportScale: 1,
  });

  assert.equal(fit?.isCssOneToOne, true);
  assert.equal(fit?.isPhysicalOneToOne, false);
  assert.deepEqual(fit?.decodedPerCssPixel, { x: 1, y: 1 });
  assert.deepEqual(fit?.decodedPerPhysicalPixel, { x: 0.333, y: 0.333 });
  assert.equal(fit?.upscaledCss, false);
  assert.equal(fit?.upscaledPhysical, true);
});

test("computeStreamCaptureTarget requests bounded high-DPR capture pixels", () => {
  const target = computeStreamCaptureTarget({
    viewport: { width: 448, height: 819 },
    devicePixelRatio: 2.25,
    maxPixels: 2_200_000,
  });

  assert.equal(target.width, 1008);
  assert.equal(target.height, 1840);
  assert.equal(target.capped, false);
  assert.ok(Math.abs(target.width / target.height - 448 / 819) < 0.01);
});

test("computeStreamCaptureTarget caps very large high-DPR viewports", () => {
  const target = computeStreamCaptureTarget({
    viewport: { width: 1440, height: 900 },
    devicePixelRatio: 3,
    maxPixels: 2_200_000,
  });

  assert.equal(target.capped, true);
  assert.ok(target.width * target.height <= 2_200_000);
  assert.ok(target.width >= 1440);
  assert.ok(target.height >= 900);
  assert.ok(Math.abs(target.width / target.height - 1440 / 900) < 0.02);
});

test("computeStreamCaptureTargetForContext keeps desktop capture in CSS pixels", () => {
  const target = computeStreamCaptureTargetForContext({
    devicePixelRatio: 1.15,
    highDprCapture: false,
    viewport: { width: 1117, height: 1123 },
  });

  assert.equal(target.width, 1117);
  assert.equal(target.height, 1123);
  assert.equal(target.scale, 1);
  assert.equal(target.requestedScale, 1);
});

test("computeStreamCaptureTargetForContext allows mobile high-DPR capture", () => {
  const target = computeStreamCaptureTargetForContext({
    devicePixelRatio: 2.25,
    highDprCapture: true,
    viewport: { width: 947, height: 364 },
  });

  assert.equal(target.width, 2128);
  assert.equal(target.height, 816);
  assert.ok(target.scale > 2.2);
});

test("computePixelFitTelemetry flags non-uniform stretch and gutters", () => {
  const fit = computePixelFitTelemetry({
    containerRect: { left: 0, top: 0, width: 1000, height: 500 },
    devicePixelRatio: 1,
    intrinsic: { width: 400, height: 800 },
    mediaRect: { left: 100, top: 0, width: 800, height: 500 },
    visualViewportScale: 1,
  });

  assert.equal(fit?.isCssOneToOne, false);
  assert.equal(fit?.stretchRatio, 3.2);
  assert.equal(fit?.emptyAreaRatio, 0.2);
  assert.deepEqual(fit?.gutters, { bottom: 0, left: 100, right: 100, top: 0 });
});

test("computeSharpnessTelemetryFromLuma returns near-zero scores for a flat frame", () => {
  const luma = new Uint8ClampedArray(16 * 16).fill(127);
  const sharpness = computeSharpnessTelemetryFromLuma({ height: 16, luma, width: 16 });

  assert.equal(sharpness?.contrast, 0);
  assert.equal(sharpness?.edgeDensity, 0);
  assert.equal(sharpness?.laplacianVariance, 0);
  assert.equal(sharpness?.sobelEnergy, 0);
});

test("computeSharpnessTelemetryFromLuma reports edges for a high-contrast calibration line", () => {
  const width = 16;
  const height = 16;
  const luma = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      luma[y * width + x] = x < width / 2 ? 0 : 255;
    }
  }
  const sharpness = computeSharpnessTelemetryFromLuma({ height, luma, width });

  assert.ok((sharpness?.contrast ?? 0) > 0.45);
  assert.ok((sharpness?.edgeDensity ?? 0) > 0.05);
  assert.ok((sharpness?.laplacianVariance ?? 0) > 0);
  assert.ok((sharpness?.sobelEnergy ?? 0) > 0);
});
