import assert from "node:assert/strict";
import test from "node:test";
import {
  createContainerFitStreamViewerSurface,
  type StreamViewerSurfaceGeometry,
  type StreamViewerResizeObserver,
  type StreamViewerResizeObserverFactory,
} from "./stream-viewer-surface.ts";

type MutableRect = { height: number; left: number; top: number; width: number };

class FakeResizeObserver implements StreamViewerResizeObserver {
  observed: Set<Element>;
  private readonly callback: () => void;

  constructor(callback: () => void) {
    this.callback = callback;
    this.observed = new Set<Element>();
  }

  disconnect(): void {
    this.observed.clear();
  }

  observe(target: Element): void {
    this.observed.add(target);
  }

  trigger(): void {
    this.callback();
  }

  unobserve(target: Element): void {
    this.observed.delete(target);
  }
}

function createSurfaceHarness({
  viewport = { height: 720, width: 1280 },
  rect,
}: {
  rect: MutableRect;
  viewport?: { height: number; width: number };
}) {
  let currentRect = rect;
  const container = {
    getBoundingClientRect(): MutableRect {
      return currentRect;
    },
  } as unknown as HTMLElement;
  let observer: FakeResizeObserver | null = null;
  const factory: StreamViewerResizeObserverFactory = (callback) => {
    observer = new FakeResizeObserver(callback);
    return observer;
  };
  const surface = createContainerFitStreamViewerSurface(container, viewport, { resizeObserverFactory: factory });
  if (!observer) {
    throw new Error("resize observer was not created");
  }
  return {
    observer: observer as FakeResizeObserver,
    setRect(nextRect: MutableRect) {
      currentRect = nextRect;
    },
    surface,
  };
}

function approx(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function assertGeometry(
  geometry: StreamViewerSurfaceGeometry | null,
  expected: {
    bars: { bottom: number; left: number; right: number; top: number };
    displayRect: MutableRect;
    scale: number;
    viewport: { height: number; width: number };
  }
): void {
  assert.ok(geometry);
  assert.deepEqual(
    {
      bottom: approx(geometry.letterboxBars.bottom),
      left: approx(geometry.letterboxBars.left),
      right: approx(geometry.letterboxBars.right),
      top: approx(geometry.letterboxBars.top),
    },
    {
      bottom: approx(expected.bars.bottom),
      left: approx(expected.bars.left),
      right: approx(expected.bars.right),
      top: approx(expected.bars.top),
    }
  );
  assert.deepEqual(
    {
      height: approx(geometry.displayRect.height),
      left: approx(geometry.displayRect.left),
      top: approx(geometry.displayRect.top),
      width: approx(geometry.displayRect.width),
    },
    {
      height: approx(expected.displayRect.height),
      left: approx(expected.displayRect.left),
      top: approx(expected.displayRect.top),
      width: approx(expected.displayRect.width),
    }
  );
  assert.deepEqual(
    { height: geometry.viewport.height, width: geometry.viewport.width },
    expected.viewport
  );
  assert.equal(approx(geometry.scale), approx(expected.scale));
}

test("container-fit surface tracks geometry and pointer mapping across resize updates", () => {
  let rect = { left: 100, top: 50, width: 1200, height: 675 };
  const { observer, setRect, surface } = createSurfaceHarness({ rect });
  const updates: Array<{ height: number; width: number }> = [];
  surface.subscribe((geometry) => {
    updates.push({ height: geometry.displayRect.height, width: geometry.displayRect.width });
  });

  assert.equal(observer.observed.size, 1);
  assert.equal(updates.length, 1);
  assertGeometry(surface.getGeometry(), {
    bars: { left: 0, right: 0, top: 0, bottom: 0 },
    displayRect: { left: 100, top: 50, width: 1200, height: 675 },
    scale: 1200 / 1280,
    viewport: { width: 1280, height: 720 },
  });
  assert.deepEqual(surface.mapClientPointToStream(700, 387.5), { x: 640, y: 360 });
  assert.deepEqual(surface.projectStreamViewportRectToClientBox({ x: 0, y: 0, width: 1280, height: 720 }), {
    left: 100,
    top: 50,
    width: 1200,
    height: 675,
  });

  setRect({ left: 40, top: 20, width: 420, height: 900 });
  observer.trigger();
  assert.equal(updates.length, 2);
  assertGeometry(surface.getGeometry(), {
    bars: { left: 0, right: 0, top: 331.875, bottom: 331.875 },
    displayRect: { left: 40, top: 351.875, width: 420, height: 236.25 },
    scale: 0.328125,
    viewport: { width: 1280, height: 720 },
  });
  assert.deepEqual(surface.mapClientPointToStream(250, 470), { x: 640, y: 360 });
  assert.equal(surface.mapClientPointToStream(250, 60), null);

  setRect({ left: 8, top: 12, width: 37, height: 41 });
  surface.setViewport({ width: 390, height: 844, mobile: true, hasTouch: true, deviceScaleFactor: 3 });
  observer.trigger();
  assert.equal(updates.length, 3);
  const tinyScale = 41 / 844;
  const tinyDisplayWidth = 390 * tinyScale;
  assertGeometry(surface.getGeometry(), {
    bars: {
      left: (37 - tinyDisplayWidth) / 2,
      right: (37 - tinyDisplayWidth) / 2,
      top: 0,
      bottom: 0,
    },
    displayRect: {
      left: 8 + (37 - tinyDisplayWidth) / 2,
      top: 12,
      width: tinyDisplayWidth,
      height: 41,
    },
    scale: tinyScale,
    viewport: { width: 390, height: 844 },
  });
  assert.deepEqual(surface.mapClientPointToStream(26.5, 32.5), { x: 195, y: 422 });

  surface.dispose();
  setRect({ left: 0, top: 0, width: 960, height: 120 });
  observer.trigger();
  assert.equal(updates.length, 3);
});
