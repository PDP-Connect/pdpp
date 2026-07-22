"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  detectNekoPointerMappingIssues,
  isNekoTouchPointInsideRect,
  isNekoTouchScrollIntent,
  NEKO_TOUCH_SCROLL_POLICY,
  type NekoDisplayFitPolicy,
  type NekoMediaPointerMappingGeometry,
  type NekoMediaSettleSample,
  type NekoTouchScrollBridgeEnvironment,
  type NekoViewportLayout,
  nekoTouchScrollStepsToControlDelta,
  selectNekoMediaDisplayForLayout,
  selectNekoMediaSizeForLayout,
  selectNekoScreenStateSizeForLayout,
  shouldUseNekoTouchScrollBridge,
  takeNekoTouchScrollSteps,
} from "@opendatalabs/remote-surface/backends/neko";
import type { RemoteSurfaceInputPayload } from "@opendatalabs/remote-surface/protocol";

export interface NekoClientConfig {
  login?: {
    password: string;
    username: string;
  } | null;
  serverPath: string;
  statusPath: string | null;
}

interface NekoInstance {
  _container?: HTMLElement;
  _overlay?: { _textarea?: HTMLTextAreaElement; getMousePos?: (clientX: number, clientY: number) => NekoControlPos };
  _video?: HTMLVideoElement;
  $destroy?: () => void;
  $el?: Element;
  $mount?: (element: Element) => void;
  connect?: () => void;
  control?: {
    buttonDown?: (code: number, pos?: NekoControlPos) => void;
    buttonUp?: (code: number, pos?: NekoControlPos) => void;
    copy?: () => void;
    cut?: () => void;
    move?: (pos: NekoControlPos) => void;
    paste?: (text?: string) => void;
    request?: () => void;
    scroll?: (scroll: NekoControlScroll) => void;
    selectAll?: () => void;
    supportedTouchEvents?: boolean;
    // Raw X11 keysym dispatch (verified in @demodesk/neko bundle L23746).
    // Used by MobileTextInputController for special keys (Backspace,
    // Enter, Arrows, F-keys). `keyPress` emits press+release in one call.
    keyPress?: (keysym: number, pos?: NekoControlPos) => void;
    keyDown?: (keysym: number, pos?: NekoControlPos) => void;
    keyUp?: (keysym: number, pos?: NekoControlPos) => void;
  };
  controlling?: boolean;
  cursorDrawFunction?: NekoCursorDrawFunction;
  events?: { on?: (name: string, handler: (...args: unknown[]) => void) => void };
  inactiveCursorDrawFunction?: NekoInactiveCursorDrawFunction;
  login?: (username: string, password: string) => Promise<void>;
  onResize?: () => void;
  play?: () => Promise<void>;
  setCursorDrawFunction?: (fn: NekoCursorDrawFunction) => void;
  setInactiveCursorDrawFunction?: (fn: NekoInactiveCursorDrawFunction) => void;
  setReconnectorConfig?: (
    type: "websocket" | "webrtc",
    config: { backoff_ms: number; max_reconnects: number; timeout_ms: number }
  ) => void;
  setTouchEnabled?: (enabled: boolean) => void;
  setUrl?: (url: string) => Promise<void>;
  state?: {
    connection?: {
      screencast?: boolean;
      webrtc?: {
        video?: { auto?: boolean; id?: string };
        stats?: {
          bitrate?: number;
          fps?: number;
          height?: number;
          packetLoss?: number;
          width?: number;
        } | null;
        videos?: string[];
      };
    };
    screen?: { size?: { height: number; width: number } };
  };
}

export type NekoCursorDrawFunction = (...args: unknown[]) => void;
export type NekoInactiveCursorDrawFunction = (...args: unknown[]) => void;

export interface NekoControlPos {
  x: number;
  y: number;
}

export interface NekoControlScroll {
  control_key?: boolean;
  delta_x: number;
  delta_y: number;
}

interface NekoTouchScrollBridgeState {
  accumulatedX: number;
  accumulatedY: number;
  id: number;
  // Monotonic per-page-load sequence id stamped at touchstart. Surfaces in
  // every bridge telemetry event for that gesture and on the corresponding
  // `tap` / `native_tap_observed` event so the operator can correlate a
  // single user press across the whole local→delivery→remote pipeline.
  interactionSeq: number;
  lastX: number;
  lastY: number;
  mode: "fallback" | "native";
  scrolling: boolean;
  startTimeMs: number;
  startX: number;
  startY: number;
}

export type NekoTouchScrollInputDispatcher = (intent: Extract<RemoteSurfaceInputPayload, { type: "pointer" }>) => void;

/**
 * Narrow, production delivery seam for fallback touch scrolling. It keeps the
 * legacy direct-control delivery executable without making the module's n.eko
 * singleton part of a test fixture, and lets the mounted path substitute the
 * viewer router as its sole movement authority.
 */
export interface NekoTouchScrollDeliveryState {
  accumulatedX: number;
  accumulatedY: number;
  lastX: number;
  lastY: number;
}

export interface NekoTouchScrollDeliveryOptions {
  control: {
    move: (pos: NekoControlPos) => void;
    scroll: (scroll: NekoControlScroll) => void;
  };
  dispatchInput?: NekoTouchScrollInputDispatcher;
  mapControlPos: (clientX: number, clientY: number) => NekoControlPos | null;
}

export interface NekoTouchScrollPoint {
  clientX: number;
  clientY: number;
}

export interface NekoTouchScrollTerminalState {
  lastX: number;
  lastY: number;
  scrolling: boolean;
}

export interface NekoFallbackTapState {
  interactionSeq: number;
  pointerId: number;
}

export interface StartNekoOptions {
  dispatchInput?: NekoTouchScrollInputDispatcher;
}

let nekoInstance: NekoInstance | null = null;
let wrapperEl: HTMLDivElement | null = null;
let mountEl: HTMLDivElement | null = null;
let focusInterval: ReturnType<typeof setInterval> | null = null;
let clipboardAbortController: AbortController | null = null;
let clipboardWriteRestore: (() => void) | null = null;
let controlPasteRestore: (() => void) | null = null;
let mobileTextInputAbortController: AbortController | null = null;
let mobileTextInputGuardRetry: ReturnType<typeof setTimeout> | null = null;
let mobileTextInputGuardTextarea: HTMLTextAreaElement | null = null;
let mobileTextInputGuardAttempts = 0;
let mediaLayoutAbortController: AbortController | null = null;
let mediaLayoutObserver: MutationObserver | null = null;
let mediaLayoutObservedElements = new WeakSet<HTMLElement>();
let mobileTouchScrollBridgeAbortController: AbortController | null = null;
let videoAbortController: AbortController | null = null;
let pointerTelemetryAbortController: AbortController | null = null;
let remoteInputFocused = false;
let remoteCopyFallback: (() => void) | null = null;
let viewportLayout: NekoViewportLayout | null = null;
let viewportLayoutUpdatesScreenState = true;
/**
 * PDPP's steady-state display-fit policy for settled n.eko media: the
 * operator's host must show the whole remote screen, never crop it — see
 * `apps/console/src/app/(console)/syncs/[runId]/stream/neko-media-contain-fit.test.ts`
 * for the live-UAT regression this fixes. `applyPendingViewportLayout`'s
 * transient rotation-mismatch path is a separate, deliberate cover-during-
 * transition behavior and does not read this constant.
 */
const NEKO_STEADY_STATE_DISPLAY_FIT: NekoDisplayFitPolicy = "contain";
/**
 * The most recently applied primary-media inverse transform, from
 * remote-surface's authoritative `NekoMediaDisplaySelection.pointerMapping`
 * — kept so pointer mapping (`getNekoControlPos`'s fallback-2 path) can
 * consume the SAME geometry the layout pass applied, instead of
 * re-deriving scale/offset from the media element's live rect
 * independently (planes.md §6: "hosts MUST consume it, never re-derive
 * it").
 *
 * Lifecycle: only `setLatestNekoPointerMapping`/`clearLatestNekoPointerMapping`
 * (below) may assign this — never write it directly. A stale mapping from a
 * torn-down or invalidated layout is a wrong-target click, not just a stale
 * value: it silently maps clicks through a scale that no longer describes
 * the currently-mounted surface. Cleared at every authority-invalidation
 * boundary: `applyViewportLayout`'s null-layout reset branch,
 * `applyPendingViewportLayout` (the container/viewport-mismatch window,
 * where neither the native overlay nor screen-state authority is available
 * either), and `stopNeko`.
 */
let latestNekoPointerMapping: NekoMediaPointerMappingGeometry | null = null;

function isFiniteScale(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/**
 * Sole write path for a fresh mapping. Rejects non-finite/non-positive
 * scale factors (e.g. a degenerate 0-size intrinsic or a NaN from an
 * upstream division-by-zero) before they can reach `getNekoControlPos`'s
 * `(clientX - rect.left) / scaleX` division — an invalid scale there would
 * produce `Infinity`/`NaN` coordinates dispatched straight at the remote
 * control surface.
 */
function setLatestNekoPointerMapping(mapping: NekoMediaPointerMappingGeometry): void {
  if (!(isFiniteScale(mapping.scaleX) && isFiniteScale(mapping.scaleY))) {
    latestNekoPointerMapping = null;
    return;
  }
  latestNekoPointerMapping = mapping;
}

/** Sole invalidation path — see the lifecycle note on the field above. */
function clearLatestNekoPointerMapping(): void {
  latestNekoPointerMapping = null;
}
const RECENT_TEXT_INPUT_CLIPBOARD_SUPPRESS_MS = 2000;
const REMOTE_CLIPBOARD_OPERATION_ALLOW_MS = 3000;
const LOCAL_CLIPBOARD_EVENT_SUPPRESS_MS = 1000;
const MOBILE_TEXT_INPUT_GUARD_RETRY_MS = 100;
const MOBILE_TEXT_INPUT_GUARD_MAX_ATTEMPTS = 50;
const REMOTE_COPY_FALLBACK_DELAY_MS = 120;
const STREAM_DEBUG_EVENT = "pdpp:stream-debug";
export const NEKO_MEDIA_LAYOUT_EVENT = "pdpp:neko-media-layout";
const NEKO_POINTER_TELEMETRY_MOVE_MS = 250;
const NEKO_WEBRTC_RECONNECT_CONFIG = {
  backoff_ms: 1000,
  max_reconnects: 12,
  timeout_ms: 6000,
};
let nekoInteractionSeqCounter = 0;
function nextNekoInteractionSeq(): number {
  nekoInteractionSeqCounter += 1;
  return nekoInteractionSeqCounter;
}
const NEKO_TOUCH_CONTROL_WAIT_MS = 900;
const VIEWPORT_LAYOUT_CONTAINER_TOLERANCE_PX = 3;
const recentTextInputs: Array<{ expiresAt: number; text: string }> = [];
let pendingRemoteClipboardWriteUntil = 0;
let suppressClipboardWritesUntil = 0;
let suppressLocalClipboardEventUntil = 0;

const noopNekoCursorDraw: NekoCursorDrawFunction = () => undefined;
const noopNekoInactiveCursorDraw: NekoInactiveCursorDrawFunction = () => undefined;

export function buildNekoClientProps(): {
  autoplay: boolean;
  cursorDrawFunction: NekoCursorDrawFunction;
  inactiveCursorDrawFunction: NekoInactiveCursorDrawFunction;
  inputMode: "touch";
} {
  return {
    autoplay: true,
    cursorDrawFunction: noopNekoCursorDraw,
    inactiveCursorDrawFunction: noopNekoInactiveCursorDraw,
    inputMode: "touch",
  };
}

export interface NekoKeyboardFocusAttempt {
  active: boolean;
  focused: boolean;
  optimistic: boolean;
  reason: string;
}

function isStreamDebugEnabled(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  const params = new URLSearchParams(window.location.search);
  const raw = [params.get("stream_debug"), params.get("_stream_debug"), params.get("debug"), params.get("_debug")]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.toLowerCase());
  return raw.some((value) => value === "1" || value === "true" || value === "stream" || value === "neko");
}

