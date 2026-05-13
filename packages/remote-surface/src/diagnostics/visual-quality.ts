import type { CssBox, StreamViewport } from "../client/geometry.ts";

const DEFAULT_RATIO_TOLERANCE = 0.02;
const DEFAULT_CAPTURE_ALIGNMENT_PX = 8;
const DEFAULT_CAPTURE_MAX_PIXELS = 2_200_000;
const DEFAULT_CAPTURE_MAX_SCALE = 2.5;
const DEFAULT_EMPTY_AREA_ISSUE_RATIO = 0.015;
const DEFAULT_STRETCH_ISSUE_RATIO = 1.03;
const EDGE_MAGNITUDE_THRESHOLD = 64;
const MAX_LUMA = 255;
const SOBEL_MAX_MAGNITUDE = 1020;

export interface PixelFitInput {
  containerRect?: CssBox | null;
  devicePixelRatio?: number | null;
  intrinsic: StreamViewport | null;
  mediaRect: CssBox | null;
  ratioTolerance?: number;
  visualViewportScale?: number | null;
}

export interface PixelFitTelemetry {
  decodedPerCssPixel: { x: number; y: number };
  decodedPerPhysicalPixel: { x: number; y: number };
  displayCss: { height: number; width: number };
  displayPhysical: { height: number; width: number };
  emptyAreaRatio: number | null;
  gutters: { bottom: number; left: number; right: number; top: number } | null;
  intrinsic: { height: number; width: number };
  isCssOneToOne: boolean;
  isPhysicalOneToOne: boolean;
  stretchRatio: number;
  upscaledCss: boolean;
  upscaledPhysical: boolean;
}

export interface SharpnessTelemetry {
  contrast: number;
  edgeDensity: number;
  laplacianVariance: number;
  sample: { height: number; width: number };
  sobelEnergy: number;
}

export interface StreamCaptureTarget {
  capped: boolean;
  devicePixelRatio: number;
  height: number;
  maxPixels: number;
  requestedScale: number;
  scale: number;
  width: number;
}

export interface StreamCaptureTargetContextInput {
  alignmentPx?: number;
  devicePixelRatio?: number | null;
  highDprCapture: boolean;
  maxPixels?: number;
  maxScale?: number;
  viewport: StreamViewport;
}

export interface VisualQualityIssueClassificationOptions {
  emptyAreaIssueRatio?: number;
  stretchIssueRatio?: number;
}

export interface VisualQualityIssueInput {
  intrinsic?: unknown;
  pixelFit?: unknown;
  rect?: unknown;
  tagName?: unknown;
}

export interface VisualQualityIssue {
  index: number;
  intrinsic: unknown;
  pixelFit: Record<string, unknown>;
  reasons: string[];
  rect: unknown;
  tagName: unknown;
}

