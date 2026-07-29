#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

// patchright is a polyfill-connectors dependency, not a root dependency; its
// types are not resolvable from this file's module graph (same reasoning as
// docs/explorer/uat/harness/capture.ts), so the browser surface below is
// narrowed to the handful of methods this smoke actually calls.
interface PatchrightBoundingBox {
  height: number;
  width: number;
  x: number;
  y: number;
}
interface PatchrightViewportSize {
  height: number;
  width: number;
}
interface PatchrightLocator {
  boundingBox: () => Promise<PatchrightBoundingBox | null>;
  click: () => Promise<void>;
  evaluate: <T, Arg>(fn: (node: HTMLElement, arg: Arg) => T, arg: Arg) => Promise<T>;
  fill: (value: string) => Promise<void>;
  first: () => PatchrightLocator;
  screenshot: () => Promise<Buffer>;
  waitFor: (options: { state: string; timeout: number }) => Promise<void>;
}
interface PatchrightKeyboard {
  press: (key: string) => Promise<void>;
  type: (text: string, options?: { delay: number }) => Promise<void>;
}
interface PatchrightMouse {
  click: (x: number, y: number) => Promise<void>;
  move: (x: number, y: number) => Promise<void>;
  wheel: (deltaX: number, deltaY: number) => Promise<void>;
}
interface PatchrightTouchscreen {
  tap: (x: number, y: number) => Promise<void>;
}
interface PatchrightRequestFailure {
  errorText: string;
}
interface PatchrightRequest {
  failure: () => PatchrightRequestFailure | null;
  method: () => string;
  postData: () => string | null;
  resourceType: () => string;
  url: () => string;
}
interface PatchrightResponse {
  request: () => PatchrightRequest;
  status: () => number;
  text: () => Promise<string>;
}
interface PatchrightConsoleMessage {
  text: () => string;
  type: () => string;
}
type PatchrightPageEventArg<Name extends string> = Name extends "request" | "requestfailed"
  ? PatchrightRequest
  : Name extends "response"
    ? PatchrightResponse
    : Name extends "console"
      ? PatchrightConsoleMessage
      : never;
interface PatchrightPage {
  addInitScript: (fn: () => void) => Promise<void>;
  evaluate: <T, Arg = undefined>(fn: (arg: Arg) => T | Promise<T>, arg?: Arg) => Promise<T>;
  getByRole: (role: string, options: { name: RegExp | string }) => PatchrightLocator;
  goto: (url: string, options: { timeout: number; waitUntil: string }) => Promise<unknown>;
  keyboard: PatchrightKeyboard;
  locator: (selector: string) => PatchrightLocator;
  mouse: PatchrightMouse;
  on: <Name extends "console" | "request" | "requestfailed" | "response">(
    event: Name,
    listener: (arg: PatchrightPageEventArg<Name>) => void
  ) => void;
  screenshot: (options?: { clip?: PatchrightBoundingBox; fullPage?: boolean; path?: string }) => Promise<Buffer>;
  setViewportSize: (size: PatchrightViewportSize) => Promise<void>;
  touchscreen: PatchrightTouchscreen;
  url: () => string;
  viewportSize: () => PatchrightViewportSize;
  waitForTimeout: (ms: number) => Promise<void>;
  waitForURL: (url: RegExp | string, options: { timeout: number }) => Promise<void>;
}
interface PatchrightBrowser {
  close: () => Promise<void>;
  newPage: (options: {
    deviceScaleFactor: number;
    hasTouch: boolean;
    isMobile: boolean;
    viewport: PatchrightViewportSize;
  }) => Promise<PatchrightPage>;
}
interface PatchrightModule {
  chromium: {
    launch: (options: { executablePath?: string; headless: boolean }) => Promise<PatchrightBrowser>;
  };
}

interface DebugEvent {
  __smokeSequence: number;
  payload?: Record<string, unknown>;
  receivedAt?: string;
  type?: string;
  viewerId?: string;
  [key: string]: unknown;
}

interface RequestFailureEvidence {
  failure: string;
  method: string;
  resourceType: string;
  url: string;
}
interface HttpFailureEvidence {
  method: string;
  resourceType: string;
  status: number;
  url: string;
}
interface ConsoleErrorEvidence {
  text: string;
  type: string;
}
interface RequestEvidence {
  consoleErrors: ConsoleErrorEvidence[];
  eventStreamErrors: unknown[];
  failedRequests: RequestFailureEvidence[];
  httpFailures: HttpFailureEvidence[];
  nekoHttpFailures: HttpFailureEvidence[];
}

interface StreamPixelStats {
  bright: number;
  brightRatio: number;
  nearBlack: number;
  nearBlackRatio: number;
  sampled: boolean;
  total: number;
}

interface StreamFailureSignature {
  hasErrorAffordance: boolean;
  hasFirstFrameSignal: boolean;
  hasRasterMedia: boolean;
}

const STREAM_FAILURE_SIGNATURE_PATTERNS = {
  inlineError: "n\\.eko WebRTC stream did not attach|secure browser viewport could not be applied",
  reachFailure:
    "couldn['’]t reach the browser stream|browser stream failed to start|browser stream isn['’]t available|n\\.eko browser window did not settle",
  retryAffordance: "retry secure browser",
} as const;

interface RemotePoint {
  x: number;
  y: number;
}
interface RemoteViewport {
  height: number;
  width: number;
}
interface RemoteControlTarget {
  controlId: string;
  remotePoint: RemotePoint;
  remoteViewport: RemoteViewport;
  sourceType: string;
}

interface VisualChangeDiff {
  changedPixels: number;
  changedRatio: number;
  height: number;
  meanRgbDelta: number;
  width: number;
}

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(import.meta.url);

const DEFAULT_TIMEOUT_MS = 90_000;
const DEBUG_EVENT_BUFFER_MAX = 2000;
const STREAM_FRAME_SELECTOR = '[aria-label="Connector browser stream"]';
const EVIDENCE_DIR = path.join(repoRoot, "tmp", "stream-smoke");
const STRICT_SMOKE_TOKEN = "pdpp-smoke";
const MOBILE_SMOKE = "1";
const OWNER_LOGIN_URL_PATTERN = /\/owner\/login(?:\?|$)/;
const STREAM_PLAYGROUND_URL_PATTERN = /\/stream-playground/;
const SIGN_IN_BUTTON_NAME_PATTERN = /sign in/i;
const OPEN_BROWSER_BUTTON_NAME_PATTERN = /open browser/i;
const TAP_TO_TYPE_BUTTON_NAME_PATTERN = /tap to type/i;
const EVENT_STREAM_ERROR_LINE_PATTERN = /^event: error\ndata: (.+)$/m;