function emitNekoDebug(type: string, payload: Record<string, unknown>): void {
  if (!isStreamDebugEnabled()) {
    return;
  }
  window.dispatchEvent(new CustomEvent(STREAM_DEBUG_EVENT, { detail: { payload, type } }));
}

function rectSnapshot(element: Element | null): Record<string, number> | null {
  if (!element) {
    return null;
  }
  const rect = element.getBoundingClientRect();
  return {
    height: Math.round(rect.height),
    left: Math.round(rect.left),
    top: Math.round(rect.top),
    width: Math.round(rect.width),
  };
}

function screenStateSnapshot(): Record<string, number> | null {
  const screenSize = nekoInstance?.state?.screen?.size as
    | ({ height?: unknown; rate?: unknown; width?: unknown } & Record<string, unknown>)
    | null;
  if (!screenSize) {
    return null;
  }
  const width = Number(screenSize.width);
  const height = Number(screenSize.height);
  if (!(Number.isFinite(width) && Number.isFinite(height))) {
    return null;
  }
  const snapshot: Record<string, number> = { height, width };
  const rate = Number(screenSize.rate);
  if (Number.isFinite(rate)) {
    snapshot.rate = rate;
  }
  return snapshot;
}

function currentNekoControlCoordinateSize(): { height: number; source: string; width: number } | null {
  if (
    viewportLayout &&
    viewportLayout.viewportWidth > 0 &&
    viewportLayout.viewportHeight > 0 &&
    (viewportLayout.viewportWidth !== viewportLayout.screenWidth ||
      viewportLayout.viewportHeight !== viewportLayout.screenHeight)
  ) {
    return {
      height: viewportLayout.viewportHeight,
      source: "viewport",
      width: viewportLayout.viewportWidth,
    };
  }
  const screenSize = screenStateSnapshot();
  const screenWidth = Number(screenSize?.width);
  const screenHeight = Number(screenSize?.height);
  if (Number.isFinite(screenWidth) && screenWidth > 0 && Number.isFinite(screenHeight) && screenHeight > 0) {
    return {
      height: screenHeight,
      source: "screen-state",
      width: screenWidth,
    };
  }
  return null;
}

function computeAlternativePointerMappings(
  clientX: number,
  clientY: number,
  overlayRect: DOMRect | null,
  mediaRect: DOMRect | null,
  intrinsic: { height: number; width: number } | null,
  screenSize: { height?: number; width?: number } | null,
  controlCoordinateSize: { height: number; width: number } | null
): Record<string, NekoControlPos | null> {
  const candidates: Record<string, NekoControlPos | null> = {
    nekoScreenOverlay: null,
    cssViewportOverlay: null,
    intrinsicMedia: null,
  };
  if (overlayRect && overlayRect.width > 0 && overlayRect.height > 0) {
    if (
      screenSize &&
      Number.isFinite(screenSize.width) &&
      Number.isFinite(screenSize.height) &&
      Number(screenSize.width) > 0 &&
      Number(screenSize.height) > 0
    ) {
      candidates.nekoScreenOverlay = {
        x: Math.round((Number(screenSize.width) / overlayRect.width) * (clientX - overlayRect.left)),
        y: Math.round((Number(screenSize.height) / overlayRect.height) * (clientY - overlayRect.top)),
      };
    }
    if (controlCoordinateSize && controlCoordinateSize.width > 0 && controlCoordinateSize.height > 0) {
      candidates.cssViewportOverlay = {
        x: Math.round((controlCoordinateSize.width / overlayRect.width) * (clientX - overlayRect.left)),
        y: Math.round((controlCoordinateSize.height / overlayRect.height) * (clientY - overlayRect.top)),
      };
    }
  }
  if (
    mediaRect &&
    mediaRect.width > 0 &&
    mediaRect.height > 0 &&
    intrinsic &&
    intrinsic.width > 0 &&
    intrinsic.height > 0
  ) {
    candidates.intrinsicMedia = {
      x: Math.round((intrinsic.width / mediaRect.width) * (clientX - mediaRect.left)),
      y: Math.round((intrinsic.height / mediaRect.height) * (clientY - mediaRect.top)),
    };
  }
  return candidates;
}

// Touch-time viewport-basis snapshot. Captured inside the synchronous
// touch handler so the values are exactly what JS sees the moment the
// user pressed — independent of when the last `viewport.surface.local`
// event fired. This closes the basis-staleness gap where browser-chrome
// collapse, pinch zoom, scroll, or system overlays could silently
// invalidate our coordinate basis between the last viewport.measure and
// the user's tap.
function readTouchTimeViewport(): Record<string, unknown> | null {
  if (typeof window === "undefined") {
    return null;
  }
  const visualViewport = typeof window.visualViewport === "object" ? window.visualViewport : null;
  const orientationApi = typeof screen !== "undefined" && screen && "orientation" in screen ? screen.orientation : null;
  const docEl = typeof document === "undefined" ? null : document.documentElement;
  const scrolling = typeof document === "undefined" ? null : document.scrollingElement;
  return {
    window: {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      outerWidth: window.outerWidth,
      outerHeight: window.outerHeight,
      devicePixelRatio: window.devicePixelRatio,
    },
    visualViewport: visualViewport
      ? {
          width: Math.round(visualViewport.width),
          height: Math.round(visualViewport.height),
          offsetLeft: Math.round(visualViewport.offsetLeft),
          offsetTop: Math.round(visualViewport.offsetTop),
          pageLeft: Math.round(visualViewport.pageLeft),
          pageTop: Math.round(visualViewport.pageTop),
          scale: Number.isFinite(visualViewport.scale) ? visualViewport.scale : null,
        }
      : null,
    documentElement: docEl
      ? {
          clientWidth: docEl.clientWidth,
          clientHeight: docEl.clientHeight,
          scrollWidth: docEl.scrollWidth,
          scrollHeight: docEl.scrollHeight,
        }
      : null,
    scrolling: scrolling
      ? {
          scrollLeft: Math.round(scrolling.scrollLeft || 0),
          scrollTop: Math.round(scrolling.scrollTop || 0),
        }
      : null,
    orientation: orientationApi
      ? {
          angle: orientationApi.angle,
          type: orientationApi.type,
        }
      : null,
  };
}

function readNekoPointerMapping(clientX: number, clientY: number): Record<string, unknown> {
  const overlay = getOverlayTextarea();
  const mediaEl = getPrimaryNekoMediaElement();
  const mapped = getNekoControlPos(clientX, clientY);
  // controlCoordinateSize is purely a telemetry signal here; getNekoControlPos
  // intentionally does NOT use the PDPP-derived CSS viewport size as a
  // divisor. Recording it lets us catch any future regression where the
  // CSS-derived coords would differ from the n.eko-authoritative ones.
  const controlCoordinateSize = currentNekoControlCoordinateSize();
  const mappingBasis = readNekoPointerMappingBasis();
  const screenState = screenStateSnapshot();
  const wrapperRect = wrapperEl?.getBoundingClientRect() ?? null;
  const overlayRect = overlay?.getBoundingClientRect() ?? null;
  const mediaRect = mediaEl?.getBoundingClientRect() ?? null;
  const intrinsic = mediaEl ? getMediaIntrinsicSize(mediaEl) : null;
  const insideRect = (rect: DOMRect | null) =>
    Boolean(rect && clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom);
  // Compute what each alternative basis WOULD have produced. If the
  // active mapped point disagrees with one of the alternatives by more
  // than NEKO_POINTER_BASIS_DISAGREEMENT_PX in either axis, we are in a
  // wrong-targeting risk window — emit a `coordinate-space-mismatch`
  // anomaly so owner can correlate with remote click telemetry.
  const alternatives = computeAlternativePointerMappings(
    clientX,
    clientY,
    overlayRect,
    mediaRect,
    intrinsic,
    screenState as { height?: number; width?: number } | null,
    controlCoordinateSize ? { height: controlCoordinateSize.height, width: controlCoordinateSize.width } : null
  );
  return {
    alternativeMappings: alternatives,
    client: { x: Math.round(clientX), y: Math.round(clientY) },
    controlCoordinateSize,
    insideMedia: insideRect(mediaRect),
    insideOverlay: insideRect(overlayRect),
    insideWrapper: insideRect(wrapperRect),
    mapped,
    mappingBasis,
    media: rectSnapshot(mediaEl),
    mediaIntrinsic: intrinsic,
    overlay: rectSnapshot(overlay),
    screenState,
    // Captured at touch time, NOT only on viewport.measure events. Lets
    // the operator detect basis-staleness (browser-chrome collapse,
    // pinch zoom, scroll, system overlay) that would silently
    // invalidate `client*` between the last measure and the user's tap.
    viewport: readTouchTimeViewport(),
    wrapper: rectSnapshot(wrapperEl),
  };
}

function readNekoPointerMappingBasis(): "media-intrinsic" | "neko-overlay-getMousePos" | "neko-screen-state" {
  if (nekoInstance?._overlay?.getMousePos) {
    return "neko-overlay-getMousePos";
  }
  if (nekoInstance?.state?.screen?.size) {
    return "neko-screen-state";
  }
  return "media-intrinsic";
}

// Backwards-compatible internal wrapper. Existing callsites in
// `startNekoPointerTelemetry` keep using this name; tests import the
// package-owned `detectNekoPointerMappingIssues` directly.
function nekoPointerMappingIssues(snapshot: Record<string, unknown>): string[] {
  return detectNekoPointerMappingIssues(snapshot);
}

function startNekoPointerTelemetry(): void {
  stopNekoPointerTelemetry();
  if (!isStreamDebugEnabled()) {
    return;
  }
  const root = wrapperEl;
  const target = typeof document === "undefined" ? null : document;
  if (!(root && target)) {
    return;
  }
  pointerTelemetryAbortController = new AbortController();
  const { signal } = pointerTelemetryAbortController;
  const lastMoveAt: Record<string, number> = {};
  const eventStartedInStream = (clientX: number, clientY: number, eventTarget: EventTarget | null) => {
    if (eventTarget instanceof Node && root.contains(eventTarget)) {
      return true;
    }
    const rect = root.getBoundingClientRect();
    return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
  };
  const shouldLogMove = (key: string) => {
    const now = Date.now();
    if (now - (lastMoveAt[key] ?? 0) < NEKO_POINTER_TELEMETRY_MOVE_MS) {
      return false;
    }
    lastMoveAt[key] = now;
    return true;
  };
  const emitPointer = (
    eventType: string,
    clientX: number,
    clientY: number,
    eventTarget: EventTarget | null,
    extra: Record<string, unknown> = {}
  ) => {
    if (!eventStartedInStream(clientX, clientY, eventTarget)) {
      return;
    }
    const snapshot = readNekoPointerMapping(clientX, clientY);
    const payload = { eventType, ...extra, ...snapshot };
    emitNekoDebug("neko.pointer_mapping", payload);
    const reasons = nekoPointerMappingIssues(snapshot);
    if (reasons.length > 0) {
      emitNekoDebug("neko.pointer_mapping.issue", {
        ...payload,
        reasons,
      });
    }
  };
  const onPointer = (event: PointerEvent) => {
    if (event.type === "pointermove" && !shouldLogMove("pointer")) {
      return;
    }
    emitPointer(event.type, event.clientX, event.clientY, event.target, {
      button: event.button,
      buttons: event.buttons,
      pointerType: event.pointerType,
    });
  };
  const onMouse = (event: MouseEvent) => {
    if (event.type === "mousemove" && !shouldLogMove("mouse")) {
      return;
    }
    emitPointer(event.type, event.clientX, event.clientY, event.target, {
      button: event.button,
      buttons: event.buttons,
    });
  };
  const onTouch = (event: TouchEvent) => {
    if (event.type === "touchmove" && !shouldLogMove("touch")) {
      return;
    }
    const touch = event.changedTouches[0] ?? event.touches[0];
    if (!touch) {
      return;
    }
    emitPointer(event.type, touch.clientX, touch.clientY, event.target, {
      activeTouches: event.touches.length,
      touchId: touch.identifier,
    });
  };

  for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"] as const) {
    target.addEventListener(type, onPointer, { capture: true, passive: true, signal });
  }
  for (const type of ["mousedown", "mousemove", "mouseup"] as const) {
    target.addEventListener(type, onMouse, { capture: true, passive: true, signal });
  }
  for (const type of ["touchstart", "touchmove", "touchend", "touchcancel"] as const) {
    target.addEventListener(type, onTouch, { capture: true, passive: true, signal });
  }
}

