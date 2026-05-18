import type { CssBox, StreamViewport } from "../client/geometry.ts";
export interface PixelFitInput {
    containerRect?: CssBox | null;
    devicePixelRatio?: number | null;
    intrinsic: StreamViewport | null;
    mediaRect: CssBox | null;
    ratioTolerance?: number;
    visualViewportScale?: number | null;
}
export interface PixelFitTelemetry {
    decodedPerCssPixel: {
        x: number;
        y: number;
    };
    decodedPerPhysicalPixel: {
        x: number;
        y: number;
    };
    displayCss: {
        height: number;
        width: number;
    };
    displayPhysical: {
        height: number;
        width: number;
    };
    emptyAreaRatio: number | null;
    gutters: {
        bottom: number;
        left: number;
        right: number;
        top: number;
    } | null;
    intrinsic: {
        height: number;
        width: number;
    };
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
    sample: {
        height: number;
        width: number;
    };
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
export declare function computeStreamCaptureTarget({ alignmentPx, devicePixelRatio, maxPixels, maxScale, viewport, }: {
    alignmentPx?: number;
    devicePixelRatio?: number | null;
    maxPixels?: number;
    maxScale?: number;
    viewport: StreamViewport;
}): StreamCaptureTarget;
export declare function computeStreamCaptureTargetForContext({ alignmentPx, devicePixelRatio, highDprCapture, maxPixels, maxScale, viewport, }: StreamCaptureTargetContextInput): StreamCaptureTarget;
export declare function computePixelFitTelemetry({ containerRect, devicePixelRatio, intrinsic, mediaRect, ratioTolerance, visualViewportScale, }: PixelFitInput): PixelFitTelemetry | null;
export declare function classifyVisualQualityIssues(media: VisualQualityIssueInput[], { emptyAreaIssueRatio, stretchIssueRatio, }?: VisualQualityIssueClassificationOptions): VisualQualityIssue[];
export declare function computeSharpnessTelemetryFromLuma({ height, luma, width, }: {
    height: number;
    luma: ArrayLike<number>;
    width: number;
}): SharpnessTelemetry | null;
//# sourceMappingURL=visual-quality.d.ts.map