function env(name: string): string | null {
  const value = process.env[name];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function publicUrlFromEnv(): string | null {
  return env("PDPP_STREAM_SMOKE_URL") || env("PDPP_PUBLIC_URL") || env("PDPP_REFERENCE_ORIGIN");
}

function mobileSmokeEnabled(): boolean {
  return env("PDPP_STREAM_SMOKE_MOBILE") === MOBILE_SMOKE;
}

function appendEvidence<T>(list: T[], entry: T): void {
  if (list.length < 50) {
    list.push(entry);
  }
}

function redactRequestUrl(value: string | URL): string {
  try {
    const url = new URL(value.toString());
    for (const name of ["token", "access_token", "id_token", "code"]) {
      if (url.searchParams.has(name)) {
        url.searchParams.set(name, "[redacted]");
      }
    }
    return url.toString();
  } catch {
    return String(value);
  }
}

function browserExecutablePath(): string | null {
  return env("PDPP_STREAM_SMOKE_BROWSER_EXECUTABLE_PATH");
}

function smokeUrl(origin: string): string {
  const url = new URL("/stream-playground", origin);
  url.searchParams.set("backend", env("PDPP_STREAM_SMOKE_BACKEND") || "neko");
  url.searchParams.set("stream_debug", "1");
  return url.toString();
}

function skip(message: string): void {
  process.stdout.write(`SKIP manual-action stream smoke: ${message}\n`);
}

function fail(message: string): never {
  throw new Error(`FAIL manual-action stream smoke: ${message}`);
}

export function isKnownBlackFrameFailure(pixels: StreamPixelStats, signature: StreamFailureSignature): boolean {
  const uniformlyBlack = pixels.sampled && pixels.nearBlackRatio >= 0.995 && pixels.brightRatio <= 0.002;
  // A remote page may legitimately be dark. The regression is the absence of
  // the first decoded frame in combination with a uniformly black stream
  // raster and a visible stream failure affordance. A merely-loading black
  // surface has no affordance and is not this failure signature.
  return uniformlyBlack && signature.hasErrorAffordance && !signature.hasFirstFrameSignal;
}

function parseDebugEventsFromPostData(postData: string | null): DebugEvent[] {
  if (!postData) {
    return [];
  }
  try {
    const parsed = JSON.parse(postData) as { events?: unknown };
    return Array.isArray(parsed.events) ? (parsed.events as DebugEvent[]) : [];
  } catch {
    return [];
  }
}

function eventType(event: DebugEvent | null): string {
  if (!event) {
    return "";
  }
  if (typeof event.type === "string") {
    return event.type;
  }
  return typeof event.name === "string" ? (event.name as string) : "";
}

function eventPayload(event: DebugEvent | null): Record<string, unknown> {
  return event?.payload && typeof event.payload === "object" ? event.payload : {};
}

function hasEvent(
  events: DebugEvent[],
  predicate: (event: DebugEvent, payload: Record<string, unknown>, type: string) => boolean
): boolean {
  return events.some((event) => {
    try {
      return predicate(event, eventPayload(event), eventType(event));
    } catch {
      return false;
    }
  });
}

function hasEventAfter(
  events: DebugEvent[],
  sequence: number,
  predicate: (event: DebugEvent, payload: Record<string, unknown>, type: string) => boolean
): boolean {
  return hasEvent(
    events,
    (event, payload, type) => event.__smokeSequence > sequence && predicate(event, payload, type)
  );
}

function eventSummary(event: DebugEvent) {
  const payload = eventPayload(event);
  return {
    type: eventType(event),
    viewerId: typeof event.viewerId === "string" ? event.viewerId : null,
    receivedAt: typeof event.receivedAt === "string" ? event.receivedAt : null,
    payload: summarizePayload(payload),
  };
}

const SUMMARIZABLE_PAYLOAD_KEYS = new Set([
  "type",
  "status",
  "count",
  "clientX",
  "clientY",
  "pageX",
  "pageY",
  "innerWidth",
  "innerHeight",
  "devicePixelRatio",
  "scrollX",
  "scrollY",
  "pageId",
  "seq",
  "backend",
  "runId",
  "interactionId",
  "smokeTokenPresent",
  "valueLength",
  "target",
  "elementAtPoint",
  "activeElement",
  "calibration",
  "controls",
  "beacons",
  "visualViewport",
  "error",
  "eventType",
  "insideMedia",
  "insideOverlay",
  "insideWrapper",
  "mapped",
  "mappingBasis",
  "pageCdpAvailable",
  "reason",
  "reasons",
  "result",
  "screen",
  "strictSafe",
  "viewport",
]);

function summarizePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (SUMMARIZABLE_PAYLOAD_KEYS.has(key)) {
      out[key] = value;
    }
  }
  return out;
}

function latestEvent(
  events: DebugEvent[],
  predicate: (event: DebugEvent, payload: Record<string, unknown>, type: string) => boolean
): DebugEvent | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event && predicate(event, eventPayload(event), eventType(event))) {
      return event;
    }
  }
  return null;
}

function latestRemoteLayoutEvent(events: DebugEvent[]): DebugEvent | null {
  return latestEvent(
    events,
    (_event, payload, type) =>
      (type === "playground.ready" || type === "playground.calibration_init") &&
      Boolean(payload.controls) &&
      typeof payload.controls === "object"
  );
}

function latestNekoPageCdpAvailability(events: DebugEvent[]): boolean | null {
  const event = latestEvent(
    events,
    (_event, payload, type) => type === "neko.status.poll" && typeof payload.pageCdpAvailable === "boolean"
  );
  return event ? (eventPayload(event).pageCdpAvailable as boolean) : null;
}

function latestNekoStatusViewport(events: DebugEvent[]): RemoteViewport | null {
  const event = latestEvent(
    events,
    (_event, payload, type) => type === "neko.status.poll" && Boolean(payload.viewport)
  );
  const viewport = event ? (eventPayload(event).viewport as { height?: unknown; width?: unknown } | null) : null;
  const width = Number(viewport?.width);
  const height = Number(viewport?.height);
  return Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0 ? { width, height } : null;
}

function hasHealthyNekoPointerMapping(events: DebugEvent[]): boolean {
  return hasEvent(
    events,
    (_event, payload, type) =>
      type === "neko.pointer_mapping" &&
      (payload.eventType === "pointerdown" || payload.eventType === "mousedown") &&
      Boolean(payload.mapped) &&
      typeof payload.mapped === "object" &&
      payload.insideOverlay === true &&
      !hasEvent(
        events,
        (_issueEvent, issuePayload, issueType) =>
          issueType === "neko.pointer_mapping.issue" &&
          Array.isArray(issuePayload.reasons) &&
          issuePayload.reasons.length > 0
      )
  );
}

function resolveRemoteControlTarget(events: DebugEvent[], controlId: string): RemoteControlTarget | null {
  const layoutEvent = latestRemoteLayoutEvent(events);
  const payload = layoutEvent ? eventPayload(layoutEvent) : null;
  const controls = payload?.controls as Record<string, { centre?: RemotePoint }> | undefined;
  const control = controls?.[controlId];
  const centre = control?.centre;
  const visualViewport = payload?.visualViewport as { height?: unknown; width?: unknown } | undefined;
  const remoteWidth = Number(visualViewport?.width ?? payload?.innerWidth);
  const remoteHeight = Number(visualViewport?.height ?? payload?.innerHeight);
  if (
    centre &&
    Number.isFinite(centre.x) &&
    Number.isFinite(centre.y) &&
    Number.isFinite(remoteWidth) &&
    remoteWidth > 0 &&
    Number.isFinite(remoteHeight) &&
    remoteHeight > 0
  ) {
    return {
      sourceType: eventType(layoutEvent),
      controlId,
      remotePoint: { x: centre.x, y: centre.y },
      remoteViewport: { width: remoteWidth, height: remoteHeight },
    };
  }
  return null;
}

function containedStreamRect(imageBox: PatchrightBoundingBox, viewport: RemoteViewport): PatchrightBoundingBox {
  const aspectRatio = viewport.width / viewport.height;
  const boxRatio = imageBox.width / imageBox.height;
  if (!(Number.isFinite(aspectRatio) && Number.isFinite(boxRatio)) || imageBox.width <= 0 || imageBox.height <= 0) {
    return imageBox;
  }
  if (boxRatio > aspectRatio) {
    const width = imageBox.height * aspectRatio;
    return {
      x: imageBox.x + (imageBox.width - width) / 2,
      y: imageBox.y,
      width,
      height: imageBox.height,
    };
  }
  const height = imageBox.width / aspectRatio;
  return {
    x: imageBox.x,
    y: imageBox.y + (imageBox.height - height) / 2,
    width: imageBox.width,
    height,
  };
}