function stopNekoPointerTelemetry(): void {
  pointerTelemetryAbortController?.abort();
  pointerTelemetryAbortController = null;
}

function elementDebugSnapshot(target: EventTarget | null): Record<string, unknown> | null {
  const element = target instanceof Element ? target : null;
  if (!element) {
    return null;
  }
  return {
    contentEditable: element instanceof HTMLElement ? element.isContentEditable : false,
    inputMode: element instanceof HTMLElement ? element.inputMode || null : null,
    isNekoOverlay: Boolean(element.closest("textarea.overlay, textarea.neko-overlay")),
    isPdppUi: Boolean(element.closest("[data-pdpp-stream-ui]")),
    role: element.getAttribute("role"),
    tagName: element.tagName.toLowerCase(),
    type: element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.type : null,
  };
}

function activeElementDebugSnapshot(): Record<string, unknown> | null {
  if (typeof document === "undefined") {
    return null;
  }
  return elementDebugSnapshot(document.activeElement);
}

function isPdppSoftKeyboardElement(element: Element | null): boolean {
  return element?.matches('[data-pdpp-soft-keyboard="neko"]') ?? false;
}

function overlayDebugSnapshot(): Record<string, unknown> {
  const textarea = getOverlayTextarea();
  return {
    activeElement: activeElementDebugSnapshot(),
    overlayActive: Boolean(textarea && document.activeElement === textarea),
    overlayRect: rectSnapshot(textarea),
    overlayValueLength: textarea?.value.length ?? null,
    remoteInputFocused,
  };
}

function onNextFrame(callback: () => void) {
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(callback);
    return;
  }
  callback();
}

function getOverlayTextarea(): HTMLTextAreaElement | null {
  return (
    nekoInstance?._overlay?._textarea ??
    ((nekoInstance?.$el?.querySelector(
      "textarea.overlay, textarea.neko-overlay, textarea"
    ) as HTMLTextAreaElement | null) ||
      null)
  );
}

function hasCoarsePointer(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  try {
    return window.matchMedia("(pointer: coarse)").matches;
  } catch {
    return false;
  }
}

function hasUiTextSelection(): boolean {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || !selection.anchorNode) {
    return false;
  }
  const anchor = selection.anchorNode instanceof Element ? selection.anchorNode : selection.anchorNode.parentElement;
  return Boolean(anchor?.closest("[data-pdpp-stream-ui]"));
}

function shouldBridgeRemoteClipboard(target: EventTarget | null): boolean {
  const targetEl = target instanceof Element ? target : document.activeElement;
  if (targetEl instanceof Element && targetEl.closest("[data-pdpp-stream-ui]")) {
    return false;
  }
  const textarea = getOverlayTextarea();
  if (textarea && document.activeElement === textarea) {
    return !hasUiTextSelection();
  }
  if (targetEl instanceof Element && wrapperEl?.contains(targetEl)) {
    return true;
  }
  if (nekoInstance && !hasUiTextSelection()) {
    return true;
  }
  return remoteInputFocused && !hasUiTextSelection();
}

function getPastedText(event: ClipboardEvent): string {
  return event.clipboardData?.getData("text/plain") || event.clipboardData?.getData("text") || "";
}

function pruneRecentTextInputs(now = Date.now()): void {
  for (let index = recentTextInputs.length - 1; index >= 0; index -= 1) {
    const entry = recentTextInputs[index];
    if (entry && entry.expiresAt <= now) {
      recentTextInputs.splice(index, 1);
    }
  }
}

function rememberTextInput(text: string, source = "unknown"): void {
  const coarsePointer = hasCoarsePointer();
  if (!(text && coarsePointer)) {
    emitNekoDebug("neko.mobile_text_input.skip", {
      coarsePointer,
      length: text.length,
      source,
    });
    return;
  }
  const now = Date.now();
  suppressClipboardWritesUntil = now + RECENT_TEXT_INPUT_CLIPBOARD_SUPPRESS_MS;
  pruneRecentTextInputs(now);
  recentTextInputs.push({
    text,
    expiresAt: now + RECENT_TEXT_INPUT_CLIPBOARD_SUPPRESS_MS,
  });
  emitNekoDebug("neko.mobile_text_input.remember", {
    length: text.length,
    recentCount: recentTextInputs.length,
    source,
  });
}

function assessClipboardWrite(text: string): { reason: string; suppress: boolean } {
  const now = Date.now();
  if (pendingRemoteClipboardWriteUntil > now) {
    pendingRemoteClipboardWriteUntil = 0;
    return { reason: "remote-copy-allowance", suppress: false };
  }
  if (!text) {
    return { reason: "empty-text", suppress: false };
  }
  if (suppressClipboardWritesUntil > now) {
    return { reason: "recent-mobile-text-input-window", suppress: true };
  }
  pruneRecentTextInputs(now);
  if (recentTextInputs.some((entry) => entry.text === text)) {
    return { reason: "recent-mobile-text-input-match", suppress: true };
  }
  return { reason: "not-recent-text-input", suppress: false };
}

function allowNextRemoteClipboardWrite(): void {
  pendingRemoteClipboardWriteUntil = Date.now() + REMOTE_CLIPBOARD_OPERATION_ALLOW_MS;
}

function suppressNextLocalClipboardEvent(): void {
  suppressLocalClipboardEventUntil = Date.now() + LOCAL_CLIPBOARD_EVENT_SUPPRESS_MS;
}

function runRemoteCopyFallback(): boolean {
  if (!remoteCopyFallback) {
    emitNekoDebug("neko.clipboard_remote_to_local", {
      method: "fallback.input-url",
      phase: "skipped",
      reason: "missing-fallback",
    });
    return false;
  }
  try {
    remoteCopyFallback();
    emitNekoDebug("neko.clipboard_remote_to_local", {
      method: "fallback.input-url",
      phase: "dispatched",
    });
    return true;
  } catch (err) {
    emitNekoDebug("neko.clipboard_remote_to_local", {
      error: err instanceof Error ? err.message : String(err),
      method: "fallback.input-url",
      phase: "dispatch-error",
    });
    return false;
  }
}

function scheduleRemoteCopyFallback(): void {
  emitNekoDebug("neko.clipboard_remote_to_local", {
    delayMs: REMOTE_COPY_FALLBACK_DELAY_MS,
    method: "fallback.input-url",
    phase: "scheduled",
  });
  setTimeout(() => {
    runRemoteCopyFallback();
  }, REMOTE_COPY_FALLBACK_DELAY_MS);
}

function startClipboardWriteGuard(): void {
  stopClipboardWriteGuard();
  const clipboard = navigator.clipboard;
  if (!clipboard || typeof clipboard.writeText !== "function") {
    emitNekoDebug("neko.clipboard_write.guard", {
      available: false,
      reason: "missing-navigator-clipboard-writeText",
    });
    return;
  }

  const clipboardPrototype = Object.getPrototypeOf(clipboard) as Clipboard | null;
  const target =
    clipboardPrototype && typeof clipboardPrototype.writeText === "function" ? clipboardPrototype : clipboard;
  const descriptor = Object.getOwnPropertyDescriptor(target, "writeText");
  const original = target.writeText;
  const guardedWriteText = function guardedWriteText(this: Clipboard, text: string): Promise<void> {
    const value = String(text ?? "");
    const assessment = assessClipboardWrite(value);
    emitNekoDebug("neko.clipboard_write.attempt", {
      length: value.length,
      reason: assessment.reason,
      suppress: assessment.suppress,
      ...overlayDebugSnapshot(),
    });
    if (assessment.suppress) {
      return Promise.resolve();
    }
    return original
      .call(this, text)
      .then((result) => {
        emitNekoDebug("neko.clipboard_write.result", {
          length: value.length,
          ok: true,
          reason: assessment.reason,
        });
        return result;
      })
      .catch((err) => {
        emitNekoDebug("neko.clipboard_write.result", {
          error: err instanceof Error ? err.message : String(err),
          length: value.length,
          ok: false,
          reason: assessment.reason,
        });
        throw err;
      });
  };

  try {
    Object.defineProperty(target, "writeText", {
      configurable: true,
      value: guardedWriteText,
    });
    emitNekoDebug("neko.clipboard_write.guard", {
      available: true,
      installed: true,
    });
    clipboardWriteRestore = () => {
      if (descriptor) {
        Object.defineProperty(target, "writeText", descriptor);
      } else {
        Object.defineProperty(target, "writeText", {
          configurable: true,
          value: original,
        });
      }
    };
  } catch {
    // Some browsers expose Clipboard methods as non-configurable native slots.
    // In that case we leave clipboard sync untouched rather than breaking input.
    emitNekoDebug("neko.clipboard_write.guard", {
      available: true,
      installed: false,
      reason: "writeText-non-configurable",
    });
    clipboardWriteRestore = null;
  }
}

function stopClipboardWriteGuard(): void {
  clipboardWriteRestore?.();
  clipboardWriteRestore = null;
  recentTextInputs.length = 0;
  pendingRemoteClipboardWriteUntil = 0;
  suppressClipboardWritesUntil = 0;
  suppressLocalClipboardEventUntil = 0;
}

function startControlPasteGuard(): void {
  stopControlPasteGuard();
  const control = nekoInstance?.control;
  const originalPaste = control?.paste;
  if (!(control && typeof originalPaste === "function")) {
    return;
  }

  control.paste = function guardedPaste(this: NekoInstance["control"], text?: string): void {
    if (typeof text === "string" && text.length > 0) {
      rememberTextInput(text, "control.paste");
      emitNekoDebug("neko.control.paste", {
        length: text.length,
        ...overlayDebugSnapshot(),
      });
    }
    originalPaste.call(this, text);
  };
  controlPasteRestore = () => {
    control.paste = originalPaste;
  };
}

function stopControlPasteGuard(): void {
  controlPasteRestore?.();
  controlPasteRestore = null;
}

function queueMobileTextInputGuardRetry(): void {
  if (mobileTextInputGuardRetry || mobileTextInputGuardAttempts >= MOBILE_TEXT_INPUT_GUARD_MAX_ATTEMPTS) {
    emitNekoDebug("neko.overlay.guard.retry-skip", {
      attempts: mobileTextInputGuardAttempts,
      hasRetry: Boolean(mobileTextInputGuardRetry),
      maxAttempts: MOBILE_TEXT_INPUT_GUARD_MAX_ATTEMPTS,
    });
    return;
  }
  mobileTextInputGuardAttempts += 1;
  emitNekoDebug("neko.overlay.guard.retry", {
    attempts: mobileTextInputGuardAttempts,
    delayMs: MOBILE_TEXT_INPUT_GUARD_RETRY_MS,
  });
  mobileTextInputGuardRetry = setTimeout(() => {
    mobileTextInputGuardRetry = null;
    startMobileTextInputGuard();
  }, MOBILE_TEXT_INPUT_GUARD_RETRY_MS);
}

