import assert from "node:assert/strict";
import test from "node:test";
import type { ViewportPayload } from "./geometry.ts";
import type {
  StreamViewerSurface,
  StreamViewerSurfaceGeometry,
  StreamViewerSurfaceGeometryListener,
  StreamViewerSurfaceViewportInput,
} from "./stream-viewer-surface.ts";
import {
  createViewportMatchController,
  type ViewportMatchClock,
} from "./viewport-match-controller.ts";

class FakeClock implements ViewportMatchClock {
  nowMs = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  clearTimeout(handle: unknown): void {
    this.timers.delete(Number(handle));
  }

  now(): number {
    return this.nowMs;
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { at: this.nowMs + delayMs, callback });
    return id;
  }

  tick(ms: number): void {
    this.nowMs += ms;
    const ready = [...this.timers.entries()]
      .filter(([, timer]) => timer.at <= this.nowMs)
      .sort((a, b) => a[1].at - b[1].at);
    for (const [id, timer] of ready) {
      if (!this.timers.has(id)) {
        continue;
      }
      this.timers.delete(id);
      timer.callback();
    }
  }

  get timerCount(): number {
    return this.timers.size;
  }
}

class FakeSurface implements StreamViewerSurface {
  private geometry: StreamViewerSurfaceGeometry | null = null;
  private readonly listeners = new Set<StreamViewerSurfaceGeometryListener>();

  emit(geometry: StreamViewerSurfaceGeometry): void {
    this.geometry = geometry;
    for (const listener of this.listeners) {
      listener(geometry);
    }
  }

  dispose(): void {
    this.listeners.clear();
  }

  getGeometry(): StreamViewerSurfaceGeometry | null {
    return this.geometry;
  }

  mapClientPointToStream(): { x: number; y: number } | null {
    return null;
  }

  projectStreamViewportRectToClientBox(): null {
    return null;
  }

  setViewport(_viewport: StreamViewerSurfaceViewportInput): void {}

