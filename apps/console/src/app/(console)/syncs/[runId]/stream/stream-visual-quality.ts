// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { computeSharpnessTelemetryFromLuma, type SharpnessTelemetry } from "@opendatalabs/remote-surface/diagnostics";

const DEFAULT_SHARPNESS_SAMPLE_WIDTH = 160;

let sharpnessCanvas: HTMLCanvasElement | null = null;

function finitePositive(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function sampleVideoSharpnessTelemetry(
  video: HTMLVideoElement,
  { sampleWidth = DEFAULT_SHARPNESS_SAMPLE_WIDTH }: { sampleWidth?: number } = {}
): SharpnessTelemetry | null {
  if (
    video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
    !finitePositive(video.videoWidth) ||
    !finitePositive(video.videoHeight)
  ) {
    return null;
  }

  const width = Math.max(3, Math.min(sampleWidth, video.videoWidth));
  const height = Math.max(3, Math.round((width * video.videoHeight) / video.videoWidth));
  sharpnessCanvas ??= document.createElement("canvas");
  sharpnessCanvas.width = width;
  sharpnessCanvas.height = height;
  const context = sharpnessCanvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    return null;
  }

  try {
    context.drawImage(video, 0, 0, width, height);
    const { data } = context.getImageData(0, 0, width, height);
    const luma = new Uint8ClampedArray(width * height);
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      const offset = pixel * 4;
      luma[pixel] = Math.round(
        (data[offset] ?? 0) * 0.299 + (data[offset + 1] ?? 0) * 0.587 + (data[offset + 2] ?? 0) * 0.114
      );
    }
    return computeSharpnessTelemetryFromLuma({ height, luma, width });
  } catch {
    return null;
  }
}