function startMobileTextInputGuard(): void {
  const textarea = getOverlayTextarea();
  if (!textarea) {
    emitNekoDebug("neko.overlay.guard", {
      installed: false,
      reason: "missing-overlay-textarea",
    });
    queueMobileTextInputGuardRetry();
    return;
  }
  if (mobileTextInputGuardTextarea === textarea && mobileTextInputAbortController) {
    emitNekoDebug("neko.overlay.guard", {
      installed: true,
      reason: "already-installed",
      ...overlayDebugSnapshot(),
    });
    return;
  }

  stopMobileTextInputGuard();
  mobileTextInputGuardAttempts = 0;
  mobileTextInputGuardTextarea = textarea;
  mobileTextInputAbortController = new AbortController();
  const { signal } = mobileTextInputAbortController;
  emitNekoDebug("neko.overlay.guard", {
    installed: true,
    reason: "installed",
    ...overlayDebugSnapshot(),
  });
  textarea.addEventListener(
    "beforeinput",
    (event) => {
      if (!(event instanceof InputEvent)) {
        return;
      }
      emitNekoDebug("neko.overlay.beforeinput", {
        dataLength: typeof event.data === "string" ? event.data.length : null,
        inputType: event.inputType,
        isComposing: event.isComposing,
        valueLength: textarea.value.length,
        ...overlayDebugSnapshot(),
      });
      if (typeof event.data === "string" && event.data.length > 0) {
        rememberTextInput(event.data, `overlay.beforeinput:${event.inputType || "unknown"}`);
      }
    },
    { capture: true, signal }
  );
  textarea.addEventListener(
    "input",
    () => {
      emitNekoDebug("neko.overlay.input", {
        valueLength: textarea.value.length,
        ...overlayDebugSnapshot(),
      });
      rememberTextInput(textarea.value, "overlay.input");
    },
    { capture: true, signal }
  );
}

function stopMobileTextInputGuard(): void {
  if (mobileTextInputGuardRetry) {
    clearTimeout(mobileTextInputGuardRetry);
    mobileTextInputGuardRetry = null;
  }
  mobileTextInputAbortController?.abort();
  mobileTextInputAbortController = null;
  mobileTextInputGuardTextarea = null;
  mobileTextInputGuardAttempts = 0;
}

export function pasteTextIntoNeko(text: string, opts: { focusKeyboardAfterPaste?: boolean } = {}): boolean {
  const focusKeyboardAfterPaste = opts.focusKeyboardAfterPaste ?? true;
  const control = nekoInstance?.control;
  if (!text || typeof control?.paste !== "function") {
    emitNekoDebug("neko.clipboard_local_to_remote", {
      length: text.length,
      method: "control.paste",
      phase: "skipped",
      reason: text ? "missing-control-paste" : "empty-text",
      ...overlayDebugSnapshot(),
    });
    return false;
  }
  rememberTextInput(text, "clipboard.local-to-remote");
  control.paste(text);
  emitNekoDebug("neko.clipboard_local_to_remote", {
    length: text.length,
    method: "control.paste",
    phase: "sent",
    refocusedKeyboard: focusKeyboardAfterPaste,
    ...overlayDebugSnapshot(),
  });
  if (focusKeyboardAfterPaste) {
    focusNekoKeyboard();
  }
  return true;
}

function pasteBridgeReason({ pasted, targetAllowed }: { pasted: boolean; targetAllowed: boolean }): string {
  if (!targetAllowed) {
    return "target-blocked";
  }
  return pasted ? "bridged" : "paste-failed";
}

function runNekoClipboardCommand(command: "copy" | "cut" | "selectAll"): boolean {
  const control = nekoInstance?.control;
  const handler = control?.[command];
  if (typeof handler !== "function") {
    emitNekoDebug("neko.clipboard_command", {
      command,
      phase: "skipped",
      reason: "missing-control-handler",
    });
    return false;
  }
  if (command === "copy" || command === "cut") {
    allowNextRemoteClipboardWrite();
    emitNekoDebug("neko.clipboard_remote_to_local", {
      command,
      method: "control",
      phase: "requested",
    });
  }
  handler.call(control);
  emitNekoDebug("neko.clipboard_command", {
    command,
    phase: "called",
  });
  return true;
}

function bridgeClipboardPaste(event: ClipboardEvent): void {
  const targetAllowed = shouldBridgeRemoteClipboard(event.target);
  const text = getPastedText(event);
  const pasted = targetAllowed && pasteTextIntoNeko(text);
  emitNekoDebug("neko.clipboard_event", {
    bridged: pasted,
    length: text.length,
    phase: "paste",
    reason: pasteBridgeReason({ pasted, targetAllowed }),
    target: elementDebugSnapshot(event.target),
    ...overlayDebugSnapshot(),
  });
  if (!pasted) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
}

function bridgeClipboardCopyOrCut(event: ClipboardEvent): void {
  if (!(event.type === "copy" || event.type === "cut")) {
    return;
  }
  if (!shouldBridgeRemoteClipboard(event.target)) {
    emitNekoDebug("neko.clipboard_event", {
      bridged: false,
      phase: event.type,
      reason: "target-blocked",
      target: elementDebugSnapshot(event.target),
      ...overlayDebugSnapshot(),
    });
    return;
  }
  if (suppressLocalClipboardEventUntil > Date.now()) {
    emitNekoDebug("neko.clipboard_event", {
      bridged: false,
      phase: event.type,
      reason: "suppressed-local-clipboard-event",
      target: elementDebugSnapshot(event.target),
      ...overlayDebugSnapshot(),
    });
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  if (!runNekoClipboardCommand(event.type)) {
    emitNekoDebug("neko.clipboard_event", {
      bridged: false,
      phase: event.type,
      reason: "control-command-failed",
      target: elementDebugSnapshot(event.target),
      ...overlayDebugSnapshot(),
    });
    return;
  }
  emitNekoDebug("neko.clipboard_event", {
    bridged: true,
    phase: event.type,
    reason: "bridged",
    target: elementDebugSnapshot(event.target),
    ...overlayDebugSnapshot(),
  });
  event.preventDefault();
  event.stopPropagation();
}

function isPasteShortcut(event: KeyboardEvent): boolean {
  return (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "v";
}

function getShortcutCommand(event: KeyboardEvent): "copy" | "cut" | "paste" | "selectAll" | null {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) {
    return null;
  }
  switch (event.key.toLowerCase()) {
    case "a":
      return "selectAll";
    case "c":
      return "copy";
    case "v":
      return "paste";
    case "x":
      return "cut";
    default:
      return null;
  }
}

function readNavigatorClipboard(): Promise<string> | null {
  const readText = navigator.clipboard?.readText;
  if (typeof readText !== "function") {
    return null;
  }
  return readText.call(navigator.clipboard);
}

function bridgeClipboardShortcut(event: KeyboardEvent): void {
  const command = getShortcutCommand(event);
  if (!(command && shouldBridgeRemoteClipboard(event.target))) {
    if (command) {
      emitNekoDebug("neko.clipboard_shortcut", {
        command,
        phase: "skipped",
        reason: "target-blocked",
        target: elementDebugSnapshot(event.target),
        ...overlayDebugSnapshot(),
      });
    }
    return;
  }
  emitNekoDebug("neko.clipboard_shortcut", {
    command,
    phase: "received",
    target: elementDebugSnapshot(event.target),
    ...overlayDebugSnapshot(),
  });
  if (command !== "paste") {
    if (command === "copy" || command === "cut") {
      // Let n.eko receive the real key chord. Its synthetic control.copy()
      // path can miss normal page selections even though Chrome's native
      // Ctrl+C handles them. Suppress the local hidden-textarea clipboard event
      // that the browser may emit for the same shortcut.
      suppressNextLocalClipboardEvent();
      if (command === "copy") {
        scheduleRemoteCopyFallback();
      }
      emitNekoDebug("neko.clipboard_shortcut", {
        command,
        phase: "native-forwarded",
        target: elementDebugSnapshot(event.target),
        ...overlayDebugSnapshot(),
      });
    }
    return;
  }
  if (!isPasteShortcut(event)) {
    return;
  }
  focusNekoKeyboard();
  event.stopImmediatePropagation();
  emitNekoDebug("neko.clipboard_shortcut", {
    command,
    phase: "native-paste-capture",
    target: elementDebugSnapshot(event.target),
    ...overlayDebugSnapshot(),
  });
}

export async function pasteLocalClipboardIntoNeko(): Promise<boolean> {
  const text = await readNavigatorClipboard();
  const pasted = pasteTextIntoNeko(text || "");
  emitNekoDebug("neko.clipboard_local_to_remote", {
    length: (text || "").length,
    method: "navigator.clipboard.readText",
    pasted,
    phase: "read-result",
    ...overlayDebugSnapshot(),
  });
  return pasted;
}

export function copyRemoteSelectionFromNeko(): boolean {
  const copied = runNekoClipboardCommand("copy");
  const fallbackDispatched = runRemoteCopyFallback();
  emitNekoDebug("neko.clipboard_remote_to_local", {
    copied,
    fallbackDispatched,
    method: "corner.copy",
    phase: "requested",
    ...overlayDebugSnapshot(),
  });
  return copied || fallbackDispatched;
}

function startClipboardBridge(): void {
  stopClipboardBridge();
  clipboardAbortController = new AbortController();
  const { signal } = clipboardAbortController;
  window.addEventListener("copy", bridgeClipboardCopyOrCut, { capture: true, signal });
  window.addEventListener("cut", bridgeClipboardCopyOrCut, { capture: true, signal });
  window.addEventListener("paste", bridgeClipboardPaste, { capture: true, signal });
  window.addEventListener("keydown", bridgeClipboardShortcut, { capture: true, signal });
}

function stopClipboardBridge(): void {
  clipboardAbortController?.abort();
  clipboardAbortController = null;
}

function getNekoVideo(): HTMLVideoElement | null {
  if (nekoInstance?._video) {
    return nekoInstance._video;
  }
  const video = nekoInstance?.$el?.querySelector("video");
  return video instanceof HTMLVideoElement ? video : null;
}

function unlockNekoVideoPlayback(): void {
  const video = getNekoVideo();
  if (!video) {
    return;
  }
  video.muted = true;
  video.autoplay = true;
  video.playsInline = true;
  video.setAttribute("playsinline", "");
  video.setAttribute("webkit-playsinline", "");
  const play = nekoInstance?.play;
  const playPromise = typeof play === "function" ? play.call(nekoInstance) : video.play();
  playPromise.catch(() => undefined);
}

function selectPreferredNekoVideoStream(neko: NekoInstance): void {
  const webrtc = neko.state?.connection?.webrtc;
  const video = webrtc?.video;
  if (!video) {
    return;
  }
  const available = Array.isArray(webrtc?.videos) ? webrtc.videos.filter((id) => typeof id === "string") : [];
  const preferred = ["hq", "main"].find((id) => available.includes(id)) ?? available[0] ?? "main";
  video.id = preferred;
  video.auto = available.length > 1;
}

function suppressNekoCursorChrome(neko: NekoInstance): void {
  if (typeof neko.setCursorDrawFunction === "function") {
    neko.setCursorDrawFunction(noopNekoCursorDraw);
  } else {
    neko.cursorDrawFunction = noopNekoCursorDraw;
  }

  if (typeof neko.setInactiveCursorDrawFunction === "function") {
    neko.setInactiveCursorDrawFunction(noopNekoInactiveCursorDraw);
  } else {
    neko.inactiveCursorDrawFunction = noopNekoInactiveCursorDraw;
  }
}

function retryNekoVideoPlayback(delayMs: number): void {
  setTimeout(() => {
    if (!videoAbortController?.signal.aborted) {
      unlockNekoVideoPlayback();
    }
  }, delayMs);
}

function startVideoPlaybackBridge(): void {
  stopVideoPlaybackBridge();
  videoAbortController = new AbortController();
  const { signal } = videoAbortController;
  const unlock = () => unlockNekoVideoPlayback();
  const unlockWhenVisible = () => {
    if (document.visibilityState === "visible") {
      unlockNekoVideoPlayback();
    }
  };

  wrapperEl?.addEventListener("click", unlock, { capture: true, passive: true, signal });
  wrapperEl?.addEventListener("pointerdown", unlock, { capture: true, passive: true, signal });
  wrapperEl?.addEventListener("touchstart", unlock, { capture: true, passive: true, signal });
  document.addEventListener("visibilitychange", unlockWhenVisible, { signal });

  unlockNekoVideoPlayback();
  retryNekoVideoPlayback(250);
  retryNekoVideoPlayback(1000);
  retryNekoVideoPlayback(2500);
}

function stopVideoPlaybackBridge(): void {
  videoAbortController?.abort();
  videoAbortController = null;
}

function readNekoTouchScrollBridgeEnvironment(neko: NekoInstance): NekoTouchScrollBridgeEnvironment {
  let landscape = false;
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    try {
      landscape = window.matchMedia("(orientation: landscape)").matches;
    } catch {
      landscape = window.innerWidth > window.innerHeight;
    }
  }
  return {
    coarsePointer: hasCoarsePointer(),
    landscape,
    nativeTouchSupported:
      typeof neko.control?.supportedTouchEvents === "boolean" ? neko.control.supportedTouchEvents : null,
  };
}

