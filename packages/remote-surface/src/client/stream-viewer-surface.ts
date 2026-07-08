import type { CssBox, StreamViewport, ViewportPayload } from "./geometry.ts";
import {
  buildViewportPayload,
  containedStreamRect,
  pointToStreamViewport,
  streamViewportRectToClientBox,
} from "./geometry.ts";

export interface StreamViewerSurfaceViewportInput extends StreamViewport {
  deviceScaleFactor?: number;
  hasTouch?: boolean;
  mobile?: boolean;
  screenHeight?: number;
  screenWidth?: number;
  userAgent?: string;
}

export interface StreamViewerSurfaceGeometry {
  containerBox: CssBox;
  displayRect: CssBox;
  isOneToOne: boolean;
  letterboxBars: {
    bottom: number;
    left: number;
    right: number;
    top: number;
  };
  scale: number;
  viewport: StreamViewport;
}

export interface StreamViewerSurface {
  dispose(): void;
  getGeometry(): StreamViewerSurfaceGeometry | null;
  mapClientPointToStream(clientX: number, clientY: number): { x: number; y: number } | null;
  projectStreamViewportRectToClientBox(fieldRect: {
    height: number;
    width: number;
    x: number;
    y: number;
  }): CssBox | null;
  setViewport(viewport: StreamViewerSurfaceViewportInput): void;
  subscribe(listener: StreamViewerSurfaceGeometryListener): () => void;
}

export type StreamViewerSurfaceGeometryListener = (geometry: StreamViewerSurfaceGeometry) => void;

export interface StreamViewerSurfaceOptions {
  onGeometryChange?: StreamViewerSurfaceGeometryListener;
  resizeObserverFactory?: StreamViewerResizeObserverFactory;
}

export interface StreamViewerResizeObserver {
  disconnect(): void;
  observe(target: Element): void;
  unobserve(target: Element): void;
}

export type StreamViewerResizeObserverFactory = (callback: () => void) => StreamViewerResizeObserver;

const DEFAULT_VIEWPORT_INPUT: Required<
  Pick<StreamViewerSurfaceViewportInput, "deviceScaleFactor" | "hasTouch" | "mobile" | "userAgent">
> = {
  deviceScaleFactor: 1,
  hasTouch: false,
  mobile: false,
  userAgent: "",
};

function defaultResizeObserverFactory(callback: () => void): StreamViewerResizeObserver {
  if (typeof ResizeObserver === "undefined") {
    throw new Error("ResizeObserver is not available in this environment");
  }
  return new ResizeObserver(() => callback());
}

function normalizeViewport(viewport: StreamViewerSurfaceViewportInput): ViewportPayload {
  const input: {
    width: number;
    height: number;
    deviceScaleFactor: number;
    hasTouch: boolean;
    mobile: boolean;
    userAgent: string;
    screenHeight?: number;
    screenWidth?: number;
  } = {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: viewport.deviceScaleFactor ?? DEFAULT_VIEWPORT_INPUT.deviceScaleFactor,
    hasTouch: viewport.hasTouch ?? DEFAULT_VIEWPORT_INPUT.hasTouch,
    mobile: viewport.mobile ?? DEFAULT_VIEWPORT_INPUT.mobile,
    userAgent: viewport.userAgent ?? DEFAULT_VIEWPORT_INPUT.userAgent,
  };
  if (viewport.screenWidth !== undefined) {
    input.screenWidth = viewport.screenWidth;
  }
  if (viewport.screenHeight !== undefined) {
    input.screenHeight = viewport.screenHeight;
  }
  return buildViewportPayload({
    ...input,
  });
}

function boxEquals(a: CssBox | null, b: CssBox | null, tolerancePx = 0.5): boolean {
  if (!(a && b)) {
    return a === b;
  }
  return (
    Math.abs(a.left - b.left) <= tolerancePx &&
    Math.abs(a.top - b.top) <= tolerancePx &&
    Math.abs(a.width - b.width) <= tolerancePx &&
    Math.abs(a.height - b.height) <= tolerancePx
  );
}