function mapRemoteRectToLocalClip(
  contentRect: PatchrightBoundingBox,
  remoteRect: PatchrightBoundingBox,
  remoteViewport: RemoteViewport
): PatchrightBoundingBox {
  const x = contentRect.x + (contentRect.width * remoteRect.x) / remoteViewport.width;
  const y = contentRect.y + (contentRect.height * remoteRect.y) / remoteViewport.height;
  const width = (contentRect.width * remoteRect.width) / remoteViewport.width;
  const height = (contentRect.height * remoteRect.height) / remoteViewport.height;
  return {
    x: Math.max(0, Math.floor(x)),
    y: Math.max(0, Math.floor(y)),
    width: Math.max(1, Math.ceil(width)),
    height: Math.max(1, Math.ceil(height)),
  };
}

function strictVisualInputTarget(remoteViewport: RemoteViewport): {
  clickPoint: RemotePoint;
  cropRect: PatchrightBoundingBox;
} {
  if (remoteViewport.width > remoteViewport.height && remoteViewport.height <= 672) {
    // The debug playground switches to a two-column landscape layout. The
    // input occupies the second row of the right column.
    return {
      clickPoint: { x: remoteViewport.width * 0.51, y: remoteViewport.height * 0.12 },
      cropRect: {
        x: remoteViewport.width * 0.34,
        y: remoteViewport.height * 0.075,
        width: remoteViewport.width * 0.36,
        height: remoteViewport.height * 0.09,
      },
    };
  }
  return {
    clickPoint: { x: remoteViewport.width * 0.5, y: remoteViewport.height * 0.28 },
    cropRect: {
      x: remoteViewport.width * 0.08,
      y: remoteViewport.height * 0.235,
      width: remoteViewport.width * 0.84,
      height: remoteViewport.height * 0.095,
    },
  };
}

function normalizeClipToViewport(
  clip: PatchrightBoundingBox,
  viewportSize: PatchrightViewportSize | null
): PatchrightBoundingBox {
  const maxWidth = viewportSize?.width || clip.x + clip.width;
  const maxHeight = viewportSize?.height || clip.y + clip.height;
  const x = Math.max(0, Math.min(Math.floor(clip.x), Math.max(0, maxWidth - 1)));
  const y = Math.max(0, Math.min(Math.floor(clip.y), Math.max(0, maxHeight - 1)));
  return {
    x,
    y,
    width: Math.max(1, Math.min(Math.ceil(clip.width), maxWidth - x)),
    height: Math.max(1, Math.min(Math.ceil(clip.height), maxHeight - y)),
  };
}

async function captureStreamRemoteRect(
  page: PatchrightPage,
  remoteRect: PatchrightBoundingBox,
  remoteViewport: RemoteViewport
): Promise<{ clip: PatchrightBoundingBox; png: Buffer }> {
  const contentRect = await streamContentRect(page, remoteViewport);
  const clip = normalizeClipToViewport(
    mapRemoteRectToLocalClip(contentRect, remoteRect, remoteViewport),
    page.viewportSize()
  );
  return {
    clip,
    png: await page.screenshot({ clip }),
  };
}

function comparePngVisualChange(page: PatchrightPage, beforePng: Buffer, afterPng: Buffer): Promise<VisualChangeDiff> {
  return page.evaluate(
    async ({ beforeDataUrl, afterDataUrl }) => {
      async function decode(dataUrl: string): Promise<HTMLImageElement> {
        const img = new Image();
        img.decoding = "sync";
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject(new Error("failed to decode smoke screenshot"));
          img.src = dataUrl;
        });
        return img;
      }
      const before = await decode(beforeDataUrl);
      const after = await decode(afterDataUrl);
      const width = Math.min(before.naturalWidth, after.naturalWidth);
      const height = Math.min(before.naturalHeight, after.naturalHeight);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) {
        throw new Error("2d canvas unavailable for smoke screenshot diff");
      }
      context.drawImage(before, 0, 0, width, height);
      const a = context.getImageData(0, 0, width, height).data;
      context.clearRect(0, 0, width, height);
      context.drawImage(after, 0, 0, width, height);
      const b = context.getImageData(0, 0, width, height).data;
      let changedPixels = 0;
      let totalDelta = 0;
      const pixels = width * height;
      for (let i = 0; i < a.length; i += 4) {
        const aRed = a[i] ?? 0;
        const aGreen = a[i + 1] ?? 0;
        const aBlue = a[i + 2] ?? 0;
        const bRed = b[i] ?? 0;
        const bGreen = b[i + 1] ?? 0;
        const bBlue = b[i + 2] ?? 0;
        const delta = Math.abs(aRed - bRed) + Math.abs(aGreen - bGreen) + Math.abs(aBlue - bBlue);
        totalDelta += delta;
        if (delta >= 36) {
          changedPixels += 1;
        }
      }
      return {
        width,
        height,
        changedPixels,
        changedRatio: pixels > 0 ? changedPixels / pixels : 0,
        meanRgbDelta: pixels > 0 ? totalDelta / pixels : 0,
      };
    },
    {
      beforeDataUrl: `data:image/png;base64,${beforePng.toString("base64")}`,
      afterDataUrl: `data:image/png;base64,${afterPng.toString("base64")}`,
    }
  );
}

async function streamFrameReport(page: PatchrightPage) {
  const frame = page.locator(STREAM_FRAME_SELECTOR).first();
  const box = await frame.boundingBox().catch(() => null);
  const attrs = await frame
    .evaluate<{ debug: string | null; height: number; loading: string | null; width: number }, undefined>(
      (node) => ({
        loading: node.getAttribute("data-pdpp-stream-loading"),
        debug: node.getAttribute("data-pdpp-stream-debug"),
        width: node.clientWidth,
        height: node.clientHeight,
      }),
      undefined
    )
    .catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
  return { box, attrs };
}

