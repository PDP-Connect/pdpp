import {
  buildViewportPayload,
  assessMobileKeyboardViewportResize,
  createMobileKeyboardResizeState,
  type CssBox,
  type LocalViewportSample,
  type MobileKeyboardResizeState,
  type StreamViewport,
  type ViewportPayload,
  viewportPayloadsAreEquivalent,
} from "./geometry.ts";
import type {
  StreamViewerSurface,
  StreamViewerSurfaceGeometry,
} from "./stream-viewer-surface.ts";
import {
  classifyViewportTransition,
  type ViewportObservation,
  type ViewportTransition,
} from "./viewport-classifier.ts";

export type ViewportMatchApplyViewport = (viewport: ViewportPayload) => Promise<void> | void;

export interface ViewportMatchClock {
  clearTimeout(handle: unknown): void;
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
}

export interface ViewportMatchViewportDefaults {
  deviceScaleFactor?: number;
  hasTouch?: boolean;
  mobile?: boolean;
  screenHeight?: number;
  screenWidth?: number;
  userAgent?: string;
}

export interface ViewportMatchSnapContext {
  geometry: StreamViewerSurfaceGeometry;
  observation: ViewportObservation;
  transition: ViewportTransition;
}

export type ViewportMatchSnapPolicy = (
  viewport: ViewportPayload,
  context: ViewportMatchSnapContext
) => ViewportPayload;

export type ViewportMatchObservationFactory = (
  geometry: StreamViewerSurfaceGeometry
) => ViewportObservation;

export type ViewportMatchDefaultsProvider =
  | ViewportMatchViewportDefaults
  | ((geometry: StreamViewerSurfaceGeometry) => ViewportMatchViewportDefaults);

export interface ViewportMatchOptions {
  clock?: ViewportMatchClock;
  debounceMs?: number;
  matchedThresholdPx?: number;
  observationFromGeometry?: ViewportMatchObservationFactory;
  snapViewport?: ViewportMatchSnapPolicy;
  viewportDefaults?: ViewportMatchDefaultsProvider;
}

export interface ViewportMatchControllerConfig {
  applyViewport: ViewportMatchApplyViewport;
  options?: ViewportMatchOptions;
  surface: StreamViewerSurface;
}

export interface ViewportMatchLetterboxBars {
  bottom: number;
  left: number;
  right: number;
  top: number;
}

export interface ViewportMatchTelemetry {
  actualViewport: StreamViewport | null;
  containerBox: CssBox | null;
  displayRect: CssBox | null;
  lastAppliedViewport: ViewportPayload | null;
  lastError: string | null;
  letterboxBars: ViewportMatchLetterboxBars;
  matched: boolean;
  maxLetterboxPx: number;
  pendingViewport: ViewportPayload | null;
  targetViewport: ViewportPayload | null;
  transition: ViewportTransition | null;
}

export type ViewportMatchTelemetryListener = (telemetry: ViewportMatchTelemetry) => void;

export interface ViewportMatchController {
  dispose(): void;
  getTelemetry(): ViewportMatchTelemetry;
  requestMatch(): void;
  subscribe(listener: ViewportMatchTelemetryListener): () => void;
}

const DEFAULT_DEBOUNCE_MS = 180;
const DEFAULT_MATCHED_THRESHOLD_PX = 2;
const ZERO_BARS: ViewportMatchLetterboxBars = {
  bottom: 0,
  left: 0,
  right: 0,
  top: 0,
};

const defaultClock: ViewportMatchClock = {
  clearTimeout(handle: unknown): void {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
  now(): number {
    return Date.now();
  },
  setTimeout(callback: () => void, delayMs: number): unknown {
    return setTimeout(callback, delayMs);
  },
};

function roundCssPixel(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.round(value)) : 1;
}

function currentWindow(): (Window & typeof globalThis) | null {
  return typeof window === "undefined" ? null : window;
}

function activeElementIsEditable(): boolean {
  const doc = typeof document === "undefined" ? null : document;
  const active = doc?.activeElement;
  if (!active) {
    return false;
  }
  if (
    (typeof HTMLInputElement !== "undefined" && active instanceof HTMLInputElement) ||
    (typeof HTMLTextAreaElement !== "undefined" && active instanceof HTMLTextAreaElement) ||
    (typeof HTMLSelectElement !== "undefined" && active instanceof HTMLSelectElement)
  ) {
    return true;
  }
  if (typeof HTMLElement !== "undefined" && active instanceof HTMLElement) {
    return active.isContentEditable || active.getAttribute("role") === "textbox";
  }
  return false;
}

function defaultViewportDefaults(geometry: StreamViewerSurfaceGeometry): ViewportMatchViewportDefaults {
  const win = currentWindow();
  const nav = typeof navigator === "undefined" ? null : navigator;
  const hasTouch = Boolean(nav && nav.maxTouchPoints > 0);
  const coarsePointer = Boolean(win?.matchMedia?.("(pointer: coarse)").matches);
  return {
    deviceScaleFactor: win?.devicePixelRatio ?? 1,
    hasTouch,
    mobile: hasTouch && (coarsePointer || Math.min(geometry.containerBox.width, geometry.containerBox.height) <= 900),
    userAgent: nav?.userAgent ?? "",
  };
}