function geometryEquals(
  a: StreamViewerSurfaceGeometry | null,
  b: StreamViewerSurfaceGeometry | null,
  tolerancePx = 0.5
): boolean {
  if (!(a && b)) {
    return a === b;
  }
  return (
    boxEquals(a.containerBox, b.containerBox, tolerancePx) &&
    boxEquals(a.displayRect, b.displayRect, tolerancePx) &&
    Math.abs(a.scale - b.scale) <= 0.001 &&
    Math.abs(a.letterboxBars.left - b.letterboxBars.left) <= tolerancePx &&
    Math.abs(a.letterboxBars.right - b.letterboxBars.right) <= tolerancePx &&
    Math.abs(a.letterboxBars.top - b.letterboxBars.top) <= tolerancePx &&
    Math.abs(a.letterboxBars.bottom - b.letterboxBars.bottom) <= tolerancePx &&
    a.isOneToOne === b.isOneToOne &&
    Math.abs(a.viewport.width - b.viewport.width) <= tolerancePx &&
    Math.abs(a.viewport.height - b.viewport.height) <= tolerancePx
  );
}

function containerBoxFromElement(container: HTMLElement): CssBox {
  const rect = container.getBoundingClientRect();
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

function calculateGeometry(
  container: CssBox,
  viewport: StreamViewport
): StreamViewerSurfaceGeometry | null {
  if (container.width <= 0 || container.height <= 0 || viewport.width <= 0 || viewport.height <= 0) {
    return null;
  }
  const displayRect = containedStreamRect(container, viewport);
  const projectedRect = streamViewportRectToClientBox(
    { x: 0, y: 0, width: viewport.width, height: viewport.height },
    { imageBox: container, viewport }
  );
  const resolvedDisplayRect = projectedRect ?? displayRect;
  const scale = resolvedDisplayRect.width / viewport.width;
  return {
    containerBox: container,
    displayRect: resolvedDisplayRect,
    isOneToOne: Math.abs(scale - 1) <= 0.01,
    letterboxBars: {
      left: resolvedDisplayRect.left - container.left,
      right: container.left + container.width - (resolvedDisplayRect.left + resolvedDisplayRect.width),
      top: resolvedDisplayRect.top - container.top,
      bottom: container.top + container.height - (resolvedDisplayRect.top + resolvedDisplayRect.height),
    },
    scale,
    viewport,
  };
}

export function createContainerFitStreamViewerSurface(
  container: HTMLElement,
  viewport: StreamViewerSurfaceViewportInput,
  options: StreamViewerSurfaceOptions = {}
): StreamViewerSurface {
  const listeners = new Set<StreamViewerSurfaceGeometryListener>();
  let activeViewport = normalizeViewport(viewport);
  let currentGeometry: StreamViewerSurfaceGeometry | null = null;
  let disposed = false;

  const observer = (options.resizeObserverFactory ?? defaultResizeObserverFactory)(() => {
    syncGeometry();
  });

  function notify(geometry: StreamViewerSurfaceGeometry | null): void {
    if (!geometry) {
      return;
    }
    for (const listener of listeners) {
      listener(geometry);
    }
    options.onGeometryChange?.(geometry);
  }

  function syncGeometry(): void {
    if (disposed) {
      return;
    }
    const nextGeometry = calculateGeometry(containerBoxFromElement(container), activeViewport);
    if (geometryEquals(currentGeometry, nextGeometry)) {
      return;
    }
    currentGeometry = nextGeometry;
    notify(currentGeometry);
  }

  observer.observe(container);
  syncGeometry();

  return {
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      observer.unobserve(container);
      observer.disconnect();
      listeners.clear();
    },
    getGeometry(): StreamViewerSurfaceGeometry | null {
      return currentGeometry;
    },
    mapClientPointToStream(clientX: number, clientY: number): { x: number; y: number } | null {
      const geometry = currentGeometry;
      if (!geometry) {
        return null;
      }
      return pointToStreamViewport(
        { clientX, clientY },
        {
          containerBox: geometry.containerBox,
          imageBox: geometry.containerBox,
          viewport: geometry.viewport,
        }
      );
    },
    projectStreamViewportRectToClientBox(fieldRect: {
      height: number;
      width: number;
      x: number;
      y: number;
    }): CssBox | null {
      const geometry = currentGeometry;
      if (!geometry) {
        return null;
      }
      return streamViewportRectToClientBox(fieldRect, {
        imageBox: geometry.containerBox,
        viewport: geometry.viewport,
      });
    },
    setViewport(nextViewport: StreamViewerSurfaceViewportInput): void {
      activeViewport = normalizeViewport(nextViewport);
      syncGeometry();
    },
    subscribe(listener: StreamViewerSurfaceGeometryListener): () => void {
      listeners.add(listener);
      if (currentGeometry) {
        listener(currentGeometry);
      }
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
