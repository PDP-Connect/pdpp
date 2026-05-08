import { applyToPoint, inverse, scale, transform, translate } from "transformation-matrix";

export interface StreamViewport {
  height: number;
  width: number;
}

export interface ViewportPayload extends StreamViewport {
  deviceScaleFactor: number;
  hasTouch: boolean;
  mobile: boolean;
  screenHeight?: number;
  screenWidth?: number;
  userAgent: string;
}

export interface CssBox {
  height: number;
  left: number;
  top: number;
  width: number;
}

export interface ClientPoint {
  clientX: number;
  clientY: number;
}

const DEFAULT_VIEWPORT_TOLERANCE_PX = 2;
const MOBILE_KEYBOARD_MIN_HEIGHT_DELTA_PX = 96;
const MOBILE_KEYBOARD_MIN_HEIGHT_DELTA_RATIO = 0.2;
const MOBILE_KEYBOARD_MAX_HEIGHT_DELTA_RATIO = 0.65;
const MOBILE_KEYBOARD_RESTORE_TOLERANCE_PX = 8;

type MobileViewportSample = Pick<ViewportPayload, "height" | "mobile" | "width">;

export interface LocalViewportSample {
  height: number;
  visualHeight: number | null;
  visualWidth: number | null;
  width: number;
}

export interface MobileKeyboardResizeState {
  baseline: MobileViewportSample | null;
  lastSuppressed: MobileViewportSample | null;
  mode: "keyboard" | "stable";
}

export function createMobileKeyboardResizeState(): MobileKeyboardResizeState {
  return { baseline: null, lastSuppressed: null, mode: "stable" };
}

function toPositiveCssPixel(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.max(1, Math.floor(value)) : 1;
}

export function buildViewportPayload({
  deviceScaleFactor,
  hasTouch,
  height,
  mobile,
  screenHeight,
  screenWidth,
  userAgent,
  width,
}: {
  width: number;
  height: number;
  deviceScaleFactor: number;
  hasTouch: boolean;
  mobile: boolean;
  screenHeight?: number;
  screenWidth?: number;
  userAgent: string;
}): ViewportPayload {
  const viewportWidth = toPositiveCssPixel(width);
  const viewportHeight = toPositiveCssPixel(height);
  const captureWidth =
    Number.isFinite(screenWidth) && Number(screenWidth) > 0 ? toPositiveCssPixel(Number(screenWidth)) : null;
  const captureHeight =
    Number.isFinite(screenHeight) && Number(screenHeight) > 0 ? toPositiveCssPixel(Number(screenHeight)) : null;
  const capture =
    captureWidth && captureHeight
      ? {
          screenHeight: Math.max(viewportHeight, captureHeight),
          screenWidth: Math.max(viewportWidth, captureWidth),
        }
      : {};
  return {
    width: viewportWidth,
    height: viewportHeight,
    deviceScaleFactor: Number.isFinite(deviceScaleFactor) && deviceScaleFactor > 0 ? deviceScaleFactor : 1,
    hasTouch: hasTouch === true,
    mobile: mobile === true,
    ...capture,
    userAgent: typeof userAgent === "string" ? userAgent.slice(0, 512) : "",
  };
}

export function viewportsAreEquivalent(
  a: StreamViewport | null | undefined,
  b: StreamViewport | null | undefined,
  tolerancePx = DEFAULT_VIEWPORT_TOLERANCE_PX
): boolean {
  if (!(a && b)) {
    return false;
  }
  return Math.abs(a.width - b.width) <= tolerancePx && Math.abs(a.height - b.height) <= tolerancePx;
}

function captureViewport(viewport: ViewportPayload): StreamViewport {
  return {
    width: viewport.screenWidth ?? viewport.width,
    height: viewport.screenHeight ?? viewport.height,
  };
}

export function viewportPayloadsAreEquivalent(
  a: ViewportPayload | null | undefined,
  b: ViewportPayload | null | undefined,
  tolerancePx = DEFAULT_VIEWPORT_TOLERANCE_PX
): boolean {
  if (!(a && b)) {
    return false;
  }
  return (
    viewportsAreEquivalent(a, b, tolerancePx) &&
    viewportsAreEquivalent(captureViewport(a), captureViewport(b), tolerancePx) &&
    Math.abs(a.deviceScaleFactor - b.deviceScaleFactor) <= 0.01 &&
    a.hasTouch === b.hasTouch &&
    a.mobile === b.mobile
  );
}