async function streamFramePixelStats(page: PatchrightPage): Promise<StreamPixelStats> {
  const frame = page.locator(STREAM_FRAME_SELECTOR).first();
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: direct mechanical port of the pre-existing pixel-sampling probe body, unchanged from the .mjs source
  const mediaPixels = await frame.evaluate<StreamPixelStats, undefined>((node) => {
    const media = node.querySelector("video, canvas");
    if (!media) {
      return { sampled: false, bright: 0, brightRatio: 0, nearBlack: 0, nearBlackRatio: 0, total: 0 };
    }
    const canvas = document.createElement("canvas");
    const sourceWidth = media instanceof HTMLVideoElement ? media.videoWidth : (media as HTMLCanvasElement).width;
    const sourceHeight = media instanceof HTMLVideoElement ? media.videoHeight : (media as HTMLCanvasElement).height;
    if (!(sourceWidth > 0 && sourceHeight > 0)) {
      return { sampled: false, bright: 0, brightRatio: 0, nearBlack: 0, nearBlackRatio: 0, total: 0 };
    }
    const scale = Math.min(1, 240 / Math.max(sourceWidth, sourceHeight));
    canvas.width = Math.max(1, Math.floor(sourceWidth * scale));
    canvas.height = Math.max(1, Math.floor(sourceHeight * scale));
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) {
      throw new Error("stream pixel probe could not create a 2d context");
    }
    context.drawImage(media as CanvasImageSource, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let nearBlack = 0;
    let bright = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      const red = pixels[index] ?? 0;
      const green = pixels[index + 1] ?? 0;
      const blue = pixels[index + 2] ?? 0;
      if (red <= 12 && green <= 12 && blue <= 12) {
        nearBlack += 1;
      }
      if (red >= 48 || green >= 48 || blue >= 48) {
        bright += 1;
      }
    }
    const total = pixels.length / 4;
    return {
      bright,
      brightRatio: bright / total,
      nearBlack,
      nearBlackRatio: nearBlack / total,
      sampled: true,
      total,
    };
  }, undefined);
  if (mediaPixels.sampled) {
    return mediaPixels;
  }

  // The known failure can tear the media node down entirely while leaving the
  // stream rectangle black. Sample its exposed rectangle itself, not arbitrary
  // page pixels. PDPP instruction/error controls are painted over that same
  // rectangle, so exclude their intersections rather than diluting a black
  // stream with readable UI copy.
  const excludedRects = await frame.evaluate<{ bottom: number; left: number; right: number; top: number }[], undefined>(
    (node) => {
      const frameRect = node.getBoundingClientRect();
      return [...document.querySelectorAll("[data-pdpp-stream-ui]")]
        .map((element) => element.getBoundingClientRect())
        .map((rect) => ({
          bottom: Math.min(frameRect.bottom, rect.bottom) - frameRect.top,
          left: Math.max(frameRect.left, rect.left) - frameRect.left,
          right: Math.min(frameRect.right, rect.right) - frameRect.left,
          top: Math.max(frameRect.top, rect.top) - frameRect.top,
        }))
        .filter((rect) => rect.right > rect.left && rect.bottom > rect.top);
    },
    undefined
  );
  const png = await frame.screenshot();
  return page.evaluate(
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: direct mechanical port of the pre-existing pixel-sampling probe body, unchanged from the .mjs source
    async ({ dataUrl, excludedRects: rects }) => {
      const image = new Image();
      image.decoding = "sync";
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("failed to decode stream-frame screenshot"));
        image.src = dataUrl;
      });
      const canvas = document.createElement("canvas");
      const scale = Math.min(1, 240 / Math.max(image.naturalWidth, image.naturalHeight));
      canvas.width = Math.max(1, Math.floor(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.floor(image.naturalHeight * scale));
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) {
        throw new Error("stream-frame screenshot pixel probe could not create a 2d context");
      }
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let nearBlack = 0;
      let bright = 0;
      let total = 0;
      // The outer 10%/bottom quarter belongs to chrome, dock, and transient
      // stream controls. Judge the exposed central presentation raster; it is
      // the part that was visibly all-black in the regression screenshot.
      const presentation = {
        bottom: image.naturalHeight * 0.75,
        left: image.naturalWidth * 0.1,
        right: image.naturalWidth * 0.9,
        top: image.naturalHeight * 0.1,
      };
      for (let index = 0; index < pixels.length; index += 4) {
        const pixel = index / 4;
        const x = ((pixel % canvas.width) + 0.5) * (image.naturalWidth / canvas.width);
        const y = (Math.floor(pixel / canvas.width) + 0.5) * (image.naturalHeight / canvas.height);
        if (x < presentation.left || x >= presentation.right || y < presentation.top || y >= presentation.bottom) {
          continue;
        }
        if (rects.some((rect) => x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom)) {
          continue;
        }
        const red = pixels[index] ?? 0;
        const green = pixels[index + 1] ?? 0;
        const blue = pixels[index + 2] ?? 0;
        if (red <= 12 && green <= 12 && blue <= 12) {
          nearBlack += 1;
        }
        if (red >= 48 || green >= 48 || blue >= 48) {
          bright += 1;
        }
        total += 1;
      }
      return {
        bright,
        brightRatio: total > 0 ? bright / total : 0,
        nearBlack,
        nearBlackRatio: total > 0 ? nearBlack / total : 0,
        sampled: total > 0,
        total,
      };
    },
    { dataUrl: `data:image/png;base64,${png.toString("base64")}`, excludedRects }
  );
}

function streamFailureSignature(page: PatchrightPage): Promise<StreamFailureSignature> {
  const frame = page.locator(STREAM_FRAME_SELECTOR).first();
  return frame.evaluate<StreamFailureSignature, typeof STREAM_FAILURE_SIGNATURE_PATTERNS>((node, patterns) => {
    const media = node.querySelector("video, canvas");
    const video = media instanceof HTMLVideoElement ? media : null;
    const inlineErrorPattern = new RegExp(patterns.inlineError, "i");
    const retryAffordancePattern = new RegExp(patterns.retryAffordance, "i");
    const reachFailurePattern = new RegExp(patterns.reachFailure, "i");
    const inlineError = [...node.querySelectorAll("[data-pdpp-stream-ui]")].some((element) =>
      inlineErrorPattern.test(element.textContent || "")
    );
    const retryAffordance = [...node.querySelectorAll("button")].some((button) =>
      retryAffordancePattern.test(button.textContent || "")
    );
    const bodyText = document.body?.innerText || "";
    const reachFailure = reachFailurePattern.test(bodyText);
    return {
      hasErrorAffordance: Boolean(inlineError || retryAffordance || reachFailure),
      // A video can validly show a dark page. Its decoded, advancing frame is
      // the distinguishing signal that keeps dark content from looking like a
      // black-frame failure.
      hasFirstFrameSignal: Boolean(
        video &&
          video.videoWidth > 0 &&
          video.videoHeight > 0 &&
          video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
          video.currentTime > 0
      ),
      hasRasterMedia: Boolean(media),
    };
  }, STREAM_FAILURE_SIGNATURE_PATTERNS);
}

async function assertKnownBlackFrameFailureAbsent(page: PatchrightPage) {
  const pixels = await streamFramePixelStats(page);
  const signature = await streamFailureSignature(page);
  // This is deliberately narrower than "the stream has dark pixels." The
  // regression signature is a uniformly black raster *and* the stream's
  // visible failure affordance with no first decoded frame. A real dark page
  // or a still-loading stream therefore passes this check.
  if (isKnownBlackFrameFailure(pixels, signature)) {
    fail(`known black-frame failure signature: ${JSON.stringify({ pixels, signature })}`);
  }
  return { pixels, signature };
}

async function streamContentRect(page: PatchrightPage, remoteViewport: RemoteViewport): Promise<PatchrightBoundingBox> {
  const frame = page.locator(STREAM_FRAME_SELECTOR).first();
  const box = await frame.boundingBox();
  if (!box) {
    fail("stream frame is not measurable");
  }
  const mediaBox = await frame
    .evaluate<PatchrightBoundingBox | null, undefined>((node) => {
      const media = node.querySelector("video, img");
      if (!media) {
        return null;
      }
      const rect = media.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }, undefined)
    .catch(() => null);
  if (mediaBox) {
    return containedStreamRect(mediaBox, remoteViewport);
  }
  return box;
}