function finitePositive(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function roundMetric(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function toPositiveInteger(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.max(1, Math.floor(value)) : 1;
}

function alignTo(value: number, alignment: number): number {
  const align = toPositiveInteger(alignment);
  return Math.max(1, Math.round(value / align) * align);
}

function ratioIsNearOne(value: number, tolerance: number): boolean {
  return Math.abs(value - 1) <= tolerance;
}

function rectArea(rect: Pick<CssBox, "height" | "width">): number {
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

function intersectionArea(a: CssBox, b: CssBox): number {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.left + a.width, b.left + b.width);
  const bottom = Math.min(a.top + a.height, b.top + b.height);
  return Math.max(0, right - left) * Math.max(0, bottom - top);
}

function computeGutters(containerRect: CssBox, mediaRect: CssBox): PixelFitTelemetry["gutters"] {
  return {
    bottom: roundMetric(Math.max(0, containerRect.top + containerRect.height - (mediaRect.top + mediaRect.height))),
    left: roundMetric(Math.max(0, mediaRect.left - containerRect.left)),
    right: roundMetric(Math.max(0, containerRect.left + containerRect.width - (mediaRect.left + mediaRect.width))),
    top: roundMetric(Math.max(0, mediaRect.top - containerRect.top)),
  };
}

export function computeStreamCaptureTarget({
  alignmentPx = DEFAULT_CAPTURE_ALIGNMENT_PX,
  devicePixelRatio = 1,
  maxPixels = DEFAULT_CAPTURE_MAX_PIXELS,
  maxScale = DEFAULT_CAPTURE_MAX_SCALE,
  viewport,
}: {
  alignmentPx?: number;
  devicePixelRatio?: number | null;
  maxPixels?: number;
  maxScale?: number;
  viewport: StreamViewport;
}): StreamCaptureTarget {
  const width = toPositiveInteger(viewport.width);
  const height = toPositiveInteger(viewport.height);
  const dpr = finitePositive(devicePixelRatio) ? devicePixelRatio : 1;
  const boundedMaxPixels = Math.max(width * height, toPositiveInteger(maxPixels));
  const requestedScale = Math.max(1, Math.min(dpr, finitePositive(maxScale) ? maxScale : DEFAULT_CAPTURE_MAX_SCALE));
  const maxPixelScale = Math.sqrt(boundedMaxPixels / Math.max(1, width * height));
  const targetScale = Math.max(1, Math.min(requestedScale, maxPixelScale));
  let screenWidth = Math.max(width, alignTo(width * targetScale, alignmentPx));
  let screenHeight = Math.max(height, alignTo(height * targetScale, alignmentPx));

  while (screenWidth * screenHeight > boundedMaxPixels && (screenWidth > width || screenHeight > height)) {
    if (screenWidth / width >= screenHeight / height && screenWidth > width) {
      screenWidth = Math.max(width, screenWidth - toPositiveInteger(alignmentPx));
    } else if (screenHeight > height) {
      screenHeight = Math.max(height, screenHeight - toPositiveInteger(alignmentPx));
    } else {
      break;
    }
  }

  const scale = Math.min(screenWidth / width, screenHeight / height);
  return {
    capped: requestedScale > scale + 0.01,
    devicePixelRatio: roundMetric(dpr),
    height: screenHeight,
    maxPixels: boundedMaxPixels,
    requestedScale: roundMetric(requestedScale),
    scale: roundMetric(scale),
    width: screenWidth,
  };
}

export function computeStreamCaptureTargetForContext({
  alignmentPx = DEFAULT_CAPTURE_ALIGNMENT_PX,
  devicePixelRatio = 1,
  highDprCapture,
  maxPixels = DEFAULT_CAPTURE_MAX_PIXELS,
  maxScale = DEFAULT_CAPTURE_MAX_SCALE,
  viewport,
}: StreamCaptureTargetContextInput): StreamCaptureTarget {
  return computeStreamCaptureTarget({
    alignmentPx: highDprCapture ? alignmentPx : 1,
    devicePixelRatio: highDprCapture ? devicePixelRatio : 1,
    maxPixels,
    maxScale,
    viewport,
  });
}

export function computePixelFitTelemetry({
  containerRect,
  devicePixelRatio = 1,
  intrinsic,
  mediaRect,
  ratioTolerance = DEFAULT_RATIO_TOLERANCE,
  visualViewportScale = 1,
}: PixelFitInput): PixelFitTelemetry | null {
  if (!(intrinsic && mediaRect)) {
    return null;
  }

  const hasValidSize =
    finitePositive(intrinsic.width) &&
    finitePositive(intrinsic.height) &&
    finitePositive(mediaRect.width) &&
    finitePositive(mediaRect.height);
  if (!hasValidSize) {
    return null;
  }

  const dpr = finitePositive(devicePixelRatio) ? devicePixelRatio : 1;
  const viewportScale = finitePositive(visualViewportScale) ? visualViewportScale : 1;
  const physicalWidth = mediaRect.width * dpr * viewportScale;
  const physicalHeight = mediaRect.height * dpr * viewportScale;
  const decodedPerCssX = intrinsic.width / mediaRect.width;
  const decodedPerCssY = intrinsic.height / mediaRect.height;
  const decodedPerPhysicalX = intrinsic.width / physicalWidth;
  const decodedPerPhysicalY = intrinsic.height / physicalHeight;
  const stretchRatio =
    Math.max(decodedPerCssX, decodedPerCssY) / Math.max(Number.MIN_VALUE, Math.min(decodedPerCssX, decodedPerCssY));

  const containerArea = containerRect && rectArea(containerRect);
  const emptyAreaRatio =
    containerRect && containerArea
      ? roundMetric(Math.max(0, containerArea - intersectionArea(containerRect, mediaRect)) / containerArea)
      : null;

  return {
    decodedPerCssPixel: { x: roundMetric(decodedPerCssX), y: roundMetric(decodedPerCssY) },
    decodedPerPhysicalPixel: { x: roundMetric(decodedPerPhysicalX), y: roundMetric(decodedPerPhysicalY) },
    displayCss: { height: roundMetric(mediaRect.height), width: roundMetric(mediaRect.width) },
    displayPhysical: { height: roundMetric(physicalHeight), width: roundMetric(physicalWidth) },
    emptyAreaRatio,
    gutters: containerRect ? computeGutters(containerRect, mediaRect) : null,
    intrinsic: { height: intrinsic.height, width: intrinsic.width },
    isCssOneToOne: ratioIsNearOne(decodedPerCssX, ratioTolerance) && ratioIsNearOne(decodedPerCssY, ratioTolerance),
    isPhysicalOneToOne:
      ratioIsNearOne(decodedPerPhysicalX, ratioTolerance) && ratioIsNearOne(decodedPerPhysicalY, ratioTolerance),
    stretchRatio: roundMetric(stretchRatio),
    upscaledCss: decodedPerCssX < 1 - ratioTolerance || decodedPerCssY < 1 - ratioTolerance,
    upscaledPhysical: decodedPerPhysicalX < 1 - ratioTolerance || decodedPerPhysicalY < 1 - ratioTolerance,
  };
}

export function classifyVisualQualityIssues(
  media: VisualQualityIssueInput[],
  {
    emptyAreaIssueRatio = DEFAULT_EMPTY_AREA_ISSUE_RATIO,
    stretchIssueRatio = DEFAULT_STRETCH_ISSUE_RATIO,
  }: VisualQualityIssueClassificationOptions = {}
): VisualQualityIssue[] {
  return media.flatMap((entry, index) => {
    const pixelFit =
      entry.pixelFit && typeof entry.pixelFit === "object" ? (entry.pixelFit as Record<string, unknown>) : null;
    if (!pixelFit) {
      return [];
    }
    const reasons: string[] = [];
    const emptyAreaRatio = Number(pixelFit.emptyAreaRatio);
    const stretchRatio = Number(pixelFit.stretchRatio);
    if (Number.isFinite(emptyAreaRatio) && emptyAreaRatio > emptyAreaIssueRatio) {
      reasons.push("empty-area");
    }
    if (Number.isFinite(stretchRatio) && stretchRatio > stretchIssueRatio) {
      reasons.push("non-uniform-stretch");
    }
    if (pixelFit.upscaledCss === true) {
      reasons.push("upscaled-css");
    }
    if (pixelFit.upscaledPhysical === true) {
      reasons.push("upscaled-physical");
    }
    if (reasons.length === 0) {
      return [];
    }
    return [
      {
        index,
        intrinsic: entry.intrinsic,
        pixelFit,
        reasons,
        rect: entry.rect,
        tagName: entry.tagName,
      },
    ];
  });
}

function lumaAt(luma: ArrayLike<number>, width: number, x: number, y: number): number {
  return luma[y * width + x] ?? 0;
}

export function computeSharpnessTelemetryFromLuma({
  height,
  luma,
  width,
}: {
  height: number;
  luma: ArrayLike<number>;
  width: number;
}): SharpnessTelemetry | null {
  if (
    !(Number.isInteger(width) && Number.isInteger(height)) ||
    width < 3 ||
    height < 3 ||
    luma.length < width * height
  ) {
    return null;
  }

  let lumaSum = 0;
  let lumaSquaredSum = 0;
  for (let index = 0; index < width * height; index += 1) {
    const value = luma[index] ?? 0;
    lumaSum += value;
    lumaSquaredSum += value * value;
  }
  const lumaCount = width * height;
  const lumaMean = lumaSum / lumaCount;
  const contrast = Math.sqrt(Math.max(0, lumaSquaredSum / lumaCount - lumaMean * lumaMean)) / MAX_LUMA;

  let edgeCount = 0;
  let laplacianSum = 0;
  let laplacianSquaredSum = 0;
  let sobelEnergySum = 0;
  let sampleCount = 0;

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const topLeft = lumaAt(luma, width, x - 1, y - 1);
      const top = lumaAt(luma, width, x, y - 1);
      const topRight = lumaAt(luma, width, x + 1, y - 1);
      const left = lumaAt(luma, width, x - 1, y);
      const center = lumaAt(luma, width, x, y);
      const right = lumaAt(luma, width, x + 1, y);
      const bottomLeft = lumaAt(luma, width, x - 1, y + 1);
      const bottom = lumaAt(luma, width, x, y + 1);
      const bottomRight = lumaAt(luma, width, x + 1, y + 1);
      const gx = -topLeft + topRight - 2 * left + 2 * right - bottomLeft + bottomRight;
      const gy = -topLeft - 2 * top - topRight + bottomLeft + 2 * bottom + bottomRight;
      const sobelMagnitudeSquared = gx * gx + gy * gy;
      const laplacian = 4 * center - top - left - right - bottom;

      if (Math.sqrt(sobelMagnitudeSquared) >= EDGE_MAGNITUDE_THRESHOLD) {
        edgeCount += 1;
      }
      laplacianSum += laplacian;
      laplacianSquaredSum += laplacian * laplacian;
      sobelEnergySum += sobelMagnitudeSquared;
      sampleCount += 1;
    }
  }

  if (sampleCount === 0) {
    return null;
  }
  const laplacianMean = laplacianSum / sampleCount;
  const laplacianVariance = Math.max(0, laplacianSquaredSum / sampleCount - laplacianMean * laplacianMean);

  return {
    contrast: roundMetric(contrast),
    edgeDensity: roundMetric(edgeCount / sampleCount),
    laplacianVariance: roundMetric(laplacianVariance / (MAX_LUMA * MAX_LUMA)),
    sample: { height, width },
    sobelEnergy: roundMetric(sobelEnergySum / sampleCount / (SOBEL_MAX_MAGNITUDE * SOBEL_MAX_MAGNITUDE)),
  };
}