function getNekoControlPos(clientX: number, clientY: number): NekoControlPos | null {
  // Prefer n.eko's own coordinate mapping. n.eko knows the active screen
  // mode and the overlay textarea geometry it owns; its `getMousePos`
  // returns coordinates in the *remote browser's* coordinate space, which
  // is what `control.buttonDown/Up`/`control.move` expect. Anything else
  // (PDPP-derived CSS-viewport divisors, ad-hoc media-element math) risks
  // landing the click on a different X/Y on the remote — the wrong-targeting
  // signature the operator sees as "tapped here, click went somewhere else".
  const overlayPos = nekoInstance?._overlay?.getMousePos?.(clientX, clientY);
  if (overlayPos) {
    return overlayPos;
  }
  // Fallback 1: n.eko's reported screen size against the overlay rect.
  // Uses `state.screen.size` (n.eko-authoritative), NOT viewportLayout
  // (which is PDPP-derived from the local CSS viewport and would land
  // the click in CSS space rather than screen space).
  const overlay = getOverlayTextarea();
  const screenSize = nekoInstance?.state?.screen?.size;
  if (overlay && screenSize && screenSize.width > 0 && screenSize.height > 0) {
    const rect = overlay.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      return {
        x: Math.round((screenSize.width / rect.width) * (clientX - rect.left)),
        y: Math.round((screenSize.height / rect.height) * (clientY - rect.top)),
      };
    }
  }
  // Fallback 2: remote-surface's own authoritative inverse transform for the
  // media element the steady-state layout pass just applied
  // (`latestNekoPointerMapping`, from `NekoMediaDisplaySelection.pointerMapping`
  // — see applyViewportLayout). Consumes the SAME geometry the layout used,
  // instead of re-deriving scale/offset from the media element's live rect
  // independently (planes.md §6: "hosts MUST consume it, never re-derive it").
  // `mediaEl.getBoundingClientRect()` already reflects the applied
  // `left: offsetX; top: offsetY` positioning (see applyElementLayout), so
  // only the scale factor is needed here — the offset is already baked into
  // the element's own rect and must not be subtracted a second time.
  const mediaEl = getPrimaryNekoMediaElement();
  if (mediaEl && latestNekoPointerMapping) {
    const rect = mediaEl.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      const { scaleX, scaleY } = latestNekoPointerMapping;
      return {
        x: Math.round((clientX - rect.left) / scaleX),
        y: Math.round((clientY - rect.top) / scaleY),
      };
    }
  }
  // Fallback 3: media element's intrinsic dimensions against its rect. Only
  // reachable if no layout pass has run yet (latestNekoPointerMapping unset).
  const intrinsic = mediaEl ? getMediaIntrinsicSize(mediaEl) : null;
  if (mediaEl && intrinsic && intrinsic.width > 0 && intrinsic.height > 0) {
    const rect = mediaEl.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      return {
        x: Math.round((intrinsic.width / rect.width) * (clientX - rect.left)),
        y: Math.round((intrinsic.height / rect.height) * (clientY - rect.top)),
      };
    }
  }
  return null;
}

function changedTouchById(event: TouchEvent, id: number): Touch | null {
  return (
    Array.from(event.changedTouches).find((touch) => touch.identifier === id) ??
    Array.from(event.touches).find((touch) => touch.identifier === id) ??
    null
  );
}

function stopTouchEventForNekoBridge(event: TouchEvent): void {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
}

function requestNekoControlForBridge(reason: string): boolean {
  const control = nekoInstance?.control;
  if (nekoInstance?.controlling === true) {
    return true;
  }
  if (typeof control?.request !== "function") {
    emitNekoDebug("neko.touch_scroll_bridge.control_unavailable", { reason });
    return false;
  }
  control.request();
  emitNekoDebug("neko.touch_scroll_bridge.control_request", { reason });
  return true;
}

function runWhenNekoControlReady(reason: string, action: () => boolean): boolean {
  if (nekoInstance?.controlling === true) {
    return action();
  }
  if (!requestNekoControlForBridge(reason)) {
    return false;
  }
  const startedAt = Date.now();
  const tick = () => {
    if (!nekoInstance) {
      emitNekoDebug("neko.touch_scroll_bridge.control_wait_cancelled", { reason });
      return;
    }
    if (nekoInstance.controlling === true) {
      emitNekoDebug("neko.touch_scroll_bridge.control_ready", {
        elapsedMs: Date.now() - startedAt,
        reason,
      });
      action();
      return;
    }
    if (Date.now() - startedAt >= NEKO_TOUCH_CONTROL_WAIT_MS) {
      emitNekoDebug("neko.touch_scroll_bridge.control_timeout", { reason });
      return;
    }
    window.setTimeout(tick, 25);
  };
  window.setTimeout(tick, 25);
  return true;
}

export function deliverNekoTouchScrollSteps(
  state: NekoTouchScrollDeliveryState,
  touch: NekoTouchScrollPoint,
  options: NekoTouchScrollDeliveryOptions
): NekoTouchScrollDeliveryState {
  const dx = state.lastX - touch.clientX;
  const dy = state.lastY - touch.clientY;
  if (options.dispatchInput) {
    options.dispatchInput({
      action: "wheel",
      deltaX: dx,
      deltaY: dy,
      pointerType: "touch",
      source: "touch-gesture",
      type: "pointer",
      x: touch.clientX,
      y: touch.clientY,
    });
    emitNekoDebug("neko.touch_scroll_bridge.scroll", {
      deltaX: Math.round(dx),
      deltaY: Math.round(dy),
      route: "viewer",
    });
    return {
      ...state,
      lastX: touch.clientX,
      lastY: touch.clientY,
    };
  }

  const pos = options.mapControlPos(touch.clientX, touch.clientY);
  if (pos) {
    options.control.move(pos);
  }
  let accumulatedX = state.accumulatedX + dx;
  let accumulatedY = state.accumulatedY + dy;
  const x = takeNekoTouchScrollSteps(accumulatedX);
  const y = takeNekoTouchScrollSteps(accumulatedY);
  accumulatedX = x.remainderPx;
  accumulatedY = y.remainderPx;

  const maxSteps = Math.max(Math.abs(x.steps), Math.abs(y.steps));
  for (let index = 0; index < maxSteps; index += 1) {
    options.control.scroll({
      control_key: false,
      delta_x: Math.abs(x.steps) > index ? nekoTouchScrollStepsToControlDelta(x.steps) : 0,
      delta_y: Math.abs(y.steps) > index ? nekoTouchScrollStepsToControlDelta(y.steps) : 0,
    });
  }

  if (maxSteps > 0) {
    emitNekoDebug("neko.touch_scroll_bridge.scroll", {
      deltaX: Math.round(dx),
      deltaY: Math.round(dy),
      steps: { x: x.steps, y: y.steps },
    });
  }

  return {
    ...state,
    accumulatedX,
    accumulatedY,
    lastX: touch.clientX,
    lastY: touch.clientY,
  };
}

/**
 * Ends a mounted fallback gesture without turning a `touchend`/`touchcancel`
 * coordinate into another scroll sample. remote-surface 1.4.1 treats this
 * zero-delta boundary as accumulator metadata only.
 */
export function dispatchNekoTouchScrollBoundary(
  state: Pick<NekoTouchScrollDeliveryState, "lastX" | "lastY">,
  dispatchInput?: NekoTouchScrollInputDispatcher
): void {
  if (!dispatchInput) {
    return;
  }
  dispatchInput({
    action: "wheel",
    deltaX: 0,
    deltaY: 0,
    gestureBoundary: true,
    pointerType: "touch",
    source: "touch-gesture",
    type: "pointer",
    x: state.lastX,
    y: state.lastY,
  });
}

/**
 * Production terminal path shared by `touchend` and `touchcancel`. The
 * terminal touch is intentionally not converted into a scroll sample: only
 * the last point already delivered by `touchmove` may identify the boundary.
 */
export function completeNekoTouchScrollGesture(
  state: NekoTouchScrollTerminalState,
  _terminalTouch: NekoTouchScrollPoint | null | undefined,
  dispatchInput?: NekoTouchScrollInputDispatcher
): void {
  // Keep this parameter at the production seam. Its changed coordinates are
  // evidence that the boundary must use state.lastX/state.lastY instead.
  if (state.scrolling && dispatchInput) {
    dispatchNekoTouchScrollBoundary(state, dispatchInput);
  }
}

function sendNekoScrollSteps(
  state: NekoTouchScrollBridgeState,
  touch: Touch | NekoTouchScrollPoint,
  dispatchInput?: NekoTouchScrollInputDispatcher
): NekoTouchScrollBridgeState {
  const control = nekoInstance?.control;
  if (!(control?.scroll && control.move)) {
    return state;
  }
  if (nekoInstance?.controlling !== true) {
    requestNekoControlForBridge("scroll");
    return state;
  }
  return {
    ...state,
    ...deliverNekoTouchScrollSteps(
      {
        accumulatedX: state.accumulatedX,
        accumulatedY: state.accumulatedY,
        lastX: state.lastX,
        lastY: state.lastY,
      },
      touch,
      {
        control: { move: control.move, scroll: control.scroll },
        dispatchInput,
        mapControlPos: getNekoControlPos,
      }
    ),
  };
}

function clickNekoAtPoint(
  clientX: number,
  clientY: number,
  options: { interactionSeq?: number; path?: string } = {}
): boolean {
  const pos = getNekoControlPos(clientX, clientY);
  if (!pos) {
    return false;
  }
  // Capture the full mapping snapshot at the moment of tap so the
  // `tap` event can be correlated against the corresponding remote
  // `playground.event` (matched by approximate timestamp) to verify
  // the click landed on the expected target.
  const snapshot = readNekoPointerMapping(clientX, clientY);
  const interactionSeq = options.interactionSeq;
  const path = options.path ?? "fallback";
  return runWhenNekoControlReady("tap", () => {
    const control = nekoInstance?.control;
    if (!(control?.buttonDown && control.buttonUp)) {
      emitNekoDebug("neko.touch_scroll_bridge.control_unavailable", {
        interactionSeq,
        path,
        reason: "tap-send",
      });
      return false;
    }
    control.buttonDown(1, pos);
    control.buttonUp(1, pos);
    emitNekoDebug("neko.touch_scroll_bridge.tap", {
      ...snapshot,
      atMs: Date.now(),
      interactionSeq,
      path,
      pos,
    });
    return true;
  });
}

function clickNekoAt(touch: NekoTouchScrollPoint, options: { interactionSeq?: number; path?: string } = {}): boolean {
  return clickNekoAtPoint(touch.clientX, touch.clientY, options);
}