async function assertMobileViewportFits(page: PatchrightPage, phase: string) {
  const metrics = await page.evaluate(() => {
    const visualWidth = window.visualViewport?.width ?? window.innerWidth;
    const { documentElement, body } = document;
    const frame = document.querySelector('[aria-label="Connector browser stream"]');
    const frameRect = frame?.getBoundingClientRect() ?? null;
    return {
      bodyScrollWidth: body?.scrollWidth ?? 0,
      documentClientWidth: documentElement.clientWidth,
      documentScrollWidth: documentElement.scrollWidth,
      frameRight: frameRect?.right ?? null,
      frameLeft: frameRect?.left ?? null,
      visualWidth,
    };
  });
  const overflowingDocument =
    metrics.documentScrollWidth > metrics.documentClientWidth + 1 ||
    metrics.bodyScrollWidth > metrics.documentClientWidth + 1;
  const frameEscapesVisualViewport =
    metrics.frameLeft !== null &&
    metrics.frameRight !== null &&
    (metrics.frameLeft < -1 || metrics.frameRight > metrics.visualWidth + 1);
  if (overflowingDocument || frameEscapesVisualViewport) {
    fail(`mobile ${phase} viewport does not fit: ${JSON.stringify(metrics)}`);
  }
  return metrics;
}

async function assertDocumentHorizontallyFits(page: PatchrightPage, phase: string) {
  const metrics = await page.evaluate(() => {
    const { documentElement, body } = document;
    return {
      bodyScrollWidth: body?.scrollWidth ?? 0,
      documentClientWidth: documentElement.clientWidth,
      documentScrollWidth: documentElement.scrollWidth,
    };
  });
  if (
    metrics.documentScrollWidth > metrics.documentClientWidth + 1 ||
    metrics.bodyScrollWidth > metrics.documentClientWidth + 1
  ) {
    fail(`non-stream ${phase} route has horizontal overflow: ${JSON.stringify(metrics)}`);
  }
  return metrics;
}

const OVERFLOW_PROBE_ID = "pdpp-smoke-overflow-probe";
const NON_SCROLLABLE_OVERFLOW_POLICIES = new Set(["hidden", "clip"]);

/**
 * Excess `scrollWidth`/`scrollHeight` is not the same claim as "the document
 * cannot actually be scrolled" — `overflow: hidden` legitimately RETAINS the
 * oversized scroll extent (scrollHeight stays > clientHeight) while making
 * the box non-scrollable; a restored page could also pass an extent-only
 * check with `overflow: clip` (also non-scrollable) instead of a real
 * scrollable state.
 *
 * Directly assigning `scrollingElement.scrollTop` is NOT a valid oracle
 * either — verified live: Chromium honours a programmatic `scrollTop`
 * assignment on `document.scrollingElement` even when its computed overflow
 * is `hidden` or `clip` (the CSSOM lets script move an element's scroll
 * offset independent of whether user-initiated scroll is permitted). A real
 * mouse-wheel event, routed through the browser's own scroll-eligibility
 * check, is what actually respects the overflow policy — confirmed live:
 * `overflow: hidden` left `scrollTop` at 0 after a wheel event over
 * overflowing content; the same content with default overflow moved it to
 * the full wheel delta.
 */
function readScrollerState() {
  const scroller = document.scrollingElement || document.documentElement;
  return { computedOverflowY: getComputedStyle(scroller).overflowY, scrollTop: scroller.scrollTop };
}

function setScrollerTop(scrollTop: number) {
  const scroller = document.scrollingElement || document.documentElement;
  scroller.scrollTop = scrollTop;
}

async function documentScrollability(page: PatchrightPage) {
  const before = await page.evaluate(readScrollerState);
  const viewport = page.viewportSize();
  await page.mouse.move(Math.floor(viewport.width / 2), Math.floor(viewport.height / 2));
  await page.mouse.wheel(0, 300);
  await page.waitForTimeout(150);
  const after = await page.evaluate(readScrollerState);
  await page.evaluate(setScrollerTop, before.scrollTop);
  return { computedOverflowY: after.computedOverflowY, scrollMoved: after.scrollTop !== before.scrollTop };
}

/**
 * P2 closure: while the stream dialog is open at short landscape dimensions,
 * the document's real scrolling element must be non-scrollable — both by
 * computed overflow policy (`hidden`/`clip`, not merely "not visible") and by
 * a real wheel-scroll attempt actually failing to move it. The pre-existing
 * Stage-1 orientation shell overflows its own box behind the dialog at these
 * dimensions (the dialog covers it, but nothing stops it driving a real page
 * scrollbar unless the scrolling element itself is locked).
 */
async function assertDocumentScrollLockedWhileStreamDialogOpen(page: PatchrightPage) {
  const state = await documentScrollability(page);
  if (!NON_SCROLLABLE_OVERFLOW_POLICIES.has(state.computedOverflowY) || state.scrollMoved) {
    fail(`document is scrollable while the stream dialog is open: ${JSON.stringify(state)}`);
  }
}

/**
 * After close, injects a genuinely overflowing probe element and proves the
 * document is REALLY scrollable again: computed overflow policy is no longer
 * hidden/clip, AND a real wheel-scroll attempt actually moves it (not just
 * that the extent grew — the exact overflow-vs-scrollability gap the extent-
 * only oracle above could not distinguish). Always removes the probe and
 * resets scroll position, even on failure.
 */
async function assertOrdinaryScrollRestoredAfterClose(page: PatchrightPage) {
  await page.evaluate((markerId) => {
    const probe = document.createElement("div");
    probe.id = markerId;
    probe.style.cssText = "position:absolute;top:0;left:0;width:1px;height:300vh;";
    document.body.appendChild(probe);
  }, OVERFLOW_PROBE_ID);
  try {
    const state = await documentScrollability(page);
    if (NON_SCROLLABLE_OVERFLOW_POLICIES.has(state.computedOverflowY) || !state.scrollMoved) {
      fail(`ordinary document scrolling was not restored after the stream dialog closed: ${JSON.stringify(state)}`);
    }
  } finally {
    await page.evaluate((markerId) => {
      document.getElementById(markerId)?.remove();
      const scroller = document.scrollingElement || document.documentElement;
      scroller.scrollTop = 0;
    }, OVERFLOW_PROBE_ID);
  }
}

const CORNER_TOGGLE_SELECTOR = ".pdpp-stream-control-row button[aria-expanded]";
const CLOSE_BUTTON_SELECTOR = '.pdpp-stream-control-row button[aria-label*="End"][aria-label*="browser session"]';

function cornerControlsSnapshot(page: PatchrightPage) {
  return page.evaluate(
    ({ toggleSelector, closeSelector }) => ({
      dialogPresent: Boolean(document.querySelector(".pdpp-stream-dialog")),
      toggleExpanded: document.querySelector(toggleSelector)?.getAttribute("aria-expanded") ?? null,
      closeButtonPresent: Boolean(document.querySelector(closeSelector)),
    }),
    { toggleSelector: CORNER_TOGGLE_SELECTOR, closeSelector: CLOSE_BUTTON_SELECTOR }
  );
}

/**
 * Behavioral oracle for the corner-controls disclosure (P1/P2 closure): steady
 * state hides secondary actions but keeps status+close reachable; expanding
 * and then pressing Escape must collapse the disclosure WITHOUT closing or
 * tearing down the stream dialog; a second Escape (or explicit close) then
 * closes normally. Escape is dispatched with focus moved OUTSIDE the row
 * (onto the dialog popup itself) to prove the handler is not focus-scoped.
 */