  subscribe(listener: StreamViewerSurfaceGeometryListener): () => void {
    this.listeners.add(listener);
    if (this.geometry) {
      listener(this.geometry);
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

function geometry({
  actual = { width: 390, height: 844 },
  container,
}: {
  actual?: { width: number; height: number };
  container: { width: number; height: number };
}): StreamViewerSurfaceGeometry {
  const fills = actual.width === container.width && actual.height === container.height;
  const displayRect = fills
    ? { left: 0, top: 0, width: container.width, height: container.height }
    : { left: 0, top: 60, width: container.width, height: Math.round(container.width * (actual.height / actual.width)) };
  const bars = {
    left: displayRect.left,
    right: container.width - (displayRect.left + displayRect.width),
    top: displayRect.top,
    bottom: container.height - (displayRect.top + displayRect.height),
  };
  return {
    containerBox: { left: 0, top: 0, width: container.width, height: container.height },
    displayRect,
    isOneToOne: false,
    letterboxBars: bars,
    scale: displayRect.width / actual.width,
    viewport: actual,
  };
}

test("posts a debounced layout resize with a normalized target viewport", async () => {
  const clock = new FakeClock();
  const surface = new FakeSurface();
  const applied: ViewportPayload[] = [];
  const controller = createViewportMatchController({
    applyViewport: (viewport) => {
      applied.push(viewport);
    },
    options: {
      clock,
      debounceMs: 200,
      observationFromGeometry: (sample) => ({
        editableFocused: false,
        layout: { width: sample.containerBox.width, height: sample.containerBox.height },
        timestampMs: clock.now(),
      }),
      viewportDefaults: { deviceScaleFactor: 2, hasTouch: true, mobile: true, userAgent: "test-agent" },
    },
    surface,
  });

  surface.emit(geometry({ container: { width: 390.9, height: 844.2 } }));
  assert.equal(applied.length, 0);
  clock.tick(199);
  assert.equal(applied.length, 0);
  clock.tick(1);
  assert.deepEqual(applied, [
    {
      deviceScaleFactor: 2,
      hasTouch: true,
      height: 844,
      mobile: true,
      userAgent: "test-agent",
      width: 390,
    },
  ]);
  controller.dispose();
});

test("suppresses keyboard occlusion resize and keeps telemetry", () => {
  const clock = new FakeClock();
  const surface = new FakeSurface();
  const applied: ViewportPayload[] = [];
  const controller = createViewportMatchController({
    applyViewport: (viewport) => {
      applied.push(viewport);
    },
    options: {
      clock,
      debounceMs: 100,
      observationFromGeometry: (sample) => ({
        editableFocused: true,
        layout: { width: sample.containerBox.width, height: sample.containerBox.height },
        mobile: true,
        timestampMs: clock.now(),
      }),
      viewportDefaults: { deviceScaleFactor: 2, hasTouch: true, mobile: true },
    },
    surface,
  });

  surface.emit(geometry({ actual: { width: 390, height: 844 }, container: { width: 390, height: 844 } }));
  clock.tick(100);
  assert.equal(applied.length, 1);

  surface.emit(geometry({ actual: { width: 390, height: 844 }, container: { width: 390, height: 560 } }));
  clock.tick(200);

  assert.equal(applied.length, 1);
  const telemetry = controller.getTelemetry();
  assert.equal(telemetry.transition?.kind, "keyboard-occlusion");
  assert.equal(telemetry.transition?.remoteResize, "hold");
  assert.equal(telemetry.matched, false);
  assert.ok(telemetry.maxLetterboxPx > 0);
  controller.dispose();
});

test("coalesces layout resize bursts and applies the snap hook", () => {
  const clock = new FakeClock();
  const surface = new FakeSurface();
  const applied: ViewportPayload[] = [];
  createViewportMatchController({
    applyViewport: (viewport) => {
      applied.push(viewport);
    },
    options: {
      clock,
      debounceMs: 150,
      observationFromGeometry: (sample) => ({
        editableFocused: false,
        layout: { width: sample.containerBox.width, height: sample.containerBox.height },
        timestampMs: clock.now(),
      }),
      snapViewport: (viewport) => ({
        ...viewport,
        height: Math.round(viewport.height / 10) * 10,
        width: Math.round(viewport.width / 10) * 10,
      }),
    },
    surface,
  });

  surface.emit(geometry({ container: { width: 401, height: 701 } }));
  clock.tick(75);
  surface.emit(geometry({ container: { width: 412, height: 734 } }));
  clock.tick(149);
  assert.equal(applied.length, 0);
  clock.tick(1);
  assert.equal(applied.length, 1);
  assert.equal(applied[0]?.width, 410);
  assert.equal(applied[0]?.height, 730);
});

test("posts orientation changes after debounce", () => {
  const clock = new FakeClock();
  const surface = new FakeSurface();
  const applied: ViewportPayload[] = [];
  createViewportMatchController({
    applyViewport: (viewport) => {
      applied.push(viewport);
    },
    options: {
      clock,
      debounceMs: 80,
      observationFromGeometry: (sample) => ({
        editableFocused: false,
        layout: { width: sample.containerBox.width, height: sample.containerBox.height },
        mobile: true,
        orientation: sample.containerBox.width > sample.containerBox.height
          ? { angle: 90, type: "landscape-primary" }
          : { angle: 0, type: "portrait-primary" },
        timestampMs: clock.now(),
      }),
    },
    surface,
  });

  surface.emit(geometry({ container: { width: 390, height: 844 } }));
  clock.tick(80);
  surface.emit(geometry({ container: { width: 844, height: 390 } }));
  clock.tick(80);
  assert.deepEqual(applied.map((item) => ({ width: item.width, height: item.height })), [
    { width: 390, height: 844 },
    { width: 844, height: 390 },
  ]);
});

test("reports matched when actual viewport fills the container", () => {
  const clock = new FakeClock();
  const surface = new FakeSurface();
  const controller = createViewportMatchController({
    applyViewport: () => {},
    options: {
      clock,
      matchedThresholdPx: 2,
      observationFromGeometry: (sample) => ({
        editableFocused: false,
        layout: { width: sample.containerBox.width, height: sample.containerBox.height },
        timestampMs: clock.now(),
      }),
    },
    surface,
  });

  surface.emit(geometry({ actual: { width: 390, height: 844 }, container: { width: 420, height: 844 } }));
  assert.equal(controller.getTelemetry().matched, false);
  surface.emit(geometry({ actual: { width: 420, height: 844 }, container: { width: 420, height: 844 } }));
  assert.equal(controller.getTelemetry().matched, true);
  assert.equal(controller.getTelemetry().maxLetterboxPx, 0);
});

test("dispose clears timers, listeners, and future applies", () => {
  const clock = new FakeClock();
  const surface = new FakeSurface();
  let applyCount = 0;
  const controller = createViewportMatchController({
    applyViewport: () => {
      applyCount += 1;
    },
    options: {
      clock,
      debounceMs: 100,
      observationFromGeometry: (sample) => ({
        editableFocused: false,
        layout: { width: sample.containerBox.width, height: sample.containerBox.height },
        timestampMs: clock.now(),
      }),
    },
    surface,
  });

  assert.equal(surface.listenerCount, 1);
  surface.emit(geometry({ container: { width: 500, height: 700 } }));
  assert.equal(clock.timerCount, 1);
  controller.dispose();
  assert.equal(surface.listenerCount, 0);
  assert.equal(clock.timerCount, 0);
  clock.tick(500);
  surface.emit(geometry({ container: { width: 700, height: 500 } }));
  clock.tick(500);
  assert.equal(applyCount, 0);
});