function resolveViewportDefaults(
  defaults: ViewportMatchDefaultsProvider | undefined,
  geometry: StreamViewerSurfaceGeometry
): ViewportMatchViewportDefaults {
  if (!defaults) {
    return defaultViewportDefaults(geometry);
  }
  return typeof defaults === "function" ? defaults(geometry) : defaults;
}

function screenOrientationSample(): { angle: number; type: string } | null {
  const orientation = currentWindow()?.screen?.orientation;
  if (!orientation) {
    return null;
  }
  return {
    angle: typeof orientation.angle === "number" ? orientation.angle : 0,
    type: typeof orientation.type === "string" ? orientation.type : "",
  };
}

function visualViewportSample(): ViewportObservation["visual"] {
  const visual = currentWindow()?.visualViewport;
  if (!visual) {
    return null;
  }
  return {
    height: visual.height,
    offsetLeft: visual.offsetLeft,
    offsetTop: visual.offsetTop,
    pageLeft: visual.pageLeft,
    pageTop: visual.pageTop,
    scale: visual.scale,
    width: visual.width,
  };
}

function defaultObservationFromGeometry(geometry: StreamViewerSurfaceGeometry): ViewportObservation {
  const defaults = defaultViewportDefaults(geometry);
  const observation: ViewportObservation = {
    editableFocused: activeElementIsEditable(),
    layout: {
      height: roundCssPixel(geometry.containerBox.height),
      width: roundCssPixel(geometry.containerBox.width),
    },
    timestampMs: defaultClock.now(),
  };
  if (typeof defaults.mobile === "boolean") {
    observation.mobile = defaults.mobile;
  }
  const orientation = screenOrientationSample();
  if (orientation) {
    observation.orientation = orientation;
  }
  const visual = visualViewportSample();
  if (visual) {
    observation.visual = visual;
  }
  return observation;
}