async function assertCornerControlsDisclosure(page: PatchrightPage) {
  const steady = await cornerControlsSnapshot(page);
  if (steady.toggleExpanded !== "false") {
    fail(`corner controls did not start collapsed: ${JSON.stringify(steady)}`);
  }
  if (!steady.closeButtonPresent) {
    fail("close button is not present at steady state");
  }

  await page.locator(CORNER_TOGGLE_SELECTOR).click();
  await waitFor(async () => (await cornerControlsSnapshot(page)).toggleExpanded === "true", "toggle did not expand");

  // Move focus to the dialog popup itself, away from the row, before Escape
  // — the disclosure must still intercept it.
  await page.locator(".pdpp-stream-dialog").evaluate<void, undefined>((node) => node.focus(), undefined);

  await page.keyboard.press("Escape");
  await new Promise((resolve) => setTimeout(resolve, 200));
  const afterFirstEscape = await cornerControlsSnapshot(page);
  if (!afterFirstEscape.dialogPresent) {
    fail(
      "stream dialog closed/tore down on the FIRST Escape while actions were expanded — the disclosure must consume that Escape, not the dialog"
    );
  }
  if (afterFirstEscape.toggleExpanded !== "false") {
    fail(`first Escape did not collapse the disclosure: ${JSON.stringify(afterFirstEscape)}`);
  }

  await page.keyboard.press("Escape");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const afterSecondEscape = await cornerControlsSnapshot(page);
  if (afterSecondEscape.dialogPresent) {
    fail("second Escape did not close the stream dialog through normal Base UI dismissal");
  }
}

function proxyKeyboardFocused(page: PatchrightPage): Promise<boolean> {
  return page.evaluate(() => {
    const textarea = document.querySelector('[data-pdpp-soft-keyboard="neko"]');
    return Boolean(textarea && document.activeElement === textarea);
  });
}

async function captureFailureEvidence(
  page: PatchrightPage,
  debugEvents: DebugEvent[],
  requestEvidence: RequestEvidence,
  message: string
) {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const screenshotPath = path.join(EVIDENCE_DIR, `manual-action-stream-smoke-${stamp}.png`);
  const frame = await streamFrameReport(page);
  const framePixels = await streamFramePixelStats(page).catch((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
  }));
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
  const recent = debugEvents.slice(-30).map(eventSummary);
  const relevantTypes = new Set([
    "debug.enabled",
    "neko.client.start",
    "neko.media.displayable",
    "neko.pointer_mapping",
    "neko.pointer_mapping.issue",
    "neko.status.poll",
    "stream.input.post.start",
    "stream.input.post.result",
    "stream.input.post.error",
    "playground.ready",
    "playground.calibration_init",
    "playground.pointerdown",
    "playground.pointerup",
    "playground.click",
    "playground.counter_click",
    "playground.focusin",
    "playground.input",
  ]);
  const relevant = debugEvents
    .filter((event) => {
      const type = eventType(event);
      return relevantTypes.has(type) || type.startsWith("surface.neko.") || type.startsWith("neko.touch");
    })
    .slice(-40)
    .map(eventSummary);
  process.stderr.write(
    `${JSON.stringify(
      {
        failure: message,
        pageUrl: page.url(),
        screenshotPath,
        streamFrame: frame,
        streamFramePixels: framePixels,
        remotePlaygroundReady: Boolean(
          latestEvent(debugEvents, (_event, _payload, type) => type === "playground.ready")
        ),
        remoteLayoutSource: eventType(latestRemoteLayoutEvent(debugEvents)),
        requestEvidence,
        debugEventCount: debugEvents.length,
        recent,
        relevant,
      },
      null,
      2
    )}\n`
  );
}