/**
 * Production terminal seam for an unscrolled fallback touch. Mounted viewers
 * must receive both halves through their settle-gated router; direct n.eko
 * control remains only for the legacy path without a dispatcher.
 */
export function deliverNekoFallbackTap(
  state: NekoFallbackTapState,
  touch: NekoTouchScrollPoint,
  dispatchInput?: NekoTouchScrollInputDispatcher
): void {
  if (!dispatchInput) {
    clickNekoAt(touch, { interactionSeq: state.interactionSeq, path: "fallback" });
    return;
  }
  dispatchInput({
    action: "pointerdown",
    button: 0,
    buttons: 1,
    pointerId: state.pointerId,
    pointerType: "touch",
    type: "pointer",
    x: touch.clientX,
    y: touch.clientY,
  });
  dispatchInput({
    action: "pointerup",
    button: 0,
    buttons: 0,
    pointerId: state.pointerId,
    pointerType: "touch",
    type: "pointer",
    x: touch.clientX,
    y: touch.clientY,
  });
}

function startMobileTouchScrollBridge(neko: NekoInstance, dispatchInput?: NekoTouchScrollInputDispatcher): void {
  stopMobileTouchScrollBridge();
  const streamRoot = wrapperEl;
  const listenerTarget = typeof document === "undefined" ? null : document;
  const control = neko.control;
  if (!(streamRoot && listenerTarget && control?.scroll && control.move && control.buttonDown && control.buttonUp)) {
    emitNekoDebug("neko.touch_scroll_bridge.skip", {
      hasControl: Boolean(control),
      hasTarget: Boolean(streamRoot),
      hasListenerTarget: Boolean(listenerTarget),
      reason: "missing-target-or-control",
    });
    return;
  }

  mobileTouchScrollBridgeAbortController = new AbortController();
  const { signal } = mobileTouchScrollBridgeAbortController;
  let state: NekoTouchScrollBridgeState | null = null;

  const enabled = () => shouldUseNekoTouchScrollBridge(readNekoTouchScrollBridgeEnvironment(neko));

  const eventStartedInStream = (event: TouchEvent) => {
    if (event.target instanceof Node && streamRoot.contains(event.target)) {
      return true;
    }
    if (event.target instanceof Element && event.target.closest("[data-pdpp-stream-ui]")) {
      return false;
    }
    const touch = event.changedTouches[0] ?? event.touches[0];
    return Boolean(
      touch &&
        isNekoTouchPointInsideRect({
          clientX: touch.clientX,
          clientY: touch.clientY,
          rect: streamRoot.getBoundingClientRect(),
        })
    );
  };

  const reset = (reason: string) => {
    if (!state) {
      return;
    }
    emitNekoDebug("neko.touch_scroll_bridge.reset", {
      interactionSeq: state.interactionSeq,
      mode: state.mode,
      reason,
      scrolling: state.scrolling,
    });
    state = null;
  };

  const onTouchStart = (event: TouchEvent) => {
    if (!eventStartedInStream(event)) {
      return;
    }
    if (event.touches.length !== 1) {
      reset("disabled-or-multitouch");
      return;
    }
    const touch = event.changedTouches[0] ?? event.touches[0];
    if (!touch) {
      return;
    }
    unlockNekoVideoPlayback();
    requestNekoControlForBridge("touchstart");
    const fallbackEnabled = enabled();
    const interactionSeq = nextNekoInteractionSeq();
    state = {
      accumulatedX: 0,
      accumulatedY: 0,
      id: touch.identifier,
      interactionSeq,
      lastX: touch.clientX,
      lastY: touch.clientY,
      mode: fallbackEnabled ? "fallback" : "native",
      scrolling: false,
      startTimeMs: Date.now(),
      startX: touch.clientX,
      startY: touch.clientY,
    };
    // Capture full mapping on touchstart — this is the authoritative
    // local-side record for the gesture's intended target. Correlate
    // against remote `playground.event` entries with similar timestamp
    // to verify the click landed where the user pressed.
    const startMapping = readNekoPointerMapping(touch.clientX, touch.clientY);
    const startReasons = detectNekoPointerMappingIssues(startMapping);
    emitNekoDebug("neko.touch.start", {
      ...startMapping,
      atMs: state.startTimeMs,
      interactionSeq,
      mode: state.mode,
      ...(startReasons.length > 0 ? { reasons: startReasons } : {}),
    });
    if (!fallbackEnabled) {
      emitNekoDebug("neko.touch_scroll_bridge.native_passthrough", {
        environment: readNekoTouchScrollBridgeEnvironment(neko),
        interactionSeq,
        phase: "touchstart",
      });
      return;
    }
    stopTouchEventForNekoBridge(event);
    emitNekoDebug("neko.touch_scroll_bridge.start", {
      environment: readNekoTouchScrollBridgeEnvironment(neko),
      interactionSeq,
    });
  };

  const onTouchMove = (event: TouchEvent) => {
    if (!state) {
      return;
    }
    const touch = changedTouchById(event, state.id);
    if (!touch) {
      return;
    }
    const scrolling =
      state.scrolling ||
      isNekoTouchScrollIntent({
        currentX: touch.clientX,
        currentY: touch.clientY,
        startX: state.startX,
        startY: state.startY,
      });
    if (state.mode === "native") {
      state = {
        ...state,
        lastX: touch.clientX,
        lastY: touch.clientY,
        scrolling,
      };
      return;
    }
    stopTouchEventForNekoBridge(event);
    if (!scrolling) {
      return;
    }
    state = sendNekoScrollSteps({ ...state, scrolling: true }, touch, dispatchInput);
  };

  const onTouchEnd = (event: TouchEvent) => {
    if (!state) {
      return;
    }
    const touch = changedTouchById(event, state.id);
    const elapsedMs = Date.now() - state.startTimeMs;
    const movedPx = touch
      ? Math.hypot(touch.clientX - state.startX, touch.clientY - state.startY)
      : Number.POSITIVE_INFINITY;
    const shouldClick =
      !state.scrolling &&
      Boolean(touch) &&
      elapsedMs <= NEKO_TOUCH_SCROLL_POLICY.clickMaxDurationMs &&
      movedPx < NEKO_TOUCH_SCROLL_POLICY.scrollIntentThresholdPx;
    if (state.mode === "native") {
      // Do NOT schedule a delayed `control.buttonDown/Up` here. n.eko's own
      // native touch path already delivers the click; a second synthetic
      // tap from PDPP would double-deliver and produce the "click registers
      // twice" / "modal closes immediately" / "button toggles back" pattern
      // observed on Brave Android. If a future environment proves n.eko's
      // native click is unreliable, restore this only behind a feature flag
      // and add a duplicate-delivery guard.
      if (shouldClick && touch) {
        const observedMapping = readNekoPointerMapping(touch.clientX, touch.clientY);
        emitNekoDebug("neko.touch_scroll_bridge.native_tap_observed", {
          ...observedMapping,
          atMs: Date.now(),
          elapsedMs,
          interactionSeq: state.interactionSeq,
          movedPx: Math.round(movedPx),
          path: "native",
        });
      }
      reset(shouldClick ? "native-tap-complete" : "native-touch-complete");
      return;
    }
    stopTouchEventForNekoBridge(event);
    completeNekoTouchScrollGesture(state, touch, dispatchInput);
    if (shouldClick && touch) {
      deliverNekoFallbackTap({ interactionSeq: state.interactionSeq, pointerId: state.id }, touch, dispatchInput);
    }
    reset(shouldClick ? "tap-complete" : "gesture-complete");
  };

  const onTouchCancel = (event: TouchEvent) => {
    if (state?.mode === "fallback") {
      stopTouchEventForNekoBridge(event);
      completeNekoTouchScrollGesture(state, changedTouchById(event, state.id), dispatchInput);
    }
    reset("touch-cancel");
  };

  listenerTarget.addEventListener("touchstart", onTouchStart, { capture: true, passive: false, signal });
  listenerTarget.addEventListener("touchmove", onTouchMove, { capture: true, passive: false, signal });
  listenerTarget.addEventListener("touchend", onTouchEnd, { capture: true, passive: false, signal });
  listenerTarget.addEventListener("touchcancel", onTouchCancel, { capture: true, passive: false, signal });
  requestNekoControlForBridge("attach");
  window.setTimeout(() => {
    if (!signal.aborted && nekoInstance === neko && neko.controlling !== true) {
      requestNekoControlForBridge("attach-retry");
    }
  }, 500);
  emitNekoDebug("neko.touch_scroll_bridge.attached", {
    environment: readNekoTouchScrollBridgeEnvironment(neko),
    target: "document",
  });
}

function stopMobileTouchScrollBridge(): void {
  mobileTouchScrollBridgeAbortController?.abort();
  mobileTouchScrollBridgeAbortController = null;
}

function scheduleMediaLayoutRefresh(reason: string, element: HTMLElement | null): void {
  const detail = {
    intrinsic: element ? getMediaIntrinsicSize(element) : null,
    reason,
    rect: element ? rectSnapshot(element) : null,
    tagName: element?.tagName.toLowerCase() ?? null,
  };
  emitNekoDebug("neko.client.layout.media-refresh", detail);
  window.dispatchEvent(new CustomEvent(NEKO_MEDIA_LAYOUT_EVENT, { detail }));
  onNextFrame(applyViewportLayout);
}