export function isMobileKeyboardViewportResize({
  hasLocalTextInputFocus = false,
  next,
  nextLocal,
  previous,
  previousLocal,
}: {
  hasLocalTextInputFocus?: boolean;
  next: MobileViewportSample;
  nextLocal?: LocalViewportSample | null;
  previous: MobileViewportSample | null | undefined;
  previousLocal?: LocalViewportSample | null;
}): boolean {
  if (!(next.mobile && previous?.mobile)) {
    return false;
  }
  if (Math.abs(next.width - previous.width) > DEFAULT_VIEWPORT_TOLERANCE_PX) {
    return false;
  }
  const heightDrop = previous.height - next.height;
  if (heightDrop <= 0) {
    return false;
  }
  const heightDropRatio = heightDrop / previous.height;
  if (
    heightDrop < MOBILE_KEYBOARD_MIN_HEIGHT_DELTA_PX ||
    heightDropRatio < MOBILE_KEYBOARD_MIN_HEIGHT_DELTA_RATIO ||
    heightDropRatio > MOBILE_KEYBOARD_MAX_HEIGHT_DELTA_RATIO
  ) {
    return false;
  }

  const visualHeightDrop =
    previousLocal?.visualHeight && nextLocal?.visualHeight ? previousLocal.visualHeight - nextLocal.visualHeight : 0;
  const layoutHeightDrop = previousLocal ? previousLocal.height - (nextLocal?.height ?? previousLocal.height) : 0;
  const visualOnlyKeyboardSignal =
    visualHeightDrop >= MOBILE_KEYBOARD_MIN_HEIGHT_DELTA_PX &&
    Math.abs((previousLocal?.width ?? previous.width) - (nextLocal?.width ?? next.width)) <=
      DEFAULT_VIEWPORT_TOLERANCE_PX &&
    Math.abs(layoutHeightDrop) <= DEFAULT_VIEWPORT_TOLERANCE_PX * 4;

  // Same-width 20-65% mobile height drops are already keyboard-shaped. Focus
  // and visual-viewport signals increase confidence but are not mandatory:
  // IME/autofill/shadow-DOM paths can summon a keyboard without focusing the
  // hidden local textarea that forwards keystrokes into the stream.
  return (
    hasLocalTextInputFocus || visualOnlyKeyboardSignal || heightDropRatio >= MOBILE_KEYBOARD_MIN_HEIGHT_DELTA_RATIO
  );
}

export function assessMobileKeyboardViewportResize({
  hasLocalTextInputFocus = false,
  next,
  nextLocal,
  previous,
  previousLocal,
  state,
}: {
  hasLocalTextInputFocus?: boolean;
  next: MobileViewportSample;
  nextLocal?: LocalViewportSample | null;
  previous: MobileViewportSample | null | undefined;
  previousLocal?: LocalViewportSample | null;
  state: MobileKeyboardResizeState;
}): { state: MobileKeyboardResizeState; suppress: boolean } {
  if (!(next.mobile && previous?.mobile)) {
    return { state: createMobileKeyboardResizeState(), suppress: false };
  }

  const baseline = state.mode === "keyboard" ? state.baseline : previous;
  if (!baseline || Math.abs(next.width - baseline.width) > DEFAULT_VIEWPORT_TOLERANCE_PX) {
    return { state: createMobileKeyboardResizeState(), suppress: false };
  }

  if (state.mode === "keyboard") {
    if (
      viewportsAreEquivalent(baseline, next, MOBILE_KEYBOARD_RESTORE_TOLERANCE_PX) ||
      next.height >= baseline.height
    ) {
      return { state: createMobileKeyboardResizeState(), suppress: false };
    }
    if (next.height < baseline.height) {
      return {
        state: { baseline, lastSuppressed: next, mode: "keyboard" },
        suppress: true,
      };
    }
  }

  if (
    isMobileKeyboardViewportResize({
      hasLocalTextInputFocus,
      next,
      nextLocal,
      previous: baseline,
      previousLocal,
    })
  ) {
    return {
      state: { baseline, lastSuppressed: next, mode: "keyboard" },
      suppress: true,
    };
  }

  return { state: createMobileKeyboardResizeState(), suppress: false };
}

export function containedStreamRect(imageBox: CssBox, viewport: StreamViewport): CssBox {
  const aspectRatio = viewport.width / viewport.height;
  const boxRatio = imageBox.width / imageBox.height;
  if (!(Number.isFinite(aspectRatio) && Number.isFinite(boxRatio)) || imageBox.width <= 0 || imageBox.height <= 0) {
    return imageBox;
  }
  if (boxRatio > aspectRatio) {
    const width = imageBox.height * aspectRatio;
    return {
      left: imageBox.left + (imageBox.width - width) / 2,
      top: imageBox.top,
      width,
      height: imageBox.height,
    };
  }
  const height = imageBox.width / aspectRatio;
  return {
    left: imageBox.left,
    top: imageBox.top + (imageBox.height - height) / 2,
    width: imageBox.width,
    height,
  };
}

function streamViewportToClientMatrix(rect: CssBox, viewport: StreamViewport) {
  return transform(translate(rect.left, rect.top), scale(rect.width / viewport.width, rect.height / viewport.height));
}

export function pointToStreamViewport(
  point: ClientPoint,
  {
    containerBox,
    imageBox,
    viewport,
  }: {
    containerBox: CssBox;
    imageBox?: CssBox | null;
    viewport?: StreamViewport | null;
  }
): { x: number; y: number } | null {
  const rect = imageBox && viewport ? containedStreamRect(imageBox, viewport) : containerBox;
  if (rect.width <= 0 || rect.height <= 0) {
    return null;
  }

  const x = point.clientX - rect.left;
  const y = point.clientY - rect.top;
  if (!(Number.isFinite(x) && Number.isFinite(y))) {
    return null;
  }
  if (x < 0 || y < 0 || x > rect.width || y > rect.height) {
    return null;
  }

  if (imageBox && viewport) {
    const mapped = applyToPoint(inverse(streamViewportToClientMatrix(rect, viewport)), {
      x: point.clientX,
      y: point.clientY,
    });
    return {
      x: Math.round(mapped.x),
      y: Math.round(mapped.y),
    };
  }

  return { x: Math.round(x), y: Math.round(y) };
}