async function waitFor<T>(
  predicate: () => Promise<T> | T,
  message: string,
  { timeoutMs = DEFAULT_TIMEOUT_MS, intervalMs = 250 }: { intervalMs?: number; timeoutMs?: number } = {}
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: Error | null = null;
  while (Date.now() < deadline) {
    try {
      // Sequential polling is intentional: each iteration must observe the
      // page's state after the previous iteration's wait, not run concurrently.
      // biome-ignore lint/performance/noAwaitInLoops: intentional sequential polling
      const value = await predicate();
      if (value) {
        return value;
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  if (lastError) {
    fail(`${message}: ${lastError.message}`);
  }
  fail(message);
}

async function importPatchright(): Promise<PatchrightModule> {
  let resolved: string;
  try {
    resolved = require.resolve("patchright", {
      paths: [path.join(repoRoot, "reference-implementation")],
    });
  } catch {
    skip("Patchright is not installed. Run pnpm install before requiring the smoke.");
    process.exit(0);
  }
  // The import target is resolved at runtime from a path outside this
  // migration's module graph (patchright is not a root dependency), so its
  // real shape (named export vs. a `default` wrapper, depending on how the
  // resolved entry point was built) is genuinely ambiguous here — narrowing
  // it to `Partial<PatchrightModule & { default: PatchrightModule }>` keeps
  // that ambiguity honest instead of asserting a shape this file cannot verify.
  const imported = (await import(pathToFileURL(resolved).href)) as Partial<PatchrightModule> & {
    default?: PatchrightModule;
  };
  return imported.chromium ? (imported as PatchrightModule) : (imported.default as PatchrightModule);
}

async function deploymentReachable(origin: string): Promise<boolean> {
  try {
    const response = await fetch(origin, { redirect: "manual", signal: AbortSignal.timeout(5000) });
    return response.status >= 200 && response.status < 500;
  } catch {
    return false;
  }
}

async function ensureOwnerSession(page: PatchrightPage) {
  const password = env("PDPP_STREAM_SMOKE_OWNER_PASSWORD") || env("PDPP_OWNER_PASSWORD");
  if (!OWNER_LOGIN_URL_PATTERN.test(page.url())) {
    return;
  }
  if (!password) {
    skip("owner login is required; set PDPP_STREAM_SMOKE_OWNER_PASSWORD or PDPP_OWNER_PASSWORD.");
    process.exit(0);
  }
  await page.locator('input[name="password"]').fill(password);
  await Promise.all([
    page.waitForURL(STREAM_PLAYGROUND_URL_PATTERN, { timeout: DEFAULT_TIMEOUT_MS }),
    page.getByRole("button", { name: SIGN_IN_BUTTON_NAME_PATTERN }).click(),
  ]);
}

async function clickInsideStream(
  page: PatchrightPage,
  remotePoint: RemotePoint,
  remoteViewport: RemoteViewport,
  { mobile = false }: { mobile?: boolean } = {}
) {
  const rect = await streamContentRect(page, remoteViewport);
  const x = Math.round(rect.x + (rect.width * remotePoint.x) / remoteViewport.width);
  const y = Math.round(rect.y + (rect.height * remotePoint.y) / remoteViewport.height);
  if (mobile) {
    await page.touchscreen.tap(x, y);
    return;
  }
  await page.mouse.click(x, y);
}

async function tapLocalButton(
  page: PatchrightPage,
  locator: PatchrightLocator,
  { mobile = false }: { mobile?: boolean } = {}
) {
  if (!mobile) {
    await locator.click();
    return;
  }
  const box = await locator.boundingBox();
  if (!box) {
    fail("local mobile affordance is not measurable");
  }
  await page.touchscreen.tap(Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2));
}

async function clickRemoteControl(
  page: PatchrightPage,
  debugEvents: DebugEvent[],
  controlId: string,
  { mobile = false }: { mobile?: boolean } = {}
): Promise<RemoteControlTarget> {
  const target = resolveRemoteControlTarget(debugEvents, controlId);
  if (!target) {
    fail(`remote playground did not publish a measurable ${controlId} target`);
  }
  await clickInsideStream(page, target.remotePoint, target.remoteViewport, { mobile });
  return target;
}

async function clickStrictVisualCounterTarget(
  page: PatchrightPage,
  debugEvents: DebugEvent[],
  { mobile = false }: { mobile?: boolean } = {}
) {
  const remoteViewport = latestNekoStatusViewport(debugEvents);
  if (remoteViewport) {
    await clickInsideStream(
      page,
      {
        // Strict mode cannot read remote DOM telemetry. This point targets the
        // visible playground counter button from the known debug page layout.
        x: remoteViewport.width * 0.29,
        y: remoteViewport.height * 0.15,
      },
      remoteViewport,
      { mobile }
    );
    return { remoteViewport, strictSafe: true };
  }

  const frame = page.locator(STREAM_FRAME_SELECTOR).first();
  const box = await frame.boundingBox();
  if (!box) {
    fail("stream frame is not measurable");
  }
  if (mobile) {
    await page.touchscreen.tap(Math.round(box.x + box.width * 0.29), Math.round(box.y + box.height * 0.15));
  } else {
    await page.mouse.click(Math.round(box.x + box.width * 0.29), Math.round(box.y + box.height * 0.15));
  }
  return { remoteViewport: null, strictSafe: true };
}

async function proveStrictVisualTyping(
  page: PatchrightPage,
  debugEvents: DebugEvent[],
  { mobile = false }: { mobile?: boolean } = {}
) {
  const remoteViewport = latestNekoStatusViewport(debugEvents);
  if (!remoteViewport) {
    fail("strict-mode smoke cannot prove typing visually without a remote viewport");
  }
  const target = strictVisualInputTarget(remoteViewport);
  await clickInsideStream(page, target.clickPoint, remoteViewport, { mobile });
  await new Promise((resolve) => setTimeout(resolve, 350));
  const before = await captureStreamRemoteRect(page, target.cropRect, remoteViewport);
  await page.keyboard.type(STRICT_SMOKE_TOKEN, { delay: 35 });
  await new Promise((resolve) => setTimeout(resolve, 700));
  const after = await captureStreamRemoteRect(page, target.cropRect, remoteViewport);
  const diff = await comparePngVisualChange(page, before.png, after.png);
  if (diff.changedPixels < 12 || diff.changedRatio < 0.001 || diff.meanRgbDelta < 0.15) {
    fail(
      `strict-mode smoke did not observe visual text-input change after typing (${JSON.stringify({
        diff,
        beforeClip: before.clip,
        afterClip: after.clip,
        remoteViewport,
      })})`
    );
  }
  return {
    diff,
    localClip: after.clip,
    remoteViewport,
    strictSafe: true,
    tokenLength: STRICT_SMOKE_TOKEN.length,
  };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: direct mechanical port of the pre-existing end-to-end smoke sequence, unchanged from the .mjs source
async function run() {
  const origin = publicUrlFromEnv();
  if (!origin) {
    skip(
      "set PDPP_STREAM_SMOKE_URL, PDPP_PUBLIC_URL, or PDPP_REFERENCE_ORIGIN to the running Docker/public web origin."
    );
    return;
  }
  if (!(await deploymentReachable(origin))) {
    skip(`configured origin is not reachable: ${origin}`);
    return;
  }

  const { chromium } = await importPatchright();
  const debugEvents: DebugEvent[] = [];
  const requestEvidence: RequestEvidence = {
    consoleErrors: [],
    eventStreamErrors: [],
    failedRequests: [],
    httpFailures: [],
    nekoHttpFailures: [],
  };
  let debugEventSequence = 0;
  const mobile = mobileSmokeEnabled();
  const executablePath = browserExecutablePath();
  const browser = await chromium.launch({
    headless: env("PDPP_STREAM_SMOKE_HEADFUL") !== "1",
    ...(executablePath ? { executablePath } : {}),
  });
  const page = await browser.newPage({
    viewport: mobile ? { width: 390, height: 844 } : { width: 430, height: 820 },
    deviceScaleFactor: 1,
    isMobile: mobile,
    hasTouch: mobile,
  });

  await page.addInitScript(() => {
    const NativeEventSource = window.EventSource;
    function TracedEventSource(this: EventSource, url: string | URL, configuration?: EventSourceInit) {
      const source = new NativeEventSource(url, configuration);
      if (String(url).includes("/_ref/run-interaction-streams/")) {
        source.addEventListener("error", (event) => {
          const data =
            "data" in event && typeof (event as MessageEvent).data === "string" ? (event as MessageEvent).data : "";
          console.error(`[manual-action-stream-smoke EventSource error] ${data}`);
        });
      }
      return source;
    }
    TracedEventSource.prototype = NativeEventSource.prototype;
    (window as unknown as { EventSource: unknown }).EventSource = TracedEventSource;
  });

  page.on("request", (request) => {
    try {
      const url = new URL(request.url());
      if (url.pathname === "/api/stream-debug") {
        for (const event of parseDebugEventsFromPostData(request.postData())) {
          debugEventSequence += 1;
          debugEvents.push({ ...event, __smokeSequence: debugEventSequence });
        }
        if (debugEvents.length > DEBUG_EVENT_BUFFER_MAX) {
          debugEvents.splice(0, debugEvents.length - DEBUG_EVENT_BUFFER_MAX);
        }
      }
    } catch {
      // Ignore malformed request URLs from browser internals.
    }
  });

  page.on("response", (response) => {
    const request = response.request();
    try {
      const url = new URL(request.url());
      const status = response.status();
      if (status >= 400) {
        const failure = {
          method: request.method(),
          resourceType: request.resourceType(),
          status,
          url: redactRequestUrl(url),
        };
        appendEvidence(requestEvidence.httpFailures, failure);
        if (url.pathname === "/neko" || url.pathname.startsWith("/neko/")) {
          appendEvidence(requestEvidence.nekoHttpFailures, failure);
        }
      }
      if (url.pathname.includes("/_ref/run-interaction-streams/") && url.pathname.endsWith("/events")) {
        response
          .text()
          .then((body) => {
            const errorMatch = body.match(EVENT_STREAM_ERROR_LINE_PATTERN);
            if (!errorMatch) {
              return;
            }
            const [, errorMatchGroup] = errorMatch;
            if (!errorMatchGroup) {
              return;
            }
            try {
              appendEvidence(requestEvidence.eventStreamErrors, JSON.parse(errorMatchGroup));
            } catch {
              appendEvidence(requestEvidence.eventStreamErrors, { raw: errorMatchGroup });
            }
          })
          .catch(() => undefined);
      }
    } catch {
      // Ignore malformed URLs from browser internals.
    }
  });

  page.on("requestfailed", (request) => {
    appendEvidence(requestEvidence.failedRequests, {
      failure: request.failure()?.errorText || "unknown request failure",
      method: request.method(),
      resourceType: request.resourceType(),
      url: redactRequestUrl(request.url()),
    });
  });

  page.on("console", (message) => {
    if (message.type() === "error") {
      appendEvidence(requestEvidence.consoleErrors, { text: message.text(), type: message.type() });
    }
  });

  try {
    const url = smokeUrl(origin);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT_MS });
    await ensureOwnerSession(page);

    await page.goto(new URL("/", origin).toString(), { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT_MS });
    await ensureOwnerSession(page);
    await assertDocumentHorizontallyFits(page, "console home");
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT_MS });
    await ensureOwnerSession(page);

    await page.getByRole("button", { name: OPEN_BROWSER_BUTTON_NAME_PATTERN }).click();
    const streamFrame = page.locator(STREAM_FRAME_SELECTOR).first();
    await streamFrame.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT_MS });

    if (mobile) {
      await assertMobileViewportFits(page, "portrait");
    }

    await waitFor(
      async () =>
        !(await streamFrame
          .evaluate<boolean, undefined>((node) => Boolean(node.getAttribute("data-pdpp-stream-loading")), undefined)
          .catch(() => true)) || hasEvent(debugEvents, (_event, _payload, type) => type === "neko.media.displayable"),
      "stream never became displayable"
    );

    // This is deliberately a pixel-content assertion, not a DOM-presence
    // check. It detects the observed all-black stream plus error/absent-frame
    // signature, without rejecting a legitimately dark remote page.
    await assertKnownBlackFrameFailureAbsent(page);

    await waitFor(
      () =>
        hasEvent(
          debugEvents,
          (event, payload, type) =>
            type === "debug.enabled" ||
            type === "neko.client.start" ||
            type === "neko.media.displayable" ||
            (type === "stream.input.post.result" && payload.status === 202) ||
            Boolean(event.viewerId)
        ),
      "stream debug telemetry did not initialize"
    );

    await waitFor(
      () => resolveRemoteControlTarget(debugEvents, "counter") || latestNekoPageCdpAvailability(debugEvents) === false,
      "stream did not publish either remote playground telemetry or strict-mode page-CDP status"
    );

    if (latestNekoPageCdpAvailability(debugEvents) === false && !resolveRemoteControlTarget(debugEvents, "counter")) {
      await clickStrictVisualCounterTarget(page, debugEvents, { mobile });
      if (mobile && (await proxyKeyboardFocused(page))) {
        fail("strict-mode mobile counter touch focused the keyboard proxy");
      }
      await waitFor(
        () => hasHealthyNekoPointerMapping(debugEvents),
        "strict-mode smoke did not observe healthy n.eko pointer mapping"
      );
      await waitFor(
        () =>
          hasEvent(debugEvents, (_event, _payload, type) => type === "adapter_mounted" || type === "neko.client.start"),
        "strict-mode smoke did not observe n.eko adapter/client startup"
      );
      if (mobile) {
        skip(
          "strict-mode path used Chromium touch emulation but has no remote playground focus geometry; proxy-focus and OS-keyboard acceptance are not verifiable"
        );
        return;
      }
      const visualTyping = await proveStrictVisualTyping(page, debugEvents, { mobile });
      process.stdout.write(
        `${JSON.stringify({ mode: "strict", pageCdpAvailable: false, mobileTouchPath: mobile, visualTyping })}\n`
      );
    } else {
      const counterActionSequence = debugEventSequence;
      await clickRemoteControl(page, debugEvents, "counter", { mobile });
      await waitFor(
        () =>
          hasEventAfter(
            debugEvents,
            counterActionSequence,
            (_event, payload, type) => type === "playground.counter_click" && Number(payload.count) >= 1
          ),
        "remote counter did not report an increment"
      );
      if (mobile) {
        if (await proxyKeyboardFocused(page)) {
          fail("unrelated mobile counter touch focused the keyboard proxy");
        }
        if (
          hasEventAfter(
            debugEvents,
            counterActionSequence,
            (_event, payload, type) =>
              (type === "neko.keyboard_focus.trusted_touch" || type === "neko.keyboard_focus.affordance_tap") &&
              payload.controllerTextareaFocused === true
          )
        ) {
          fail("unrelated mobile counter touch emitted keyboard-focus success telemetry");
        }
      }

      const token = `pdpp-smoke-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const inputActionSequence = debugEventSequence;
      await clickRemoteControl(page, debugEvents, "text-input", { mobile });
      if (mobile) {
        await waitFor(
          () =>
            hasEventAfter(
              debugEvents,
              inputActionSequence,
              (_event, payload, type) =>
                type === "neko.keyboard_focus.trusted_touch" &&
                payload.controllerTextareaFocused === true &&
                payload.userActivationActive === true
            ) ||
            hasEventAfter(
              debugEvents,
              inputActionSequence,
              (_event, _payload, type) => type === "neko.keyboard_focus.affordance"
            ),
          "mobile text-input touch produced neither trusted proxy focus nor a confirmed-focus affordance"
        );
        if (
          hasEventAfter(
            debugEvents,
            inputActionSequence,
            (_event, _payload, type) => type === "neko.keyboard_focus.affordance"
          )
        ) {
          const affordanceActionSequence = debugEventSequence;
          await tapLocalButton(page, page.getByRole("button", { name: TAP_TO_TYPE_BUTTON_NAME_PATTERN }), { mobile });
          await waitFor(
            () =>
              hasEventAfter(
                debugEvents,
                affordanceActionSequence,
                (_event, payload, type) =>
                  type === "neko.keyboard_focus.affordance_tap" &&
                  payload.controllerTextareaFocused === true &&
                  payload.userActivationActive === true
              ),
            "mobile confirmed-focus affordance did not synchronously focus the keyboard proxy"
          );
        }
        if (!(await proxyKeyboardFocused(page))) {
          fail("mobile text-input path did not leave the keyboard proxy focused");
        }
      }
      await page.keyboard.type(token, { delay: 8 });
      await waitFor(
        () =>
          hasEvent(
            debugEvents,
            (_event, payload, type) =>
              type === "playground.input" &&
              payload.smokeTokenPresent === true &&
              Number(payload.valueLength) >= token.length
          ),
        "unique smoke token did not land in the remote playground input"
      );

      await waitFor(
        () =>
          hasEvent(
            debugEvents,
            (_event, _payload, type) => type.startsWith("surface.neko.") || type.startsWith("neko.touch")
          ) &&
          hasEvent(
            debugEvents,
            (_event, _payload, type) => type === "playground.click" || type === "playground.input"
          ) &&
          hasEvent(
            debugEvents,
            (_event, _payload, type) => type === "stream.input.post.result" || type === "neko.client.start"
          ),
        "telemetry did not capture both local input path and remote playground events"
      );
    }

    if (mobile) {
      await page.setViewportSize({ width: 844, height: 390 });
      await new Promise((resolve) => setTimeout(resolve, 800));
      await assertMobileViewportFits(page, "landscape");
      await assertDocumentScrollLockedWhileStreamDialogOpen(page);

      // The corner-controls disclosure toggle only renders on mobile-like
      // sessions (remote-surface's decideClipboardPolicy gates
      // showKeyboardButton/showMobileCopyButton/showMobilePasteButton on
      // capabilities.mobileLike — on a real desktop viewport hasSecondaryActions
      // is always false and no toggle exists to expand). Asserting it in the
      // default desktop run would deterministically fail on a passing build.
      // Ends by closing the stream dialog (its second Escape triggers normal
      // Base UI dismissal) — run last, and immediately verify ordinary
      // document scrolling comes back once the dialog's lifecycle ends.
      await assertCornerControlsDisclosure(page);
      await assertOrdinaryScrollRestoredAfterClose(page);
    }

    process.stdout.write(
      `PASS manual-action stream smoke ${JSON.stringify({
        mobile,
        mobileBoundary: mobile
          ? "Chromium touch emulation and proxy focus/typing; OS keyboard visibility not proven"
          : null,
        url,
      })}\n`
    );
  } catch (error) {
    await captureFailureEvidence(
      page,
      debugEvents,
      requestEvidence,
      error instanceof Error ? error.message : String(error)
    ).catch((captureError: unknown) => {
      process.stderr.write(
        `failed to capture smoke evidence: ${captureError instanceof Error ? captureError.message : String(captureError)}\n`
      );
    });
    throw error;
  } finally {
    await browser.close().catch(() => undefined);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  run().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(1);
  });
}