function configureNekoWebRtcReconnect(neko: NekoInstance): void {
  try {
    neko.setReconnectorConfig?.("webrtc", NEKO_WEBRTC_RECONNECT_CONFIG);
    emitNekoDebug("neko.client.webrtc_reconnect_config", {
      config: NEKO_WEBRTC_RECONNECT_CONFIG,
    });
  } catch (err) {
    emitNekoDebug("neko.client.webrtc_reconnect_config_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function attachMediaLayoutListeners(signal: AbortSignal): void {
  for (const mediaEl of getNekoMediaElements()) {
    if (mediaLayoutObservedElements.has(mediaEl)) {
      continue;
    }
    mediaLayoutObservedElements.add(mediaEl);
    const refresh = () => scheduleMediaLayoutRefresh("media-intrinsic-changed", mediaEl);
    mediaEl.addEventListener("resize", refresh, { signal });
    mediaEl.addEventListener("loadedmetadata", refresh, { signal });
    mediaEl.addEventListener("loadeddata", refresh, { signal });
    mediaEl.addEventListener("load", refresh, { signal });
    emitNekoDebug("neko.client.layout.media-observe", {
      intrinsic: getMediaIntrinsicSize(mediaEl),
      rect: rectSnapshot(mediaEl),
      tagName: mediaEl.tagName.toLowerCase(),
    });
  }
}

function startMediaLayoutBridge(): void {
  stopMediaLayoutBridge();
  mediaLayoutAbortController = new AbortController();
  mediaLayoutObservedElements = new WeakSet<HTMLElement>();
  const { signal } = mediaLayoutAbortController;
  attachMediaLayoutListeners(signal);
  mediaLayoutObserver = new MutationObserver(() => {
    attachMediaLayoutListeners(signal);
    scheduleMediaLayoutRefresh("media-dom-mutated", getPrimaryNekoMediaElement());
  });
  const root = nekoInstance?.$el;
  if (root) {
    mediaLayoutObserver.observe(root, { childList: true, subtree: true });
  }
}

function stopMediaLayoutBridge(): void {
  mediaLayoutAbortController?.abort();
  mediaLayoutAbortController = null;
  mediaLayoutObserver?.disconnect();
  mediaLayoutObserver = null;
  mediaLayoutObservedElements = new WeakSet<HTMLElement>();
}

function resetMediaLayout(mediaEl: HTMLElement): void {
  for (const property of ["width", "height", "left", "top", "max-width", "max-height", "object-fit", "transform"]) {
    mediaEl.style.removeProperty(property);
  }
}

function setMediaLayout(mediaEl: HTMLElement, property: string, value: string): void {
  mediaEl.style.setProperty(property, value, "important");
}

function getMediaIntrinsicSize(mediaEl: HTMLElement): { height: number; width: number } | null {
  if (mediaEl instanceof HTMLVideoElement && mediaEl.videoWidth > 0 && mediaEl.videoHeight > 0) {
    return { width: mediaEl.videoWidth, height: mediaEl.videoHeight };
  }
  if (mediaEl instanceof HTMLImageElement && mediaEl.naturalWidth > 0 && mediaEl.naturalHeight > 0) {
    return { width: mediaEl.naturalWidth, height: mediaEl.naturalHeight };
  }
  return null;
}

function getPrimaryNekoMediaElement(): HTMLElement | null {
  return (
    ((nekoInstance?.$el?.querySelector(".neko-container video, .neko-container img") as HTMLElement | null) || null) ??
    nekoInstance?._video ??
    null
  );
}

function getNekoMediaElements(): HTMLElement[] {
  return Array.from(
    nekoInstance?.$el?.querySelectorAll(".neko-container video, .neko-container img") ?? []
  ) as HTMLElement[];
}

function getNekoOverlayElements(): HTMLElement[] {
  return Array.from(nekoInstance?.$el?.querySelectorAll(".neko-container .neko-overlay") ?? []) as HTMLElement[];
}

function coverSize({
  capture,
  viewport,
}: {
  capture: { height: number; width: number };
  viewport: { height: number; width: number };
}): { height: number; left: number; top: number; width: number } {
  const scale = Math.max(viewport.width / capture.width, viewport.height / capture.height);
  const width = capture.width * scale;
  const height = capture.height * scale;
  return {
    height,
    left: (viewport.width - width) / 2,
    top: (viewport.height - height) / 2,
    width,
  };
}

export function readNekoMediaSettleSample(requested: NekoMediaSettleSample["requested"]): NekoMediaSettleSample | null {
  if (!nekoInstance) {
    return null;
  }
  const stats = nekoInstance.state?.connection?.webrtc?.stats;
  const screen = nekoInstance.state?.screen?.size;
  const mediaEl = getPrimaryNekoMediaElement();
  return {
    requested,
    screen:
      screen && screen.width > 0 && screen.height > 0
        ? {
            height: screen.height,
            width: screen.width,
          }
        : null,
    media: mediaEl ? getMediaIntrinsicSize(mediaEl) : null,
    inbound: stats
      ? {
          frameHeight: stats.height,
          frameWidth: stats.width,
          framesPerSecond: stats.fps,
          packetsLost: stats.packetLoss,
          timestampMs: Date.now(),
        }
      : null,
  };
}

function viewportLayoutMatchesContainer(layout: NekoViewportLayout, container: HTMLElement): boolean {
  const rect = container.getBoundingClientRect();
  return (
    Math.abs(Math.round(rect.width) - layout.viewportWidth) <= VIEWPORT_LAYOUT_CONTAINER_TOLERANCE_PX &&
    Math.abs(Math.round(rect.height) - layout.viewportHeight) <= VIEWPORT_LAYOUT_CONTAINER_TOLERANCE_PX
  );
}

function applyElementLayout(
  element: HTMLElement,
  display: { height: number | string; left: number | string; top: number | string; width: number | string },
  options: { objectFit?: "contain" | "fill" } = {}
): void {
  setMediaLayout(element, "width", typeof display.width === "number" ? `${display.width}px` : display.width);
  setMediaLayout(element, "height", typeof display.height === "number" ? `${display.height}px` : display.height);
  setMediaLayout(element, "left", typeof display.left === "number" ? `${display.left}px` : display.left);
  setMediaLayout(element, "top", typeof display.top === "number" ? `${display.top}px` : display.top);
  setMediaLayout(element, "max-width", "none");
  setMediaLayout(element, "max-height", "none");
  setMediaLayout(element, "transform", "translate3d(0,0,0)");
  if (options.objectFit) {
    setMediaLayout(element, "object-fit", options.objectFit);
  }
}

function applyPendingViewportLayout(
  container: HTMLElement,
  mediaEls: HTMLElement[],
  overlayEls: HTMLElement[],
  layout: NekoViewportLayout
): void {
  container.style.overflow = "hidden";
  const containerRect = container.getBoundingClientRect();
  const pendingViewport = {
    height: Math.max(1, containerRect.height),
    width: Math.max(1, containerRect.width),
  };
  const primaryMediaEl = getPrimaryNekoMediaElement();
  const primaryCaptureSize = selectNekoMediaSizeForLayout(
    layout,
    primaryMediaEl ? getMediaIntrinsicSize(primaryMediaEl) : null
  );
  // During mobile rotation the CSS container can flip before the remote capture
  // does. Cover the transient box so the operator sees a cropped live frame
  // rather than letterboxed black gutters.
  const overlayDisplay = coverSize({
    capture: primaryCaptureSize,
    viewport: pendingViewport,
  });
  for (const mediaEl of mediaEls) {
    const captureSize = selectNekoMediaSizeForLayout(layout, getMediaIntrinsicSize(mediaEl));
    const display = coverSize({
      capture: captureSize,
      viewport: pendingViewport,
    });
    applyElementLayout(mediaEl, display, { objectFit: "fill" });
  }
  for (const overlayEl of overlayEls) {
    applyElementLayout(overlayEl, overlayDisplay);
  }
  emitNekoDebug("neko.client.layout.pending", {
    container: rectSnapshot(container),
    layout,
    media: mediaEls.map((mediaEl) => ({
      capture: selectNekoMediaSizeForLayout(layout, getMediaIntrinsicSize(mediaEl)),
      intrinsic: getMediaIntrinsicSize(mediaEl),
      rect: rectSnapshot(mediaEl),
      tagName: mediaEl.tagName.toLowerCase(),
    })),
    overlayDisplay,
    overlays: overlayEls.map((overlayEl) => ({
      rect: rectSnapshot(overlayEl),
      tagName: overlayEl.tagName.toLowerCase(),
    })),
    reason: "container-viewport-mismatch",
  });
  emitNekoDebug("neko.viewport_layout_mismatch", {
    container: rectSnapshot(container),
    layout,
    mediaCount: mediaEls.length,
    overlayCount: overlayEls.length,
    reason: "container-viewport-mismatch",
  });
}

function applyViewportLayout(): void {
  if (!nekoInstance?._container) {
    emitNekoDebug("neko.client.layout.skip", {
      reason: "missing-container",
    });
    return;
  }

  const container = nekoInstance._container;
  const mediaEls = getNekoMediaElements();
  const overlayEls = getNekoOverlayElements();
  if (!viewportLayout) {
    container.style.overflow = "";
    for (const mediaEl of mediaEls) {
      resetMediaLayout(mediaEl);
    }
    for (const overlayEl of overlayEls) {
      resetMediaLayout(overlayEl);
    }
    // No settled layout means no authoritative geometry describes the
    // current surface — a retained mapping here would be pure staleness.
    clearLatestNekoPointerMapping();
    emitNekoDebug("neko.client.layout.reset", {
      container: rectSnapshot(container),
      mediaCount: mediaEls.length,
      overlayCount: overlayEls.length,
    });
    return;
  }

  if (!viewportLayoutMatchesContainer(viewportLayout, container)) {
    // Container/viewport mismatch (e.g. mid-rotation): neither the native
    // overlay nor screen-state authority is available in this window either
    // (see applyPendingViewportLayout), so a retained steady-state mapping
    // from before the mismatch must not be offered to the fallback chain.
    clearLatestNekoPointerMapping();
    applyPendingViewportLayout(container, mediaEls, overlayEls, viewportLayout);
    return;
  }

  const primaryMediaEl = getPrimaryNekoMediaElement();
  const screenSize = nekoInstance.state?.screen?.size;
  const primaryIntrinsic = primaryMediaEl ? getMediaIntrinsicSize(primaryMediaEl) : null;
  const screenStateSize = selectNekoScreenStateSizeForLayout(
    viewportLayout,
    primaryIntrinsic,
    screenSize ?? null,
    viewportLayoutUpdatesScreenState
  );

  if (screenSize) {
    screenSize.width = screenStateSize.width;
    screenSize.height = screenStateSize.height;
  }

  container.style.overflow = "hidden";
  const mediaDebug: Record<string, unknown>[] = [];
  let primaryPointerMapping: NekoMediaPointerMappingGeometry | null = null;
  for (const mediaEl of mediaEls) {
    const intrinsic = getMediaIntrinsicSize(mediaEl);
    // `NEKO_STEADY_STATE_DISPLAY_FIT` ("contain"): remote-surface 1.5.0's
    // `selectNekoMediaDisplayForLayout` accepts the host's steady-state fit
    // policy directly and returns the authoritative `displayRect`/
    // `overlayRect`/`pointerMapping` for it — PDPP no longer re-derives that
    // math locally (planes.md §6: "hosts MUST consume it, never re-derive
    // it"). `settling: true` (an orientation/aspect-mismatch transient)
    // still forces cover internally regardless of the requested policy, so
    // this call is safe to make unconditionally here; the transient
    // container-mismatch branch above (`applyPendingViewportLayout`) never
    // reaches this line and keeps its own separate, deliberate cover
    // behavior untouched.
    const selection = selectNekoMediaDisplayForLayout(viewportLayout, intrinsic, NEKO_STEADY_STATE_DISPLAY_FIT);
    const { displayRect } = selection;
    const display = {
      height: displayRect.height,
      left: displayRect.offsetX,
      top: displayRect.offsetY,
      width: displayRect.width,
    };
    const mediaScaleX = selection.pointerMapping.scaleX;
    const mediaScaleY = selection.pointerMapping.scaleY;
    applyElementLayout(mediaEl, display, { objectFit: "fill" });
    if (mediaEl === primaryMediaEl) {
      primaryPointerMapping = selection.pointerMapping;
    }
    mediaDebug.push({
      captureHeight: selection.height,
      captureSource: selection.source,
      captureWidth: selection.width,
      displayHeight: display.height,
      displayLeft: display.left,
      displayTop: display.top,
      displayWidth: display.width,
      fit: selection.fit,
      intrinsic,
      intrinsicCompatibility: selection.intrinsicCompatibility,
      mediaHeight: display.height,
      mediaWidth: display.width,
      scaleX: mediaScaleX,
      scaleY: mediaScaleY,
      settling: selection.settling,
      tagName: mediaEl.tagName.toLowerCase(),
    });
  }
  const overlaySelection = selectNekoMediaDisplayForLayout(
    viewportLayout,
    primaryIntrinsic,
    NEKO_STEADY_STATE_DISPLAY_FIT
  );
  const overlayDisplay = {
    height: overlaySelection.overlayRect.height,
    left: overlaySelection.overlayRect.offsetX,
    top: overlaySelection.overlayRect.offsetY,
    width: overlaySelection.overlayRect.width,
  };
  for (const overlayEl of overlayEls) {
    applyElementLayout(overlayEl, overlayDisplay);
  }
  // Authoritative inverse geometry for the primary media element, kept for
  // pointer mapping (`getNekoControlPos`'s fallback-2 path) so it reads the
  // SAME transform this layout pass just applied, rather than re-deriving
  // scale/offset from the media element's live rect independently.
  setLatestNekoPointerMapping(primaryPointerMapping ?? overlaySelection.pointerMapping);

  if (typeof nekoInstance.onResize === "function") {
    nekoInstance.onResize();
  }
  emitNekoDebug("neko.client.layout.applied", {
    container: rectSnapshot(container),
    layout: viewportLayout,
    media: mediaDebug.map((media, index) => ({
      ...media,
      rect: rectSnapshot(mediaEls[index] ?? null),
    })),
    overlayDisplay,
    overlays: overlayEls.map((overlayEl) => ({
      rect: rectSnapshot(overlayEl),
      tagName: overlayEl.tagName.toLowerCase(),
    })),
    screenStateSource: screenStateSize.source,
    screenStateUpdatesAllowed: viewportLayoutUpdatesScreenState,
    screenState: screenStateSnapshot(),
  });
  emitNekoDebug("neko.viewport_layout_applied", {
    container: rectSnapshot(container),
    layout: viewportLayout,
    media: mediaDebug.map((media, index) => ({
      ...media,
      rect: rectSnapshot(mediaEls[index] ?? null),
    })),
    overlayDisplay,
    overlays: overlayEls.map((overlayEl) => ({
      rect: rectSnapshot(overlayEl),
      tagName: overlayEl.tagName.toLowerCase(),
    })),
  });
}

export async function startNeko(
  container: HTMLElement,
  config: NekoClientConfig,
  options: StartNekoOptions = {}
): Promise<void> {
  stopNeko(container);

  wrapperEl = document.createElement("div");
  wrapperEl.dataset.pdppNekoClient = "true";
  wrapperEl.style.cssText = "position:absolute;inset:0;width:100%;height:100%;z-index:5;";
  container.appendChild(wrapperEl);

  mountEl = document.createElement("div");
  mountEl.style.cssText = "width:100%;height:100%;";
  wrapperEl.appendChild(mountEl);

  const module = await import("@demodesk/neko");
  const NekoComponent = (module.default ?? module) as unknown as new (options: {
    propsData?: Record<string, unknown>;
  }) => NekoInstance;
  const neko = new NekoComponent({
    propsData: buildNekoClientProps(),
  });
  suppressNekoCursorChrome(neko);
  // The polished PDPP surface is WebRTC-only. n.eko's JPEG screencast fallback
  // is rendered through an <img>, which cannot carry n.eko's bearer token and
  // produces a harmless-but-noisy 401 before WebRTC connects.
  if (neko.state?.connection) {
    neko.state.connection.screencast = false;
  }
  configureNekoWebRtcReconnect(neko);
  emitNekoDebug("neko.client.start", {
    hasServerPath: Boolean(config.serverPath),
    hasStatusPath: Boolean(config.statusPath),
  });

  neko.$mount?.(mountEl);
  nekoInstance = neko;

  try {
    await neko.setUrl?.(config.serverPath);
    const login = config.login ?? { username: "user", password: "neko" };
    await neko.login?.(login.username, login.password);
    selectPreferredNekoVideoStream(neko);
    neko.connect?.();
    emitNekoDebug("neko.client.webrtc_handoff_requested", {
      reconnectConfig: NEKO_WEBRTC_RECONNECT_CONFIG,
    });
    neko.setTouchEnabled?.(true);
    suppressNekoCursorChrome(neko);
    startClipboardWriteGuard();
    startControlPasteGuard();
    startMobileTextInputGuard();
    startClipboardBridge();
    startVideoPlaybackBridge();
    startNekoPointerTelemetry();
    startMobileTouchScrollBridge(neko, options.dispatchInput);
    startMediaLayoutBridge();
    neko.events?.on?.("room.screen.updated", () => {
      onNextFrame(applyViewportLayout);
    });

    focusInterval = setInterval(() => {
      if (!remoteInputFocused) {
        return;
      }
      if (hasCoarsePointer()) {
        return;
      }
      const textarea = getOverlayTextarea();
      if (textarea && document.activeElement !== textarea) {
        const active = document.activeElement;
        const isPdppUi = active instanceof Element && active.closest("[data-pdpp-stream-ui]");
        const isPdppSoftKeyboard = active instanceof Element && isPdppSoftKeyboardElement(active);
        if (!(isPdppUi || isPdppSoftKeyboard || hasUiTextSelection())) {
          textarea.focus();
        }
      }
    }, 2000);
  } catch (err) {
    stopNeko(container);
    throw err;
  }
}

export function setNekoRemoteInputFocused(focused: boolean): void {
  remoteInputFocused = focused;
  emitNekoDebug("neko.keyboard_focus", {
    focused,
    source: "server",
    ...overlayDebugSnapshot(),
  });
}

export function setNekoRemoteCopyFallback(fallback: (() => void) | null): void {
  remoteCopyFallback = fallback;
}

export function isNekoRemoteInputFocused(): boolean {
  return remoteInputFocused;
}

export interface NekoSetViewportLayoutOptions {
  /**
   * Live measured rect of the actual stream container (e.g. the Stage-2 Dialog
   * popup observed via ResizeObserver). When provided, it is preferred over
   * the document/window viewport for matching the n.eko container. This is the
   * source of truth for stage-2 dialog sizing — the synthesized viewport
   * snapshot can lag the dialog mount and select the wrong screen mode.
   */
  containerRect?: { height: number; width: number } | null;
}

export function setNekoViewportLayout(
  layout: NekoViewportLayout | null,
  options: NekoSetViewportLayoutOptions = {}
): void {
  viewportLayoutUpdatesScreenState = true;
  viewportLayout = applyContainerRectOverride(layout, options.containerRect);
  applyViewportLayout();
  onNextFrame(applyViewportLayout);
}

export function setNekoPresentationViewportLayout(
  layout: NekoViewportLayout | null,
  options: NekoSetViewportLayoutOptions = {}
): void {
  viewportLayoutUpdatesScreenState = false;
  viewportLayout = applyContainerRectOverride(layout, options.containerRect);
  applyViewportLayout();
  onNextFrame(applyViewportLayout);
}

// Width delta that must be present for an embedded-container override to fire.
// A genuine Stage-2 dialog / sub-card embedding changes the available width
// (e.g. desktop floating dialog shrinks the stream container). Soft-keyboard
// resize and visualViewport churn change height while keeping width
// identical — those must NOT trigger this override, because the page-side
// CSS layout (and n.eko's screen mode) still owns the truth in that case.
const NEKO_CONTAINER_OVERRIDE_MIN_WIDTH_DELTA_PX = 4;

function applyContainerRectOverride(
  layout: NekoViewportLayout | null,
  containerRect: { height: number; width: number } | null | undefined
): NekoViewportLayout | null {
  if (!layout) {
    return null;
  }
  if (!(containerRect && containerRect.width > 0 && containerRect.height > 0)) {
    return layout;
  }
  const overrideWidth = Math.max(1, Math.round(containerRect.width));
  const overrideHeight = Math.max(1, Math.round(containerRect.height));
  if (overrideWidth === layout.viewportWidth && overrideHeight === layout.viewportHeight) {
    return layout;
  }
  // Only apply the override when the *width* has materially changed.
  // Height-only deltas come from soft-keyboard / visualViewport churn and
  // must defer to the stable presentation viewport — the page on the
  // remote browser is still rendered for the originally-posted height.
  // Letting the override change layout.viewportHeight in that case
  // produces cover-crop or a bottom whitespace strip (the user-visible
  // "tiny pinned left huge white" symptom).
  const widthDeltaPx = Math.abs(overrideWidth - layout.viewportWidth);
  if (widthDeltaPx < NEKO_CONTAINER_OVERRIDE_MIN_WIDTH_DELTA_PX) {
    emitNekoDebug("neko.viewport_layout.container_rect_override.skipped", {
      layout,
      override: { height: overrideHeight, width: overrideWidth },
      reason: "height-only-delta",
      widthDeltaPx,
    });
    return layout;
  }
  emitNekoDebug("neko.viewport_layout.container_rect_override", {
    layout,
    override: { height: overrideHeight, width: overrideWidth },
    reason: "embedded-width-mismatch",
    widthDeltaPx,
  });
  return {
    ...layout,
    viewportHeight: overrideHeight,
    viewportWidth: overrideWidth,
  };
}

function focusOverlayTextarea(source: string): boolean {
  startMobileTextInputGuard();
  const textarea = getOverlayTextarea();
  if (textarea) {
    // Avoid n.eko's mobileKeyboardShow(): it hides the keyboard on the second
    // visualViewport resize, which Android can emit during a single open.
    textarea.focus({ preventScroll: true });
    const active = document.activeElement === textarea;
    emitNekoDebug("neko.keyboard_focus_overlay", {
      active,
      source,
      ...overlayDebugSnapshot(),
    });
    return active;
  }
  emitNekoDebug("neko.keyboard_focus_overlay", {
    active: false,
    reason: "missing-overlay-textarea",
    source,
    ...overlayDebugSnapshot(),
  });
  return false;
}

export function focusNekoKeyboard(): void {
  remoteInputFocused = true;
  focusOverlayTextarea("focus");
}

export function focusNekoKeyboardFromLocalGesture(): NekoKeyboardFocusAttempt {
  if (remoteInputFocused) {
    return {
      active: focusOverlayTextarea("local-gesture"),
      focused: true,
      optimistic: false,
      reason: "remote-input-focused",
    };
  }
  return {
    active: document.activeElement === getOverlayTextarea(),
    focused: false,
    optimistic: false,
    reason: "remote-input-not-focused",
  };
}

export function blurNekoKeyboard(): void {
  remoteInputFocused = false;
  const textarea = getOverlayTextarea();
  const shouldBlurActive = document.activeElement instanceof HTMLElement && document.activeElement === textarea;
  if (textarea) {
    textarea.blur();
  }
  if (shouldBlurActive && document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
  emitNekoDebug("neko.keyboard_focus_overlay", {
    active: false,
    source: "blur",
    ...overlayDebugSnapshot(),
  });
}

export function stopNeko(container: HTMLElement): void {
  if (focusInterval) {
    clearInterval(focusInterval);
    focusInterval = null;
  }
  stopClipboardBridge();
  stopMobileTextInputGuard();
  stopControlPasteGuard();
  stopClipboardWriteGuard();
  stopVideoPlaybackBridge();
  stopNekoPointerTelemetry();
  stopMobileTouchScrollBridge();
  stopMediaLayoutBridge();
  remoteInputFocused = false;
  viewportLayout = null;
  // The mapping describes a transform for the surface being torn down here;
  // a remount (same or different browser session) must start every fallback
  // read from a clean slate rather than inheriting the outgoing instance's
  // scale/offset.
  clearLatestNekoPointerMapping();

  const instance = nekoInstance;
  const rootEl = instance?.$el as Node | null;
  const wrapper = wrapperEl;

  if (instance) {
    instance.$destroy?.();
    nekoInstance = null;
  }

  if (wrapper?.parentNode) {
    wrapper.parentNode.removeChild(wrapper);
  } else if (rootEl?.parentNode && container.contains(rootEl)) {
    rootEl.parentNode.removeChild(rootEl);
  }

  wrapperEl = null;
  mountEl = null;
}

// ── Exports consumed by @opendatalabs/remote-surface NekoClientApi shim ──────
// These are narrow accessors over module-private state so the
// stream-viewer can construct a NekoSurfaceAdapter without importing
// neko-client.ts internals into the package. They are additive — no
// neko-client.ts behavior changes.
export function getNekoPointerControlForAdapter(): NekoInstance["control"] | null {
  return nekoInstance?.control ?? null;
}

export function mapNekoPointerToRemoteForAdapter(clientX: number, clientY: number): NekoControlPos | null {
  return getNekoControlPos(clientX, clientY);
}

/**
 * Dispatch a single raw X11 keysym press+release at the remote n.eko.
 * Used by MobileTextInputController for special keys (Backspace, Enter,
 * Arrow keys, F-keys). Wraps `nekoInstance.control.keyPress(keysym)`
 * (verified in @demodesk/neko bundle L23746). Returns true on success.
 */
export function dispatchNekoKeysymForAdapter(keysym: number): boolean {
  const control = nekoInstance?.control;
  if (typeof control?.keyPress === "function") {
    control.keyPress(keysym);
    return true;
  }
  // Fallback: keyDown + keyUp pair if keyPress is missing on this build.
  if (typeof control?.keyDown === "function" && typeof control?.keyUp === "function") {
    control.keyDown(keysym);
    control.keyUp(keysym);
    return true;
  }
  return false;
}