function maxLetterboxPx(bars: ViewportMatchLetterboxBars): number {
  return Math.max(bars.left, bars.right, bars.top, bars.bottom);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildTargetViewport(
  geometry: StreamViewerSurfaceGeometry,
  defaults: ViewportMatchViewportDefaults
): ViewportPayload {
  const input: Parameters<typeof buildViewportPayload>[0] = {
    deviceScaleFactor: defaults.deviceScaleFactor ?? 1,
    hasTouch: defaults.hasTouch ?? false,
    height: geometry.containerBox.height,
    mobile: defaults.mobile ?? false,
    userAgent: defaults.userAgent ?? "",
    width: geometry.containerBox.width,
  };
  if (defaults.screenHeight !== undefined) {
    input.screenHeight = defaults.screenHeight;
  }
  if (defaults.screenWidth !== undefined) {
    input.screenWidth = defaults.screenWidth;
  }
  return buildViewportPayload(input);
}

function mobileViewportSampleFromObservation(observation: ViewportObservation): {
  height: number;
  mobile: boolean;
  width: number;
} {
  return {
    height: observation.layout.height,
    mobile: observation.mobile === true,
    width: observation.layout.width,
  };
}

function localViewportSampleFromObservation(observation: ViewportObservation): LocalViewportSample {
  return {
    height: observation.layout.height,
    visualHeight: observation.visual?.height ?? null,
    visualWidth: observation.visual?.width ?? null,
    width: observation.layout.width,
  };
}

function telemetryFromGeometry({
  geometry,
  lastAppliedViewport,
  lastError,
  matchedThresholdPx,
  pendingViewport,
  targetViewport,
  transition,
}: {
  geometry: StreamViewerSurfaceGeometry | null;
  lastAppliedViewport: ViewportPayload | null;
  lastError: string | null;
  matchedThresholdPx: number;
  pendingViewport: ViewportPayload | null;
  targetViewport: ViewportPayload | null;
  transition: ViewportTransition | null;
}): ViewportMatchTelemetry {
  const bars = geometry?.letterboxBars ?? ZERO_BARS;
  const mismatch = maxLetterboxPx(bars);
  return {
    actualViewport: geometry?.viewport ?? null,
    containerBox: geometry?.containerBox ?? null,
    displayRect: geometry?.displayRect ?? null,
    lastAppliedViewport,
    lastError,
    letterboxBars: bars,
    matched: Boolean(geometry) && mismatch <= matchedThresholdPx,
    maxLetterboxPx: mismatch,
    pendingViewport,
    targetViewport,
    transition,
  };
}

export function createViewportMatchController({
  applyViewport,
  options = {},
  surface,
}: ViewportMatchControllerConfig): ViewportMatchController {
  const clock = options.clock ?? defaultClock;
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const matchedThresholdPx = options.matchedThresholdPx ?? DEFAULT_MATCHED_THRESHOLD_PX;
  const observationFromGeometry = options.observationFromGeometry ?? defaultObservationFromGeometry;
  const snapViewport = options.snapViewport ?? ((viewport: ViewportPayload) => viewport);
  const listeners = new Set<ViewportMatchTelemetryListener>();

  let disposed = false;
  let lastAppliedViewport: ViewportPayload | null = null;
  let lastError: string | null = null;
  let lastGeometry = surface.getGeometry();
  let mobileKeyboardState: MobileKeyboardResizeState = createMobileKeyboardResizeState();
  let previousObservation: ViewportObservation | null = null;
  let pendingTimer: unknown = null;
  let pendingViewport: ViewportPayload | null = null;
  let targetViewport: ViewportPayload | null = null;
  let transition: ViewportTransition | null = null;

  function currentTelemetry(): ViewportMatchTelemetry {
    return telemetryFromGeometry({
      geometry: lastGeometry,
      lastAppliedViewport,
      lastError,
      matchedThresholdPx,
      pendingViewport,
      targetViewport,
      transition,
    });
  }

  function notify(): void {
    const telemetry = currentTelemetry();
    for (const listener of listeners) {
      listener(telemetry);
    }
  }

  function clearPending(): void {
    if (pendingTimer !== null) {
      clock.clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    pendingViewport = null;
  }

  function flushPending(): void {
    pendingTimer = null;
    const viewport = pendingViewport;
    pendingViewport = null;
    if (disposed || !viewport) {
      notify();
      return;
    }
    if (viewportPayloadsAreEquivalent(lastAppliedViewport, viewport)) {
      notify();
      return;
    }
    Promise.resolve(applyViewport(viewport))
      .then(() => {
        if (disposed) {
          return;
        }
        lastAppliedViewport = viewport;
        lastError = null;
        notify();
      })
      .catch((error: unknown) => {
        if (disposed) {
          return;
        }
        lastError = errorMessage(error);
        notify();
      });
    notify();
  }

  function scheduleApply(viewport: ViewportPayload): void {
    if (viewportPayloadsAreEquivalent(pendingViewport, viewport)) {
      return;
    }
    pendingViewport = viewport;
    if (pendingTimer !== null) {
      clock.clearTimeout(pendingTimer);
    }
    pendingTimer = clock.setTimeout(flushPending, debounceMs);
  }

  function observationForGeometry(geometry: StreamViewerSurfaceGeometry): ViewportObservation {
    const rawObservation = observationFromGeometry(geometry);
    return {
      ...rawObservation,
      timestampMs: rawObservation.timestampMs ?? clock.now(),
    };
  }

  function scheduleMatch(
    geometry: StreamViewerSurfaceGeometry,
    observation: ViewportObservation,
    nextTransition: ViewportTransition
  ): void {
    const defaults = resolveViewportDefaults(options.viewportDefaults, geometry);
    const snapped = snapViewport(buildTargetViewport(geometry, defaults), {
      geometry,
      observation,
      transition: nextTransition,
    });
    targetViewport = snapped;
    scheduleApply(snapped);
  }

  function observeGeometry(geometry: StreamViewerSurfaceGeometry): void {
    if (disposed) {
      return;
    }
    lastGeometry = geometry;
    const observation = observationForGeometry(geometry);
    const previous = previousObservation;
    transition = classifyViewportTransition(previous, observation);
    const keyboardAssessment = assessMobileKeyboardViewportResize({
      hasLocalTextInputFocus: observation.editableFocused,
      next: mobileViewportSampleFromObservation(observation),
      nextLocal: localViewportSampleFromObservation(observation),
      previous: previous ? mobileViewportSampleFromObservation(previous) : null,
      previousLocal: previous ? localViewportSampleFromObservation(previous) : null,
      state: mobileKeyboardState,
    });
    mobileKeyboardState = keyboardAssessment.state;
    if (keyboardAssessment.suppress && transition.remoteResize === "post") {
      transition = {
        keyboardInsetBottom: Math.max(0, (previous?.layout.height ?? observation.layout.height) - observation.layout.height),
        kind: "keyboard-occlusion",
        reason: "mobile-keyboard-viewport-assessment",
        remoteResize: "hold",
      };
    }
    previousObservation = observation;
    if (transition.remoteResize === "post") {
      scheduleMatch(geometry, observation, transition);
    } else if (transition.kind !== "stable") {
      clearPending();
    }
    notify();
  }

  const unsubscribeSurface = surface.subscribe(observeGeometry);

  return {
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      clearPending();
      unsubscribeSurface();
      listeners.clear();
    },
    getTelemetry(): ViewportMatchTelemetry {
      return currentTelemetry();
    },
    requestMatch(): void {
      if (disposed || !lastGeometry) {
        return;
      }
      const observation = observationForGeometry(lastGeometry);
      transition = {
        keyboardInsetBottom: 0,
        kind: "layout-resize",
        reason: "requested-match",
        remoteResize: "post",
      };
      previousObservation = observation;
      scheduleMatch(lastGeometry, observation, transition);
      notify();
    },
    subscribe(listener: ViewportMatchTelemetryListener): () => void {
      listeners.add(listener);
      listener(currentTelemetry());
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
