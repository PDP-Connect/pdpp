/** biome-ignore-all lint/a11y/noNoninteractiveElementInteractions: ARIA application surface forwards
 * pointer/keyboard input to the streamed browser session — there is no underlying interactive
 * semantic to fall back to. */
/** biome-ignore-all lint/a11y/noNoninteractiveTabindex: focusable so the surface receives keystrokes
 * for the streaming companion. */
/** biome-ignore-all lint/correctness/useImageSize: streaming frames are dynamic data URLs at the
 * active viewport size; the container's aspect-ratio style avoids layout shift. */
/** biome-ignore-all lint/performance/noImgElement: streaming frames are base64 data URLs that change
 * many times per second — Next.js <Image> would re-run optimization for each frame. */
"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type TouchEvent as ReactTouchEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { PdppLogo } from "@/components/pdpp-logo.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogBackdrop,
  DialogDescription,
  DialogPopup,
  DialogPortal,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { dashboardRoutes } from "../../../components/views/routes.ts";
import { type MintedStreamSession, mintStreamSessionAction } from "./actions.ts";
import {
  blurNekoKeyboard,
  copyRemoteSelectionFromNeko,
  focusNekoKeyboard,
  type NekoClientConfig,
  pasteLocalClipboardIntoNeko,
  pasteTextIntoNeko,
  readNekoMediaSettleSample,
  setNekoPresentationViewportLayout,
  setNekoRemoteCopyFallback,
  setNekoRemoteInputFocused,
  setNekoViewportLayout,
  startNeko,
  stopNeko,
} from "./neko-client.ts";
import {
  assessClipboardCapabilities,
  type ClipboardCapabilities,
  type ClipboardDirectionPolicy,
  type ClipboardHelperMode,
  type ClipboardPolicyDecision,
  classifyClipboardBrowser,
  clipboardLengthBucket,
  decideClipboardPolicy,
} from "./stream-clipboard-policy.ts";
import {
  assessMobileKeyboardViewportResize,
  buildViewportPayload,
  createMobileKeyboardResizeState,
  type LocalViewportSample,
  pointToStreamViewport,
  type ViewportPayload,
  viewportPayloadsAreEquivalent,
} from "./stream-geometry.ts";
import { assessNekoMediaSettle, createNekoMediaSettleState } from "./stream-media-settle.ts";
import {
  createStreamViewerControlState,
  localSurfaceCanDisplayPresentation,
  nextPresentationKeyboardHoldUntilMs,
  nextPresentationOrientationHoldUntilMs,
  presentationViewportsMatch,
  reduceStreamViewerControl,
  stablePresentationContainerRect,
  type StreamViewerCommand,
  shouldDebouncePresentationViewportUpdate,
  shouldHoldPresentationViewportForKeyboard,
} from "./stream-viewer-control.ts";
import {
  parseAttachedMessage,
  parseBackendReadyMessage,
  parseClipboardMessage,
  parseFrameMessage,
  parseKeyboardFocusMessage,
  parsePopupClosedMessage,
  parsePopupOpenedMessage,
  parseStreamErrorMessage,
  parseUrlChangedMessage,
} from "./stream-viewer-protocol.ts";
import type { ViewportObservation } from "./stream-viewport-classifier.ts";
import {
  computePixelFitTelemetry,
  computeStreamCaptureTargetForContext,
  sampleVideoSharpnessTelemetry,
} from "./stream-visual-quality.ts";
import { STREAMING_UNAVAILABLE_TAG } from "./streaming-protocol.ts";

interface ConnectorContext {
  connectorId: string;
  displayName: string;
}

interface StreamSurfaceProps {
  /** Open the Stage-2 overlay on mount (preview only). */
  autoOpen?: boolean;
  connector: ConnectorContext | null;
  interactionId: string;
  interactionKind: string;
  interactionMessage: string;
  runId: string;
}

interface NekoSessionInfo {
  browserOwnerMode?: string | null;
  clientConfigPath: string;
  stealthMode?: string | null;
}

interface NekoClientConfigResponse {
  login?: {
    password?: string;
    username?: string;
  } | null;
  object?: string;
  server_path?: string;
  status_path?: string;
}

interface NekoStatusSnapshot {
  page: Record<string, unknown> | null;
  pageCdpAvailable: boolean | null;
  pageMetricsMismatch: Record<string, unknown> | null;
  pageMetricsMismatchAfterReapply: Record<string, unknown> | null;
  /** Drained ring buffer of remote-page click/focus/scroll telemetry. */
  playgroundEvents: Array<Record<string, unknown>> | null;
  screen: { height: number; width: number } | null;
}

/**
 * The location label rendered in the overlay corner. Built from `url_changed`
 * events. Hostname is the safety signal ("am I on the right site?"); the
 * pathname adds context when present. Title rides along as a hover tooltip.
 */
interface LocationInfo {
  hostname: string;
  pathname: string;
  title: string | null;
}

/** Currently-announced popup. We only ever surface one at a time. */
interface PopupNotice {
  message: string;
  /** The targetId of the popup. `popup_closed` matches against this. */
  targetId: string;
}

interface RemoteClipboardBuffer {
  receivedAt: number;
  text: string;
}

interface VirtualKeyboardController {
  boundingRect?: DOMRectReadOnly;
  overlaysContent?: boolean;
}

type NavigatorWithVirtualKeyboard = Navigator & {
  virtualKeyboard?: VirtualKeyboardController;
};

/**
 * Auto-dismiss for popup toasts. Long enough to read, short enough to not
 * loiter. Matches the spec's ~6s.
 */
const POPUP_TOAST_TIMEOUT_MS = 6000;
const CLIPBOARD_NOTICE_TIMEOUT_MS = 3500;
const MOBILE_USER_AGENT_RE = /Android|iPhone|iPad|iPod|Mobile/i;
const TRAILING_SLASH_RE = /\/$/;
const DEFAULT_CLIPBOARD_DIRECTION_POLICY: ClipboardDirectionPolicy = "bidirectional-text";
const DEFAULT_CLIPBOARD_HELPER_MODE: ClipboardHelperMode = "balanced";

/**
 * Parse a URL into a hostname + pathname display tuple. The protocol is
 * intentionally omitted — operators care about *where* not *how*. SSE may
 * forward strings that aren't a valid URL (e.g. `about:blank`); when parsing
 * fails we return null and the label hides itself.
 */
function parseLocation(url: string, title?: string): LocationInfo | null {
  if (typeof url !== "string" || url.length === 0) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // Skip non-http(s) schemes — chrome://, about:, devtools://, etc. don't help
  // an operator and would clutter the chrome.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  return {
    hostname: parsed.hostname,
    pathname: parsed.pathname === "/" ? "" : parsed.pathname,
    title: typeof title === "string" && title.length > 0 ? title : null,
  };
}

/**
 * User-visible state. The brief is firm that operators don't need protocol
 * vocabulary; everything the operator sees collapses to these three.
 */
type DisplayState = "connecting" | "live" | "trouble";

/**
 * Internal cause of trouble — used to phrase the orientation-card message
 * when the overlay closes back to Stage 1, and to gate auto-retry.
 */
type TroubleCause = "expired" | "unavailable" | "network" | null;

interface ConnectionStatus {
  cause: TroubleCause;
  display: DisplayState;
  /** Short single sentence shown only when display === "trouble". */
  troubleMessage: string | null;
}

const CONNECTING: ConnectionStatus = { display: "connecting", cause: null, troubleMessage: null };
const LIVE: ConnectionStatus = { display: "live", cause: null, troubleMessage: null };

const SUPPORTED_KINDS = new Set(["manual_action"]);

// Poll the run timeline so the resolved success state appears the instant
// the controller observes the upstream interaction is satisfied. The SSE
// channel won't tell us this — the authoritative signal is the timeline.
const RESOLUTION_POLL_MS = 2500;

/**
 * Reconnect backoff (ms). EventSource's built-in retry is dumb (constant
 * delay, no awareness of token death), so we replace it: close the socket on
 * error, schedule the next attach with exponential backoff capped at 8s, and
 * give up after MAX_RECONNECT_ATTEMPTS to avoid infinite-retry on a
 * permanently broken server.
 */
const RECONNECT_BACKOFF_MS = [500, 1000, 2000, 4000, 8000] as const;
const MAX_RECONNECT_ATTEMPTS = 10;
/**
 * Server contract: token death (401/410) is signalled via HTTP status during
 * attach, BEFORE the SSE stream opens — EventSource collapses this to a
 * generic `error` event with no status code (browser-spec limitation). After
 * this many *consecutive* failures with no successful `attached` event in
 * between, we assume the token is dead and re-mint a fresh session.
 * `reference-implementation/server/streaming/routes.js:235` returns 401/410
 * before `res.hijack()`; only `companion_start_failed` (line 367) emits a
 * structured `error` event mid-stream, which we handle separately.
 */
const TOKEN_DEAD_FAILURE_THRESHOLD = 3;

const STREAM_VIEWER_POLICY = {
  // One place for timing policy: resize sources are noisy on mobile, but every
  // delayed action below has a named UX reason and a replayable control test.
  keyboardRemoteBlurGraceMs: 350,
  nekoMediaSettleMaxPolls: 8,
  nekoMediaSettlePollMs: 250,
  nekoStatusPollAttempts: 20,
  nekoStatusPollMs: 50,
  orientationSettleFollowUpMs: 300,
  orientationFollowUpMs: [350, 700] as const,
  presentationKeyboardCloseHoldMs: 700,
  presentationKeyboardOpenHoldMs: 900,
  presentationOrientationHoldMs: 700,
  presentationResizeDebounceMs: 120,
  viewportResizeDebounceMs: 200,
};
const MAX_COVER_CROP_RATIO = 0.07;
const VERTICAL_CROP_WEIGHT = 2;
const STREAM_DEBUG_ENDPOINT = "/api/stream-debug";
const STREAM_DEBUG_EVENT = "pdpp:stream-debug";
const STREAM_DEBUG_BATCH_SIZE = 20;
const STREAM_DEBUG_FLUSH_MS = 750;
const STREAM_DEBUG_POINTER_MOVE_MS = 250;
const STREAM_DEBUG_VISUAL_QUALITY_MS = 1000;
const STREAM_DEBUG_EMPTY_AREA_ISSUE_RATIO = 0.015;
const STREAM_DEBUG_STRETCH_ISSUE_RATIO = 1.03;

type StreamDebugPayload = Record<string, unknown>;
type StreamDebugLogger = (type: string, payload?: StreamDebugPayload) => void;

interface StreamDebugEventRecord {
  at: string;
  connectorName: string;
  interactionId: string;
  payload: StreamDebugPayload;
  runId: string;
  seq: number;
  type: string;
  viewerId: string;
}

function classifyMintError(err: unknown): ConnectionStatus {
  const message = err instanceof Error ? err.message : String(err);
  if (message.startsWith(STREAMING_UNAVAILABLE_TAG)) {
    return {
      display: "trouble",
      cause: "unavailable",
      troubleMessage: "The browser stream isn't available right now.",
    };
  }
  if (message.includes("expired") || message.includes("not_found")) {
    return {
      display: "trouble",
      cause: "expired",
      troubleMessage: "Session expired. Try again to start a fresh one.",
    };
  }
  return {
    display: "trouble",
    cause: "network",
    troubleMessage: "Couldn't reach the browser stream.",
  };
}

// ─── Stage-1 orientation surface (also hosts the Stage-2 overlay) ────────────

/**
 * The single screen an operator lands on from a phone notification.
 *
 * Stage 1: a calm, centred orientation card with one sentence and one button.
 * Stage 2: tapping the button opens a Dialog overlay containing the live
 *          stream. The stream IS the surface — no chrome around it.
 *
 * Polls the run timeline; when the underlying interaction resolves the page
 * re-renders into <ResolvedSurface>.
 */
/**
 * Generate a fresh client UUID for the mint idempotency key. Falls back to a
 * timestamp + Math.random combo on older browsers that lack `crypto.randomUUID`
 * (rare in 2026 but cheap insurance — the server only uses the key as an
 * opaque cache key, not for security).
 */
function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `mk-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Compute the operator's current viewport for the mint request. Server-only
 * pre-render returns `undefined` (the viewer is a client component, but the
 * helper guards against accidental SSR call sites).
 */
function readViewerViewport(width: number, height: number) {
  if (typeof window === "undefined") {
    return;
  }
  const hasTouch = window.navigator.maxTouchPoints > 0 || "ontouchstart" in window;
  let coarsePointer = false;
  try {
    coarsePointer = window.matchMedia("(pointer: coarse)").matches;
  } catch {
    coarsePointer = false;
  }
  const deviceScaleFactor = window.devicePixelRatio || 1;
  const mobile = coarsePointer || MOBILE_USER_AGENT_RE.test(window.navigator.userAgent);
  const captureTarget = computeStreamCaptureTargetForContext({
    devicePixelRatio: deviceScaleFactor,
    highDprCapture: mobile,
    viewport: { width, height },
  });
  return buildViewportPayload({
    width,
    height,
    deviceScaleFactor,
    hasTouch,
    mobile,
    screenHeight: captureTarget.height,
    screenWidth: captureTarget.width,
    userAgent: window.navigator.userAgent,
  });
}

type StreamViewportInfo = Pick<ViewportPayload, "height" | "screenHeight" | "screenWidth" | "width"> & {
  deviceScaleFactor?: number;
};

function viewportInfoFromPayload(viewport: ViewportPayload): StreamViewportInfo {
  return {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: viewport.deviceScaleFactor,
    screenWidth: viewport.screenWidth,
    screenHeight: viewport.screenHeight,
  };
}

function viewportCaptureSize(viewport: StreamViewportInfo): { height: number; width: number } {
  return {
    width: viewport.screenWidth ?? viewport.width,
    height: viewport.screenHeight ?? viewport.height,
  };
}

function streamViewportInfosMatch(
  a: StreamViewportInfo | null | undefined,
  b: StreamViewportInfo | null | undefined
): boolean {
  return (
    presentationViewportsMatch(a ?? null, b ?? null) &&
    presentationViewportsMatch(a ? viewportCaptureSize(a) : null, b ? viewportCaptureSize(b) : null)
  );
}

function readContainerRect(node: Element | null): { height: number; width: number } | null {
  if (!node) {
    return null;
  }
  const rect = node.getBoundingClientRect();
  if (!(rect.width > 0 && rect.height > 0)) {
    return null;
  }
  return {
    height: Math.max(1, Math.round(rect.height)),
    width: Math.max(1, Math.round(rect.width)),
  };
}

function viewportLayoutFromInfo(viewport: StreamViewportInfo) {
  const capture = viewportCaptureSize(viewport);
  return {
    screenHeight: capture.height,
    screenWidth: capture.width,
    viewportHeight: viewport.height,
    viewportWidth: viewport.width,
  };
}

interface ViewportPostDecision {
  action: "post" | "skip" | "suppress";
  reason: string;
}

function decideViewportPost({
  controlCommand,
  force,
  keyboardResizeSuppress,
  previous,
  viewport,
}: {
  controlCommand: StreamViewerCommand | null;
  force: boolean;
  keyboardResizeSuppress: boolean;
  previous: ViewportPayload | null;
  viewport: ViewportPayload;
}): ViewportPostDecision {
  if (!force && keyboardResizeSuppress) {
    return { action: "suppress", reason: "keyboard-resize" };
  }
  if (!force && controlCommand?.type === "viewport.hold") {
    return { action: "suppress", reason: controlCommand.reason };
  }
  if (!force && viewportPayloadsAreEquivalent(previous, viewport)) {
    return { action: "skip", reason: "equivalent-viewport" };
  }
  return {
    action: "post",
    reason: controlCommand?.type === "viewport.post" ? controlCommand.reason : "post",
  };
}

function readPointerCoarse(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    return window.matchMedia("(pointer: coarse)").matches;
  } catch {
    return false;
  }
}

function readClipboardCapabilities(): ClipboardCapabilities {
  const nav = typeof navigator === "undefined" ? null : navigator;
  const clipboard = nav?.clipboard;
  const userAgent = nav?.userAgent ?? "";
  let topLevel = false;
  try {
    topLevel = typeof window !== "undefined" && window.self === window.top;
  } catch {
    topLevel = false;
  }
  return assessClipboardCapabilities({
    browserFamily: classifyClipboardBrowser(userAgent),
    clipboardChangeEventAvailable: typeof window !== "undefined" && "ClipboardChangeEvent" in window,
    isSecureContext: typeof window === "undefined" ? false : window.isSecureContext,
    pointerCoarse: readPointerCoarse(),
    readPermission: "unknown",
    readTextAvailable: typeof clipboard?.readText === "function",
    topLevel,
    userAgent,
    writePermission: "unknown",
    writeTextAvailable: typeof clipboard?.writeText === "function",
  });
}

function useClipboardCapabilities(): ClipboardCapabilities {
  const [capabilities, setCapabilities] = useState(readClipboardCapabilities);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const update = () => setCapabilities(readClipboardCapabilities());
    const mql = window.matchMedia("(pointer: coarse)");
    mql.addEventListener?.("change", update);
    update();
    return () => {
      mql.removeEventListener?.("change", update);
    };
  }, []);

  return capabilities;
}

function normalizeClipboardHelperMode(value: string | null | undefined): ClipboardHelperMode {
  return value === "strict" || value === "assistive" || value === "balanced" ? value : DEFAULT_CLIPBOARD_HELPER_MODE;
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

function createStreamDebugViewerId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `viewer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function rectSnapshot(element: Element | null): StreamDebugPayload | null {
  if (!element) {
    return null;
  }
  const rect = element.getBoundingClientRect();
  return {
    blockSize: Math.round(rect.height),
    inlineSize: Math.round(rect.width),
    left: Math.round(rect.left),
    top: Math.round(rect.top),
  };
}

function cssBoxSnapshot(element: Element | null) {
  if (!element) {
    return null;
  }
  const rect = element.getBoundingClientRect();
  return {
    height: rect.height,
    left: rect.left,
    top: rect.top,
    width: rect.width,
  };
}

function elementDebugSnapshot(target: EventTarget | null): StreamDebugPayload | null {
  const element = target instanceof Element ? target : null;
  if (!element) {
    return null;
  }
  return {
    ariaHidden: element.getAttribute("aria-hidden"),
    contentEditable: element instanceof HTMLElement ? element.isContentEditable : false,
    inputMode: element instanceof HTMLElement ? element.inputMode || null : null,
    isNekoOverlay: Boolean(element.closest("textarea.overlay, textarea.neko-overlay")),
    isPdppUi: Boolean(element.closest("[data-pdpp-stream-ui]")),
    role: element.getAttribute("role"),
    tagName: element.tagName.toLowerCase(),
    type: element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.type : null,
  };
}

function activeElementDebugSnapshot(): StreamDebugPayload | null {
  if (typeof document === "undefined") {
    return null;
  }
  return elementDebugSnapshot(document.activeElement);
}

function clipboardDebugMetadata(text: string, extra: StreamDebugPayload = {}): StreamDebugPayload {
  return {
    ...extra,
    length: text.length,
    lengthBucket: clipboardLengthBucket(text),
  };
}

function mediaIntrinsicDebugSnapshot(element: Element): StreamDebugPayload | null {
  if (element instanceof HTMLVideoElement) {
    return { height: element.videoHeight, width: element.videoWidth };
  }
  if (element instanceof HTMLImageElement) {
    return { height: element.naturalHeight, width: element.naturalWidth };
  }
  return null;
}

function mediaPlaybackQualitySnapshot(element: Element): StreamDebugPayload | null {
  if (!(element instanceof HTMLVideoElement) || typeof element.getVideoPlaybackQuality !== "function") {
    return null;
  }
  const quality = element.getVideoPlaybackQuality();
  return {
    corruptedVideoFrames: quality.corruptedVideoFrames,
    creationTime: Math.round(quality.creationTime),
    droppedVideoFrames: quality.droppedVideoFrames,
    totalVideoFrames: quality.totalVideoFrames,
  };
}

function mediaDebugSnapshot(
  container: Element | null,
  { includeSharpness = false }: { includeSharpness?: boolean } = {}
): StreamDebugPayload[] {
  const containerRect = cssBoxSnapshot(container);
  const devicePixelRatio = typeof window === "undefined" ? 1 : window.devicePixelRatio;
  const visualViewportScale = typeof window === "undefined" ? 1 : window.visualViewport?.scale;
  return Array.from(container?.querySelectorAll("video, img") ?? [])
    .slice(0, 3)
    .map((element) => {
      const intrinsic = mediaIntrinsicDebugSnapshot(element);
      const mediaRect = cssBoxSnapshot(element);
      const intrinsicSize =
        intrinsic &&
        typeof intrinsic.width === "number" &&
        typeof intrinsic.height === "number" &&
        intrinsic.width > 0 &&
        intrinsic.height > 0
          ? { height: intrinsic.height, width: intrinsic.width }
          : null;
      return {
        intrinsic,
        playback: mediaPlaybackQualitySnapshot(element),
        pixelFit: computePixelFitTelemetry({
          containerRect,
          devicePixelRatio,
          intrinsic: intrinsicSize,
          mediaRect,
          visualViewportScale,
        }),
        readyState: element instanceof HTMLVideoElement ? element.readyState : null,
        rect: rectSnapshot(element),
        sharpness:
          includeSharpness && element instanceof HTMLVideoElement ? sampleVideoSharpnessTelemetry(element) : null,
        tagName: element.tagName.toLowerCase(),
      };
    });
}

function visualQualityIssues(media: StreamDebugPayload[]): StreamDebugPayload[] {
  return media.flatMap((entry, index) => {
    const pixelFit =
      entry.pixelFit && typeof entry.pixelFit === "object" ? (entry.pixelFit as StreamDebugPayload) : null;
    if (!pixelFit) {
      return [];
    }
    const reasons: string[] = [];
    const emptyAreaRatio = Number(pixelFit.emptyAreaRatio);
    const stretchRatio = Number(pixelFit.stretchRatio);
    if (Number.isFinite(emptyAreaRatio) && emptyAreaRatio > STREAM_DEBUG_EMPTY_AREA_ISSUE_RATIO) {
      reasons.push("empty-area");
    }
    if (Number.isFinite(stretchRatio) && stretchRatio > STREAM_DEBUG_STRETCH_ISSUE_RATIO) {
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

function readViewportDebugSnapshot(observedNode: Element | null): StreamDebugPayload {
  const visualViewport = typeof window === "undefined" ? null : window.visualViewport;
  const orientation = typeof screen === "undefined" ? null : screen.orientation;
  const media = (query: string) => {
    try {
      return window.matchMedia(query).matches;
    } catch {
      return null;
    }
  };
  return {
    documentElement: {
      clientHeight: document.documentElement.clientHeight,
      clientWidth: document.documentElement.clientWidth,
    },
    media: {
      anyHoverHover: media("(any-hover: hover)"),
      anyPointerCoarse: media("(any-pointer: coarse)"),
      anyPointerFine: media("(any-pointer: fine)"),
      hoverHover: media("(hover: hover)"),
      pointerCoarse: media("(pointer: coarse)"),
      pointerFine: media("(pointer: fine)"),
    },
    observed: rectSnapshot(observedNode),
    orientation: orientation
      ? {
          angle: orientation.angle,
          type: orientation.type,
        }
      : null,
    screen: {
      availHeight: screen.availHeight,
      availWidth: screen.availWidth,
      height: screen.height,
      width: screen.width,
    },
    visualViewport: visualViewport
      ? {
          height: Math.round(visualViewport.height),
          offsetLeft: Math.round(visualViewport.offsetLeft),
          offsetTop: Math.round(visualViewport.offsetTop),
          pageLeft: Math.round(visualViewport.pageLeft),
          pageTop: Math.round(visualViewport.pageTop),
          scale: visualViewport.scale,
          width: Math.round(visualViewport.width),
        }
      : null,
    window: {
      devicePixelRatio: window.devicePixelRatio,
      innerHeight: window.innerHeight,
      innerWidth: window.innerWidth,
      outerHeight: window.outerHeight,
      outerWidth: window.outerWidth,
    },
  };
}

function readSurfaceDebugSnapshot(
  observedNode: Element | null,
  { includeSharpness = false }: { includeSharpness?: boolean } = {}
): StreamDebugPayload {
  return {
    activeElement: activeElementDebugSnapshot(),
    media: mediaDebugSnapshot(observedNode, { includeSharpness }),
    viewport: readViewportDebugSnapshot(observedNode),
  };
}

function keyDebugName(key: string): string {
  return key.length === 1 ? "character" : key;
}

function keyboardDebugPayload(event: KeyboardEvent | ReactKeyboardEvent<Element>, action: string): StreamDebugPayload {
  return {
    action,
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    key: keyDebugName(event.key),
    metaKey: event.metaKey,
    repeat: event.repeat,
    shiftKey: event.shiftKey,
    target: elementDebugSnapshot(event.target),
  };
}

function inputDebugPayload(event: InputEvent): StreamDebugPayload {
  return {
    dataLength: typeof event.data === "string" ? event.data.length : null,
    inputType: event.inputType,
    isComposing: event.isComposing,
    target: elementDebugSnapshot(event.target),
  };
}

function compositionDebugPayload(event: CompositionEvent): StreamDebugPayload {
  return {
    dataLength: typeof event.data === "string" ? event.data.length : null,
    target: elementDebugSnapshot(event.target),
  };
}

function clipboardDebugPayload(event: ClipboardEvent): StreamDebugPayload {
  return {
    length: event.clipboardData?.getData("text")?.length ?? null,
    target: elementDebugSnapshot(event.target),
    type: event.type,
  };
}

function pointerDebugPayload({
  container,
  event,
  viewportInfo,
}: {
  container: HTMLElement;
  event: MouseEvent | PointerEvent | Touch;
  viewportInfo: StreamViewportInfo | null;
}): StreamDebugPayload {
  const containerBox = container.getBoundingClientRect();
  const media = container.querySelector("video, img");
  const imageBox = media?.getBoundingClientRect();
  const mediaIntrinsic = media ? mediaIntrinsicDebugSnapshot(media) : null;
  const effectiveViewport =
    mediaIntrinsic &&
    typeof mediaIntrinsic.width === "number" &&
    typeof mediaIntrinsic.height === "number" &&
    mediaIntrinsic.width > 0 &&
    mediaIntrinsic.height > 0
      ? { height: mediaIntrinsic.height, width: mediaIntrinsic.width }
      : viewportInfo;
  const mapped = pointToStreamViewport(event, {
    containerBox,
    imageBox,
    viewport: effectiveViewport,
  });
  return {
    client: { x: Math.round(event.clientX), y: Math.round(event.clientY) },
    effectiveViewport,
    mapped,
    media: rectSnapshot(media),
    relative: {
      x: Math.round(event.clientX - containerBox.left),
      y: Math.round(event.clientY - containerBox.top),
    },
  };
}

function inputPostDebugPayload(payload: Record<string, unknown>): StreamDebugPayload {
  const type = typeof payload.type === "string" ? payload.type : "unknown";
  const result: StreamDebugPayload = { type };
  for (const key of ["action", "button", "deltaX", "deltaY", "id", "modifiers", "x", "y"] as const) {
    if (payload[key] !== undefined) {
      result[key] = payload[key];
    }
  }
  if (typeof payload.key === "string") {
    result.key = keyDebugName(payload.key);
  }
  if (typeof payload.text === "string") {
    result.textLength = payload.text.length;
  }
  return result;
}

function shouldLogInputPost(payload: Record<string, unknown>): boolean {
  return !(payload.action === "mousemove" || payload.action === "touchmove");
}

function useStreamDebugLogger({
  connectorName,
  interactionId,
  runId,
}: {
  connectorName: string;
  interactionId: string;
  runId: string;
}): { debugEnabled: boolean; logDebug: StreamDebugLogger } {
  const [debugEnabled] = useState(isStreamDebugEnabled);
  const [viewerId] = useState(createStreamDebugViewerId);
  const bufferRef = useRef<StreamDebugEventRecord[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sequenceRef = useRef(0);

  const flushDebug = useCallback(() => {
    if (!debugEnabled || bufferRef.current.length === 0) {
      return;
    }
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    const events = bufferRef.current.splice(0, bufferRef.current.length);
    fetch(STREAM_DEBUG_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events }),
      credentials: "same-origin",
      keepalive: true,
    }).catch(() => {
      /* Debug telemetry must never affect stream UX. */
    });
  }, [debugEnabled]);

  const logDebug = useCallback<StreamDebugLogger>(
    (type, payload = {}) => {
      if (!debugEnabled) {
        return;
      }
      const event: StreamDebugEventRecord = {
        at: new Date().toISOString(),
        connectorName,
        interactionId,
        payload,
        runId,
        seq: sequenceRef.current + 1,
        type,
        viewerId,
      };
      sequenceRef.current = event.seq;
      bufferRef.current.push(event);
      console.debug("pdpp_stream_debug", event);
      if (bufferRef.current.length >= STREAM_DEBUG_BATCH_SIZE) {
        flushDebug();
        return;
      }
      if (!flushTimerRef.current) {
        flushTimerRef.current = setTimeout(flushDebug, STREAM_DEBUG_FLUSH_MS);
      }
    },
    [connectorName, debugEnabled, flushDebug, interactionId, runId, viewerId]
  );

  useEffect(() => {
    if (!debugEnabled) {
      return;
    }
    const handleNekoDebug = (event: Event) => {
      const detail =
        event instanceof CustomEvent && event.detail && typeof event.detail === "object" ? event.detail : {};
      const type = typeof detail.type === "string" ? detail.type : "neko.client";
      const payload = detail.payload && typeof detail.payload === "object" ? detail.payload : detail;
      logDebug(type, payload as StreamDebugPayload);
    };
    window.addEventListener(STREAM_DEBUG_EVENT, handleNekoDebug);
    logDebug("debug.enabled", {
      snapshot: readViewportDebugSnapshot(null),
    });
    return () => {
      window.removeEventListener(STREAM_DEBUG_EVENT, handleNekoDebug);
      flushDebug();
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
    };
  }, [debugEnabled, flushDebug, logDebug]);

  return { debugEnabled, logDebug };
}

function useSurfaceDebugTelemetry({
  containerRef,
  debugEnabled,
  logDebug,
  surface,
  viewportInfo,
}: {
  containerRef: RefObject<HTMLElement | null>;
  debugEnabled: boolean;
  logDebug: StreamDebugLogger;
  surface: string;
  viewportInfo: StreamViewportInfo | null;
}) {
  const lastPointerMoveLogAtRef = useRef(0);

  useEffect(() => {
    if (!debugEnabled) {
      return;
    }
    const node = containerRef.current;
    if (!node) {
      return;
    }

    const log = (type: string, payload: StreamDebugPayload = {}) => {
      logDebug(`surface.${surface}.${type}`, {
        ...payload,
        snapshot: readSurfaceDebugSnapshot(node, { includeSharpness: true }),
        surface,
        viewport: viewportInfo,
      });
    };

    const onPointer = (event: PointerEvent) => {
      if (event.type === "pointermove") {
        const now = Date.now();
        if (now - lastPointerMoveLogAtRef.current < STREAM_DEBUG_POINTER_MOVE_MS) {
          return;
        }
        lastPointerMoveLogAtRef.current = now;
      }
      log("pointer", {
        action: event.type,
        button: event.button,
        buttons: event.buttons,
        isPrimary: event.isPrimary,
        pointerType: event.pointerType,
        point: pointerDebugPayload({ container: node, event, viewportInfo }),
        pressure: event.pressure,
        target: elementDebugSnapshot(event.target),
      });
    };

    const onMouse = (event: MouseEvent) => {
      log("mouse", {
        action: event.type,
        button: event.button,
        buttons: event.buttons,
        point: pointerDebugPayload({ container: node, event, viewportInfo }),
        target: elementDebugSnapshot(event.target),
      });
    };

    const onTouch = (event: TouchEvent) => {
      const touch = event.changedTouches[0] ?? event.touches[0] ?? null;
      log("touch", {
        action: event.type,
        changedTouches: event.changedTouches.length,
        point: touch ? pointerDebugPayload({ container: node, event: touch, viewportInfo }) : null,
        target: elementDebugSnapshot(event.target),
        touches: event.touches.length,
      });
    };

    const onKeyboard = (event: KeyboardEvent) => {
      log("keyboard", keyboardDebugPayload(event, event.type));
    };

    const onInput = (event: Event) => {
      if (event instanceof InputEvent) {
        log(event.type, inputDebugPayload(event));
        return;
      }
      log(event.type, { target: elementDebugSnapshot(event.target) });
    };

    const onComposition = (event: CompositionEvent) => {
      log(event.type, compositionDebugPayload(event));
    };

    const onClipboard = (event: ClipboardEvent) => {
      log("clipboard", clipboardDebugPayload(event));
    };

    const onFocus = (event: FocusEvent) => {
      log(event.type, {
        relatedTarget: elementDebugSnapshot(event.relatedTarget),
        target: elementDebugSnapshot(event.target),
      });
    };

    const pointerListener: EventListener = (event) => onPointer(event as PointerEvent);
    const mouseListener: EventListener = (event) => onMouse(event as MouseEvent);
    const touchListener: EventListener = (event) => onTouch(event as TouchEvent);
    const keyboardListener: EventListener = (event) => onKeyboard(event as KeyboardEvent);
    const inputListener: EventListener = onInput;
    const compositionListener: EventListener = (event) => onComposition(event as CompositionEvent);
    const clipboardListener: EventListener = (event) => onClipboard(event as ClipboardEvent);
    const focusListener: EventListener = (event) => onFocus(event as FocusEvent);
    const capture = { capture: true };
    const registrations: Array<{ handler: EventListener; type: string }> = [
      ...["pointerdown", "pointermove", "pointerup", "pointercancel"].map((type) => ({
        handler: pointerListener,
        type,
      })),
      ...["mousedown", "mouseup", "click"].map((type) => ({ handler: mouseListener, type })),
      ...["touchstart", "touchend", "touchcancel"].map((type) => ({ handler: touchListener, type })),
      ...["keydown", "keyup"].map((type) => ({ handler: keyboardListener, type })),
      ...["beforeinput", "input"].map((type) => ({ handler: inputListener, type })),
      ...["compositionstart", "compositionupdate", "compositionend"].map((type) => ({
        handler: compositionListener,
        type,
      })),
      ...["copy", "cut", "paste"].map((type) => ({ handler: clipboardListener, type })),
      ...["focusin", "focusout"].map((type) => ({ handler: focusListener, type })),
    ];
    for (const { handler, type } of registrations) {
      node.addEventListener(type, handler, capture);
    }

    log("telemetry.attached");
    return () => {
      for (const { handler, type } of registrations) {
        node.removeEventListener(type, handler, capture);
      }
    };
  }, [containerRef, debugEnabled, logDebug, surface, viewportInfo]);
}

function useVisualQualityDebugTelemetry({
  containerRef,
  debugEnabled,
  logDebug,
  surface,
  viewportInfo,
}: {
  containerRef: RefObject<HTMLElement | null>;
  debugEnabled: boolean;
  logDebug: StreamDebugLogger;
  surface: string;
  viewportInfo: StreamViewportInfo | null;
}) {
  useEffect(() => {
    if (!debugEnabled) {
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const sample = () => {
      if (cancelled) {
        return;
      }
      const node = containerRef.current;
      if (node) {
        const media = mediaDebugSnapshot(node, { includeSharpness: true });
        const occluded =
          node.matches("[data-pdpp-stream-loading]") || Boolean(node.querySelector("[data-pdpp-stream-loading]"));
        logDebug(`surface.${surface}.visual_quality.sample`, {
          media,
          occluded,
          surface,
          viewport: viewportInfo,
        });
        const issues = occluded ? [] : visualQualityIssues(media);
        if (issues.length > 0) {
          logDebug(`surface.${surface}.visual_quality.issue`, {
            issues,
            snapshot: readViewportDebugSnapshot(node),
            surface,
            viewport: viewportInfo,
          });
        }
      }
      timer = setTimeout(sample, STREAM_DEBUG_VISUAL_QUALITY_MS);
    };

    timer = setTimeout(sample, Math.floor(STREAM_DEBUG_VISUAL_QUALITY_MS / 2));
    return () => {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [containerRef, debugEnabled, logDebug, surface, viewportInfo]);
}

function readMintViewport(): ReturnType<typeof buildViewportPayload> | undefined {
  if (typeof window === "undefined") {
    return;
  }
  return readViewerViewport(window.innerWidth, window.innerHeight);
}

function readLocalViewportSample(): LocalViewportSample | null {
  if (typeof window === "undefined") {
    return null;
  }
  return {
    width: Math.max(1, Math.floor(window.innerWidth)),
    height: Math.max(1, Math.floor(window.innerHeight)),
    visualHeight:
      typeof window.visualViewport?.height === "number" ? Math.max(1, Math.floor(window.visualViewport.height)) : null,
    visualWidth:
      typeof window.visualViewport?.width === "number" ? Math.max(1, Math.floor(window.visualViewport.width)) : null,
  };
}

function readVirtualKeyboardSample(): ViewportObservation["virtualKeyboard"] {
  const keyboard = (navigator as NavigatorWithVirtualKeyboard).virtualKeyboard;
  const rect = keyboard?.boundingRect;
  if (!(rect && rect.width > 0 && rect.height > 0)) {
    return null;
  }
  return {
    height: Math.round(rect.height),
    width: Math.round(rect.width),
    x: Math.round(rect.x),
    y: Math.round(rect.y),
  };
}

function readViewportObservation(): ViewportObservation | null {
  if (typeof window === "undefined") {
    return null;
  }
  const visualViewport = window.visualViewport;
  const orientation = typeof screen === "undefined" ? null : screen.orientation;
  return {
    editableFocused: hasLocalTextInputFocus(),
    layout: {
      height: Math.max(1, Math.floor(window.innerHeight)),
      width: Math.max(1, Math.floor(window.innerWidth)),
    },
    mobile: readPointerCoarse() || MOBILE_USER_AGENT_RE.test(window.navigator.userAgent),
    orientation: orientation
      ? {
          angle: orientation.angle,
          type: orientation.type,
        }
      : null,
    virtualKeyboard: typeof navigator === "undefined" ? null : readVirtualKeyboardSample(),
    visual: visualViewport
      ? {
          height: Math.max(1, Math.floor(visualViewport.height)),
          offsetLeft: Math.round(visualViewport.offsetLeft),
          offsetTop: Math.round(visualViewport.offsetTop),
          pageLeft: Math.round(visualViewport.pageLeft),
          pageTop: Math.round(visualViewport.pageTop),
          scale: visualViewport.scale,
          width: Math.max(1, Math.floor(visualViewport.width)),
        }
      : null,
    timestampMs: Date.now(),
  };
}

function hasLocalTextInputFocus(): boolean {
  if (typeof document === "undefined") {
    return false;
  }
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) {
    return false;
  }
  return active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active.isContentEditable;
}

function streamEventData(event: Event): string {
  const data = (event as MessageEvent).data;
  return typeof data === "string" ? data : "";
}

export function StreamSurface({
  autoOpen = false,
  connector,
  interactionId,
  interactionKind,
  interactionMessage,
  runId,
}: StreamSurfaceProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<ConnectionStatus>(CONNECTING);
  // Held minted session passed down to <StreamStage>. The modal effect
  // consumes this for first attach instead of minting itself — moving the
  // mint out of `useEffect` is the architectural fix for React StrictMode's
  // dev-only effect double-invoke (which would otherwise mint twice and
  // supersede the first token, cascading to 401s on input dispatch).
  // Cleared when the overlay closes so a re-open mints fresh.
  const [mintedSession, setMintedSession] = useState<MintedStreamSession | null>(null);
  // Pending click state. Disables the button + flips its label so a flaky
  // operator double-tap doesn't fire a second mint over a still-resolving one.
  const [isMinting, setIsMinting] = useState(false);
  // Mirror `isMinting` into a ref so the click handler's re-entrancy guard
  // doesn't need it as a useCallback dep (which would churn the callback
  // identity and re-fire the autoOpen effect every time the pending state
  // flips).
  const isMintingRef = useRef(false);

  // Poll the timeline. router.refresh() re-runs the page loader so a
  // server-side resolution flips this view to <ResolvedSurface>.
  useEffect(() => {
    const id = setInterval(() => router.refresh(), RESOLUTION_POLL_MS);
    return () => clearInterval(id);
  }, [router]);

  // ─── Open-browser click handler ────────────────────────────────────────────
  //
  // Mints the streaming session inside the click handler so React's
  // StrictMode dev double-invoke of mount effects does not produce two mint
  // requests. Event handlers do NOT double-fire in StrictMode (this is the
  // documented React guidance for "create a remote resource" side effects).
  // The minted session is then handed down to the modal as a prop; the
  // modal's effect just consumes it.
  const openBrowser = useCallback(async () => {
    if (isMintingRef.current) {
      return; // re-entrancy guard for double-tap
    }
    isMintingRef.current = true;
    setIsMinting(true);
    setStatus(CONNECTING);
    try {
      const minted = await mintStreamSessionAction({
        idempotencyKey: newIdempotencyKey(),
        interactionId,
        runId,
        viewport: readMintViewport(),
      });
      setMintedSession(minted);
      setOpen(true);
    } catch (err) {
      // Don't open the modal on mint failure — surface the trouble state
      // next to the button so the operator can retry from the calm
      // orientation card rather than a half-loaded overlay.
      setStatus(classifyMintError(err));
    } finally {
      isMintingRef.current = false;
      setIsMinting(false);
    }
  }, [interactionId, runId]);

  // Preview mode (`?_preview=1&_state=task`) used to open the modal on mount.
  // After fix 3a, "open" requires a minted session; reproduce the preview
  // path by firing the click handler once. The preview's fake runId will
  // surface a trouble state through the same path real failures take.
  const autoOpenedRef = useRef(false);
  useEffect(() => {
    if (!autoOpen || autoOpenedRef.current) {
      return;
    }
    autoOpenedRef.current = true;
    openBrowser().catch(() => {
      /* openBrowser surfaces its own trouble status */
    });
  }, [autoOpen, openBrowser]);

  // Operator might land on an unsupported interaction kind (credential / OTP).
  // The streaming companion can't satisfy those; keep one explicit escape.
  if (!SUPPORTED_KINDS.has(interactionKind)) {
    return (
      <UnsupportedSurface
        connector={connector}
        interactionMessage={interactionMessage}
        runHref={dashboardRoutes.run(runId)}
      />
    );
  }

  const connectorName = connector?.displayName ?? "the connector";

  return (
    <main className="relative min-h-dvh">
      <WordmarkCorner />

      <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-stretch justify-center px-5 py-16">
        <OrientationCard
          buttonLabel="Open browser"
          connectorName={connector?.displayName}
          isMinting={isMinting}
          message={interactionMessage}
          onAction={openBrowser}
          troubleMessage={status.display === "trouble" ? status.troubleMessage : null}
        />
      </div>

      <StreamOverlay
        connectorName={connectorName}
        initialSession={mintedSession}
        interactionId={interactionId}
        onClose={() => {
          setOpen(false);
          // Clear the minted session so the next "Open browser" click mints
          // a fresh one. Holding a stale session would attempt to attach to
          // an already-torn-down companion.
          setMintedSession(null);
        }}
        onStatus={setStatus}
        open={open}
        runId={runId}
        status={status}
      />
    </main>
  );
}

// ─── Wordmark and orientation card ───────────────────────────────────────────

function WordmarkCorner() {
  return (
    <div className="pointer-events-none absolute top-3 left-3 z-10 flex items-center gap-2 opacity-65">
      <PdppLogo className="block" size={14} title="PDPP" />
      <span className="pdpp-caption font-medium text-foreground tracking-tight">pdpp</span>
    </div>
  );
}

interface OrientationCardProps {
  buttonLabel: string;
  connectorName?: string;
  /** While the click handler is awaiting the mint POST. Disables the button + flips the label. */
  isMinting: boolean;
  message: string;
  onAction: () => void;
  troubleMessage: string | null;
}

function OrientationCard({
  buttonLabel,
  connectorName,
  isMinting,
  message,
  onAction,
  troubleMessage,
}: OrientationCardProps) {
  // Label precedence: pending overrides everything (active feedback for the
  // user's just-completed click), then trouble (retry affordance), then the
  // default. Keeping all three labels here avoids a flash of "Try again"
  // mid-flight when an earlier mint failure is still in `troubleMessage`.
  let label: string;
  if (isMinting) {
    label = "Opening...";
  } else if (troubleMessage) {
    label = "Try again";
  } else {
    label = buttonLabel;
  }
  return (
    <section
      aria-labelledby="stream-orientation-title"
      className="flex flex-col gap-5 rounded-lg px-5 py-6 sm:px-6 sm:py-7"
      data-surface="human"
    >
      {connectorName ? <p className="pdpp-eyebrow text-foreground">{connectorName}</p> : null}
      <p className="pdpp-body-lg text-foreground" id="stream-orientation-title">
        {message}
      </p>
      <Button
        aria-busy={isMinting || undefined}
        aria-describedby={troubleMessage ? "stream-trouble-note" : undefined}
        className="h-12 w-full"
        disabled={isMinting}
        onClick={onAction}
        size="lg"
        type="button"
      >
        {label}
      </Button>
      {troubleMessage ? (
        <p className="pdpp-caption text-destructive/85" id="stream-trouble-note" role="status">
          {troubleMessage}
        </p>
      ) : null}
    </section>
  );
}

// ─── Stage 2: the overlay holding the live stream ─────────────────────────────

interface StreamOverlayProps {
  connectorName: string;
  /**
   * The session minted by the orientation card's "Open browser" click.
   * `null` is only valid when `open === false` (the overlay isn't visible);
   * when `open` is true this MUST be present so the modal can attach without
   * minting from inside its own effect.
   */
  initialSession: MintedStreamSession | null;
  interactionId: string;
  onClose: () => void;
  onStatus: (status: ConnectionStatus) => void;
  open: boolean;
  runId: string;
  status: ConnectionStatus;
}

function StreamOverlay({
  connectorName,
  initialSession,
  interactionId,
  onClose,
  onStatus,
  open,
  runId,
  status,
}: StreamOverlayProps) {
  return (
    <Dialog
      // `dismissible={false}` would block Esc too. We want Esc to close
      // (a11y + desktop convention), but we don't want backdrop-click to
      // close (operators might miss-click while interacting with the
      // streamed page). We achieve that by stopping pointer events on the
      // backdrop while still allowing the explicit close button + Esc.
      modal
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
      open={open}
    >
      <DialogPortal>
        {/* On phone the popup is the viewport — backdrop is invisible.
            On desktop we let the backdrop dim around the popup, which has
            margins. The backdrop renders regardless so base-ui's pointer
            and scroll-lock machinery behave. */}
        <DialogBackdrop className="pdpp-stream-dialog-backdrop" />
        <DialogPopup aria-label={`${connectorName} live browser`} className="pdpp-stream-dialog">
          {open && initialSession ? (
            <StreamStage
              connectorName={connectorName}
              initialSession={initialSession}
              interactionId={interactionId}
              onClose={onClose}
              onStatus={onStatus}
              runId={runId}
              status={status}
            />
          ) : null}
        </DialogPopup>
      </DialogPortal>
    </Dialog>
  );
}

interface StreamStageProps {
  connectorName: string;
  /**
   * Pre-minted session handed down from the orientation card click. The
   * mount effect attaches with this session immediately rather than
   * minting — that's the architectural fix for React StrictMode's dev
   * effect double-invoke producing duplicate mints + superseding tokens.
   */
  initialSession: MintedStreamSession;
  interactionId: string;
  onClose: () => void;
  onStatus: (status: ConnectionStatus) => void;
  runId: string;
  status: ConnectionStatus;
}

/**
 * Mounted only while the overlay is open. Owns the SSE lifecycle and tears
 * the session down on unmount (close beacon).
 *
 * The first mint is performed by the orientation card's click handler — see
 * `StreamSurface.openBrowser`. That session is passed in via `initialSession`
 * and consumed by the mount effect for the first attach. The effect's
 * re-mint path (after `TOKEN_DEAD_FAILURE_THRESHOLD` pre-attach failures)
 * still mints fresh from inside the effect, but only after multiple failures
 * — StrictMode's effect cleanup correctly cancels a single in-flight re-mint.
 */
function StreamStage({
  connectorName,
  initialSession,
  interactionId,
  onClose,
  onStatus,
  runId,
  status,
}: StreamStageProps) {
  const [imgSrc, setImgSrc] = useState<string | null>(null);
  const [nekoSession, setNekoSession] = useState<NekoSessionInfo | null>(null);
  const [clipboardSheetOpen, setClipboardSheetOpen] = useState(false);
  const [clipboardNoticeOpen, setClipboardNoticeOpen] = useState(false);
  const [remoteClipboard, setRemoteClipboard] = useState<RemoteClipboardBuffer | null>(null);
  const [remoteInputSensitive, setRemoteInputSensitive] = useState(false);
  const [viewportInfo, setViewportInfo] = useState<StreamViewportInfo | null>(null);
  const [localSurfaceViewportInfo, setLocalSurfaceViewportInfo] = useState<StreamViewportInfo | null>(null);
  const [presentationViewportInfo, setPresentationViewportInfo] = useState<StreamViewportInfo | null>(null);
  const lastPostedViewportRef = useRef<ReturnType<typeof buildViewportPayload> | null>(null);
  const viewportInfoRef = useRef<StreamViewportInfo | null>(null);
  const localSurfaceViewportInfoRef = useRef<StreamViewportInfo | null>(null);
  const presentationViewportInfoRef = useRef<StreamViewportInfo | null>(null);
  const stablePresentationViewportInfoRef = useRef<StreamViewportInfo | null>(null);
  const localViewportSampleRef = useRef<LocalViewportSample | null>(null);
  const keyboardResizeStateRef = useRef(createMobileKeyboardResizeState());
  const controlStateRef = useRef(createStreamViewerControlState());
  const presentationControlStateRef = useRef(createStreamViewerControlState());
  const [location, setLocation] = useState<LocationInfo | null>(null);
  const [popup, setPopup] = useState<PopupNotice | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerNode, setContainerNode] = useState<HTMLDivElement | null>(null);
  const inputUrlRef = useRef<string | null>(null);
  const viewportUrlRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  // Hold the latest session passed in by the parent. The mount effect reads
  // from this ref so a re-render with a refreshed `initialSession` (rare —
  // would only happen if the parent re-mints) is observed without re-running
  // the entire effect. The parent currently never swaps this prop while the
  // overlay is open; the ref is forward-compat insurance.
  const initialSessionRef = useRef(initialSession);
  initialSessionRef.current = initialSession;
  // Auto-dismiss timer for the popup toast. Re-set on each new popup so a
  // burst of openings always shows the latest for the full window rather than
  // dismissing mid-read.
  const popupTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keyboardBlurTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { debugEnabled, logDebug } = useStreamDebugLogger({ connectorName, interactionId, runId });
  const clipboardCapabilities = useClipboardCapabilities();
  const clipboardPolicy = decideClipboardPolicy({
    capabilities: clipboardCapabilities,
    directionPolicy: DEFAULT_CLIPBOARD_DIRECTION_POLICY,
    hasStreamSession: Boolean(initialSession.input_url),
    helperMode: normalizeClipboardHelperMode(nekoSession?.stealthMode),
  });
  const clipboardCapabilitiesRef = useRef(clipboardCapabilities);
  const clipboardPolicyRef = useRef(clipboardPolicy);
  const pendingResizeSourcesRef = useRef<Set<string>>(new Set());
  const pendingPresentationSourcesRef = useRef<Set<string>>(new Set());
  const presentationKeyboardFocusedRef = useRef(false);
  const presentationKeyboardHoldUntilRef = useRef(0);
  const presentationOrientationHoldUntilRef = useRef(0);
  const presentationViewportTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const trailingViewportReconcileRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const controlViewportReconcileTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const requestViewportMeasureRef = useRef<((source: string) => void) | null>(null);
  const setStreamSurfaceNode = useCallback((node: HTMLDivElement | null) => {
    containerRef.current = node;
    setContainerNode(node);
  }, []);

  clipboardCapabilitiesRef.current = clipboardCapabilities;
  clipboardPolicyRef.current = clipboardPolicy;
  viewportInfoRef.current = viewportInfo;
  localSurfaceViewportInfoRef.current = localSurfaceViewportInfo;
  presentationViewportInfoRef.current = presentationViewportInfo;

  const scheduleControlViewportReconcile = useCallback((source: string) => {
    const timer = setTimeout(() => {
      controlViewportReconcileTimersRef.current.delete(timer);
      requestViewportMeasureRef.current?.(source);
    }, STREAM_VIEWER_POLICY.orientationSettleFollowUpMs);
    controlViewportReconcileTimersRef.current.add(timer);
  }, []);

  const scheduleViewportHoldFollowUp = useCallback(
    (command: StreamViewerCommand | null, source: string) => {
      if (command?.type !== "viewport.hold" || command.reason !== "orientation-settling") {
        return;
      }
      scheduleControlViewportReconcile(`${source}+orientation-settle-followup`);
    },
    [scheduleControlViewportReconcile]
  );

  useEffect(() => {
    logDebug("clipboard.capabilities", {
      browserFamily: clipboardCapabilities.browserFamily,
      clipboardChangeEventAvailable: clipboardCapabilities.supportsClipboardChangeEvent,
      isSecureContext: clipboardCapabilities.isSecureContext,
      mobileLike: clipboardCapabilities.mobileLike,
      needsManualReadFallback: clipboardCapabilities.needsManualReadFallback,
      pointerCoarse: clipboardCapabilities.pointerCoarse,
      readTextAvailable: clipboardCapabilities.readTextAvailable,
      topLevel: clipboardCapabilities.topLevel,
      writeTextAvailable: clipboardCapabilities.writeTextAvailable,
    });
  }, [clipboardCapabilities, logDebug]);

  useEffect(() => {
    logDebug("clipboard.policy", {
      canForwardNativePasteEvent: clipboardPolicy.canForwardNativePasteEvent,
      canReadLocalClipboard: clipboardPolicy.canReadLocalClipboard,
      canWriteLocalClipboard: clipboardPolicy.canWriteLocalClipboard,
      directionPolicy: clipboardPolicy.directionPolicy,
      helperMode: clipboardPolicy.helperMode,
      showClipboardSheet: clipboardPolicy.showClipboardSheet,
      showDesktopCopyButton: clipboardPolicy.showDesktopCopyButton,
      showDesktopPasteButton: clipboardPolicy.showDesktopPasteButton,
      showKeyboardButton: clipboardPolicy.showKeyboardButton,
      showMobileCopyButton: clipboardPolicy.showMobileCopyButton,
      showMobilePasteButton: clipboardPolicy.showMobilePasteButton,
      surface: clipboardPolicy.surface,
    });
  }, [clipboardPolicy, logDebug]);

  useEffect(() => {
    if (typeof navigator === "undefined") {
      return;
    }
    const virtualKeyboard = (navigator as NavigatorWithVirtualKeyboard).virtualKeyboard;
    if (!(virtualKeyboard && "overlaysContent" in virtualKeyboard)) {
      logDebug("viewport.virtual_keyboard_overlay", {
        supported: false,
      });
      return;
    }
    const previousOverlaysContent = virtualKeyboard.overlaysContent === true;
    try {
      virtualKeyboard.overlaysContent = true;
      logDebug("viewport.virtual_keyboard_overlay", {
        previousOverlaysContent,
        supported: true,
      });
    } catch (err) {
      logDebug("viewport.virtual_keyboard_overlay", {
        error: err instanceof Error ? err.message : String(err),
        supported: true,
      });
      return;
    }
    return () => {
      try {
        virtualKeyboard.overlaysContent = previousOverlaysContent;
      } catch {
        /* Best effort: leaving overlay mode enabled is less disruptive than throwing during cleanup. */
      }
    };
  }, [logDebug]);

  useEffect(() => {
    if (!(remoteClipboard && clipboardPolicy.showClipboardSheet)) {
      setClipboardNoticeOpen(false);
      return;
    }
    setClipboardNoticeOpen(true);
    const timer = setTimeout(() => {
      setClipboardNoticeOpen(false);
    }, CLIPBOARD_NOTICE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [clipboardPolicy.showClipboardSheet, remoteClipboard]);

  useEffect(() => {
    if (!clipboardPolicy.showClipboardSheet) {
      setClipboardSheetOpen(false);
    }
  }, [clipboardPolicy.showClipboardSheet]);

  useEffect(() => {
    setNekoRemoteCopyFallback(() => {
      const url = inputUrlRef.current;
      if (!url) {
        logDebug("neko.clipboard_remote_to_local", {
          method: "fallback.input-url",
          phase: "skipped",
          reason: "missing-input-url",
        });
        return;
      }
      logDebug("neko.clipboard_remote_to_local", {
        method: "fallback.input-url",
        phase: "post-start",
      });
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "copy" }),
        credentials: "omit",
        keepalive: true,
      })
        .then((response) => {
          logDebug("neko.clipboard_remote_to_local", {
            method: "fallback.input-url",
            ok: response.ok,
            phase: "post-result",
            status: response.status,
          });
        })
        .catch((err) => {
          logDebug("neko.clipboard_remote_to_local", {
            error: err instanceof Error ? err.message : String(err),
            method: "fallback.input-url",
            phase: "post-error",
          });
        });
    });
    return () => {
      setNekoRemoteCopyFallback(null);
    };
  }, [logDebug]);

  const attachStreamHandlers = useCallback(
    (source: EventSource, callbacks: { onAttached: () => void; onTransportError: () => void }) => {
      source.addEventListener("attached", (ev) => {
        const parsed = parseAttachedMessage(streamEventData(ev));
        if (!parsed.ok) {
          onStatus({
            display: "trouble",
            cause: "network",
            troubleMessage: "Stream attached but the handshake was malformed.",
          });
          return;
        }
        const payload = parsed.value;
        if (payload.viewport) {
          setViewportInfo(payload.viewport);
          localSurfaceViewportInfoRef.current = payload.viewport;
          setLocalSurfaceViewportInfo(payload.viewport);
          lastPostedViewportRef.current = readViewerViewport(payload.viewport.width, payload.viewport.height) ?? null;
        }
        callbacks.onAttached();
      });
      source.addEventListener("backend_ready", (ev) => {
        const parsed = parseBackendReadyMessage(streamEventData(ev));
        if (!parsed.ok) {
          return;
        }
        const payload = parsed.value;
        onStatus(LIVE);
        if (payload.backend === "neko" && typeof payload.iframe_path === "string" && payload.iframe_path.length > 0) {
          const entryPath = payload.iframe_path.replace(TRAILING_SLASH_RE, "");
          localSurfaceViewportInfoRef.current = null;
          presentationViewportInfoRef.current = null;
          stablePresentationViewportInfoRef.current = null;
          setLocalSurfaceViewportInfo(null);
          setPresentationViewportInfo(null);
          setRemoteClipboard(null);
          setRemoteInputSensitive(false);
          setNekoSession({
            browserOwnerMode: payload.browser_owner_mode,
            clientConfigPath:
              typeof payload.client_config_path === "string" && payload.client_config_path.length > 0
                ? payload.client_config_path
                : `${entryPath}/session`,
            stealthMode: payload.stealth_mode,
          });
          setImgSrc(null);
          return;
        }
        setRemoteClipboard(null);
        setRemoteInputSensitive(false);
        localSurfaceViewportInfoRef.current = null;
        presentationViewportInfoRef.current = null;
        stablePresentationViewportInfoRef.current = null;
        setLocalSurfaceViewportInfo(null);
        setPresentationViewportInfo(null);
        setNekoSession(null);
      });
      source.addEventListener("frame", (ev) => {
        const parsed = parseFrameMessage(streamEventData(ev));
        if (!parsed.ok) {
          return;
        }
        setImgSrc(`data:image/jpeg;base64,${parsed.value.data_base64}`);
        onStatus(LIVE);
      });
      source.addEventListener("url_changed", (ev) => {
        const parsed = parseUrlChangedMessage(streamEventData(ev));
        if (!parsed.ok) {
          return;
        }
        const next = parseLocation(parsed.value.url, parsed.value.title);
        // Hold the previous label rather than blanking when an unparseable
        // URL arrives (e.g. about:blank during a redirect). The next valid
        // navigation will replace it; flickering "no URL" is worse than
        // briefly stale.
        if (next) {
          setLocation(next);
        }
      });
      source.addEventListener("popup_opened", (ev) => {
        const parsed = parsePopupOpenedMessage(streamEventData(ev));
        if (!parsed.ok) {
          return;
        }
        const payload = parsed.value;
        setPopup({
          targetId: payload.targetId,
          message: `${connectorName} opened a new tab. The action may continue there.`,
        });
        if (popupTimeoutRef.current) {
          clearTimeout(popupTimeoutRef.current);
        }
        popupTimeoutRef.current = setTimeout(() => {
          popupTimeoutRef.current = null;
          setPopup(null);
        }, POPUP_TOAST_TIMEOUT_MS);
      });
      source.addEventListener("popup_closed", (ev) => {
        const parsed = parsePopupClosedMessage(streamEventData(ev));
        if (!parsed.ok) {
          return;
        }
        // Only dismiss the toast if it matches the popup we announced.
        // Stale closures for un-shown popups must not blank an active toast
        // for a different popup.
        setPopup((current) => {
          if (current && current.targetId === parsed.value.targetId) {
            if (popupTimeoutRef.current) {
              clearTimeout(popupTimeoutRef.current);
              popupTimeoutRef.current = null;
            }
            return null;
          }
          return current;
        });
      });
      source.addEventListener("clipboard", (ev) => {
        const parsed = parseClipboardMessage(streamEventData(ev));
        if (!parsed.ok || typeof parsed.value.text !== "string" || parsed.value.text.length === 0) {
          return;
        }
        const { text } = parsed.value;
        const currentClipboardCapabilities = clipboardCapabilitiesRef.current;
        const currentClipboardPolicy = clipboardPolicyRef.current;
        const metadata = clipboardDebugMetadata(text, {
          method: "sse.clipboard",
          mobileLike: currentClipboardCapabilities.mobileLike,
          surface: currentClipboardPolicy.surface,
        });
        const remoteToLocalAllowed =
          currentClipboardPolicy.directionPolicy === "remote-to-local" ||
          currentClipboardPolicy.directionPolicy === "bidirectional-text";
        if (!remoteToLocalAllowed) {
          logDebug("neko.clipboard_remote_to_local", {
            ...metadata,
            phase: "skipped",
            reason: "policy-denied",
          });
          return;
        }
        if (currentClipboardPolicy.surface === "mobile-sheet") {
          setRemoteClipboard({ receivedAt: Date.now(), text });
          logDebug("neko.clipboard_remote_to_local", {
            ...metadata,
            phase: "buffered",
          });
          return;
        }
        if (!currentClipboardPolicy.canWriteLocalClipboard) {
          logDebug("neko.clipboard_remote_to_local", {
            ...metadata,
            phase: "skipped",
            reason: "write-unavailable",
          });
          return;
        }
        navigator.clipboard
          ?.writeText(text)
          .then(() => {
            logDebug("neko.clipboard_remote_to_local", {
              ...metadata,
              phase: "write-ok",
            });
          })
          .catch((err) => {
            logDebug("neko.clipboard_remote_to_local", {
              error: err instanceof Error ? err.message : String(err),
              ...metadata,
              phase: "write-error",
            });
          });
        logDebug("neko.clipboard_remote_to_local", {
          ...metadata,
          phase: "received",
        });
      });
      source.addEventListener("keyboard_focus", (ev) => {
        const parsed = parseKeyboardFocusMessage(streamEventData(ev));
        if (!parsed.ok) {
          return;
        }
        if (parsed.value.focused) {
          presentationKeyboardFocusedRef.current = true;
          presentationKeyboardHoldUntilRef.current = nextPresentationKeyboardHoldUntilMs({
            currentHoldUntilMs: presentationKeyboardHoldUntilRef.current,
            holdMs: STREAM_VIEWER_POLICY.presentationKeyboardOpenHoldMs,
            isKeyboardActive: true,
            nowMs: Date.now(),
          });
          const inputType = parsed.value.element?.inputType?.toLowerCase() ?? "";
          setRemoteInputSensitive(inputType === "password");
          if (keyboardBlurTimeoutRef.current) {
            clearTimeout(keyboardBlurTimeoutRef.current);
            keyboardBlurTimeoutRef.current = null;
          }
          setNekoRemoteInputFocused(true);
          focusNekoKeyboard();
        } else {
          if (keyboardBlurTimeoutRef.current) {
            clearTimeout(keyboardBlurTimeoutRef.current);
          }
          keyboardBlurTimeoutRef.current = setTimeout(() => {
            keyboardBlurTimeoutRef.current = null;
            setNekoRemoteInputFocused(false);
            setRemoteInputSensitive(false);
            blurNekoKeyboard();
          }, STREAM_VIEWER_POLICY.keyboardRemoteBlurGraceMs);
          presentationKeyboardFocusedRef.current = false;
          presentationKeyboardHoldUntilRef.current = Math.max(
            presentationKeyboardHoldUntilRef.current,
            Date.now() + STREAM_VIEWER_POLICY.presentationKeyboardCloseHoldMs
          );
        }
      });
      // The server emits a structured `error` event on `companion_start_failed`
      // (reference-implementation/server/streaming/routes.js:367) and then
      // closes the stream. Treat this as a hard transport failure so the
      // reconnect coordinator can either retry or re-mint, rather than
      // letting the EventSource auto-retry against a token whose companion
      // is dead.
      source.addEventListener("error", (ev) => {
        const parsed = parseStreamErrorMessage(streamEventData(ev));
        if (parsed.ok) {
          onStatus({
            display: "trouble",
            cause: "network",
            troubleMessage:
              typeof parsed.value.message === "string" && parsed.value.message.length > 0
                ? parsed.value.message
                : "The browser stream failed to start.",
          });
          source.close();
          return;
        }
        callbacks.onTransportError();
      });
    },
    [connectorName, logDebug, onStatus]
  );

  // ─── Attach + (rare) re-mint lifecycle ────────────────────────────────────
  //
  // First attach uses the session minted by the orientation card's click
  // handler (`initialSession` prop). Moving the first mint OUT of this effect
  // is the architectural fix for React StrictMode dev-mode effect double-
  // invoke producing two mint requests ~50ms apart — the second supersedes
  // the first per `reference-implementation/server/streaming/sessions.js`,
  // and the viewer's input handlers ended up referencing the now-superseded
  // token, cascading to 401s. Event handlers do NOT double-fire in
  // StrictMode, so the click-driven mint is single by construction.
  //
  // The server's `attach` is single-use by deliberate design (single-attach
  // prevents stale-link replay). So we MUST NOT call attach a second time on
  // the same token. Reconnect strategy:
  //
  //   - If EventSource fires `error` AFTER we've seen `attached`, it's a
  //     transport blip on a live session. Let EventSource auto-reconnect
  //     internally; the server-side companion + the 15s SSE keepalive ping
  //     keep the session alive across the blip. We do NOT close the socket
  //     ourselves — closing it would force a new attach which the server
  //     correctly refuses (`session_consumed`), cascading into spurious
  //     re-mints.
  //
  //   - If EventSource fires `error` BEFORE `attached`, the initial attach
  //     never completed (token rejected, network down on first try, etc.).
  //     We close, count failures, back off, and re-mint after
  //     `TOKEN_DEAD_FAILURE_THRESHOLD` pre-attach failures. The re-mint here
  //     IS in the effect — but it only fires after multiple failures, well
  //     past StrictMode's synchronous double-invoke window. StrictMode's
  //     effect cleanup correctly cancels a single in-flight re-mint via
  //     `cancelled`.
  //
  //   - If the SSE delivers a structured `event: error` (e.g.
  //     `companion_start_failed` per `routes.js`), we treat that as a
  //     terminal trouble — no reconnect, no re-mint. The server has told
  //     us the companion is dead.
  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;
    let attached = false;
    let preAttachFailures = 0;
    let totalAttempts = 0;
    let backoffTimeoutId: ReturnType<typeof setTimeout> | null = null;
    let viewerUrl: string | null = null;

    // Seed refs from the pre-minted session so the attach path can find
    // the URLs immediately. This synchronous seed in the effect body
    // (not a separate effect) guarantees the refs are set before the first
    // attach attempt.
    const initial = initialSessionRef.current;
    inputUrlRef.current = initial.input_url;
    viewportUrlRef.current = initial.viewport_url;
    viewerUrl = initial.viewer_url;

    function clearBackoff() {
      if (backoffTimeoutId) {
        clearTimeout(backoffTimeoutId);
        backoffTimeoutId = null;
      }
    }

    function closeCurrentSource() {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    }

    /**
     * Re-mint path. Only fires after `TOKEN_DEAD_FAILURE_THRESHOLD` pre-attach
     * failures with no `attached` event in between — well past StrictMode's
     * synchronous double-invoke window. Each re-mint attempt gets a fresh
     * idempotency key (a re-mint is a new logical attempt, not a retry of an
     * earlier one); the server-side cache is defense-in-depth for any
     * fetch-layer retry that fires within the 60s window.
     */
    async function mintAndAttach(): Promise<void> {
      if (cancelled || !mountedRef.current) {
        return;
      }
      onStatus(CONNECTING);
      const viewport = readMintViewport();
      let minted: MintedStreamSession;
      try {
        minted = await mintStreamSessionAction({
          idempotencyKey: newIdempotencyKey(),
          interactionId,
          runId,
          viewport,
        });
      } catch (err) {
        if (!cancelled && mountedRef.current) {
          onStatus(classifyMintError(err));
        }
        return;
      }
      if (cancelled || !mountedRef.current) {
        return;
      }
      inputUrlRef.current = minted.input_url;
      viewportUrlRef.current = minted.viewport_url;
      viewerUrl = minted.viewer_url;
      // Fresh token => reset session-level state. A re-mint after token
      // death is a new lifecycle.
      attached = false;
      preAttachFailures = 0;
      setClipboardSheetOpen(false);
      setRemoteClipboard(null);
      setRemoteInputSensitive(false);
      keyboardResizeStateRef.current = createMobileKeyboardResizeState();
      controlStateRef.current = createStreamViewerControlState();
      localViewportSampleRef.current = readLocalViewportSample();
      attachWithCurrentToken();
    }

    /**
     * Schedule a pre-attach retry. Called when the initial SSE attach hasn't
     * succeeded yet (token never produced an `attached` event). Backs off,
     * eventually re-mints if the token looks dead.
     */
    function handlePreAttachFailure(): void {
      preAttachFailures += 1;
      totalAttempts += 1;
      if (totalAttempts >= MAX_RECONNECT_ATTEMPTS) {
        onStatus({
          display: "trouble",
          cause: "network",
          troubleMessage: "Couldn't reach the browser stream after several tries.",
        });
        return;
      }
      if (preAttachFailures >= TOKEN_DEAD_FAILURE_THRESHOLD) {
        viewerUrl = null;
        mintAndAttach().catch(() => {
          /* mintAndAttach surfaces terminal status itself */
        });
        return;
      }
      onStatus({
        display: "trouble",
        cause: "network",
        troubleMessage: "Connecting to the browser stream…",
      });
      const delayIndex = Math.min(preAttachFailures - 1, RECONNECT_BACKOFF_MS.length - 1);
      const delay = RECONNECT_BACKOFF_MS[delayIndex];
      clearBackoff();
      backoffTimeoutId = setTimeout(() => {
        backoffTimeoutId = null;
        attachWithCurrentToken();
      }, delay);
    }

    function attachWithCurrentToken(): void {
      if (cancelled || !mountedRef.current) {
        return;
      }
      if (!viewerUrl) {
        mintAndAttach().catch(() => {
          /* mintAndAttach surfaces terminal status itself */
        });
        return;
      }
      closeCurrentSource();
      const source = new EventSource(viewerUrl, { withCredentials: false });
      eventSourceRef.current = source;
      attachStreamHandlers(source, {
        onAttached: () => {
          attached = true;
          preAttachFailures = 0;
          totalAttempts = 0;
        },
        onTransportError: () => {
          if (cancelled || !mountedRef.current) {
            return;
          }
          if (eventSourceRef.current !== source) {
            // A newer attach has replaced us; ignore the dying socket's error.
            return;
          }
          if (attached) {
            // Live session, transient blip. EventSource handles its own
            // reconnect; the server keeps the session alive across the gap.
            // Do not close, do not re-attach, do not re-mint.
            return;
          }
          closeCurrentSource();
          handlePreAttachFailure();
        },
      });
    }

    // First attach uses the session passed in from the click handler — no
    // mint here. We defer the synchronous EventSource construction by one
    // microtask so React's StrictMode dev double-invoke (effect body →
    // cleanup → effect body again, all in the same task) doesn't both open
    // sockets. R1's microtask sees `cancelled === true` (set by R1 cleanup)
    // and bails before constructing the EventSource; only R2's microtask
    // actually attaches. In production (no StrictMode) this just adds one
    // microtask of latency before the network request — imperceptible.
    //
    // Without this guard, R1 would attach synchronously, R1 cleanup would
    // close the socket (server tears down + invalidates the single-use
    // session), then R2 would attempt to attach with the now-dead session
    // and trip the pre-attach failure path → re-mint cascade. Functional
    // but laggy in dev.
    queueMicrotask(() => {
      if (cancelled || !mountedRef.current) {
        return;
      }
      attachWithCurrentToken();
    });

    return () => {
      // Per-mount cleanup. We tear down THIS viewer's local resources
      // (SSE socket, backoff timer, popup toast timer) but do NOT
      // terminate the streaming session server-side. The session is
      // governed by its real lifecycle events (interaction resolved,
      // TTL expiry, companion failure) — not by the operator's modal
      // closing or by HMR/StrictMode unmounts. If the operator opens
      // the modal again before TTL, they reconnect to the same live
      // session.
      cancelled = true;
      mountedRef.current = false;
      clearBackoff();
      closeCurrentSource();
      if (popupTimeoutRef.current) {
        clearTimeout(popupTimeoutRef.current);
        popupTimeoutRef.current = null;
      }
      if (keyboardBlurTimeoutRef.current) {
        clearTimeout(keyboardBlurTimeoutRef.current);
        keyboardBlurTimeoutRef.current = null;
      }
    };
  }, [attachStreamHandlers, interactionId, onStatus, runId]);

  const applyStablePresentationViewport = useCallback((presentationViewport: StreamViewportInfo) => {
    stablePresentationViewportInfoRef.current = presentationViewport;
    if (streamViewportInfosMatch(presentationViewportInfoRef.current, presentationViewport)) {
      return;
    }
    presentationViewportInfoRef.current = presentationViewport;
    setPresentationViewportInfo(presentationViewport);
  }, []);

  const postViewport = useCallback(
    (
      width: number,
      height: number,
      { force = false, source = "unknown" }: { force?: boolean; source?: string } = {}
    ) => {
      const observedNode = containerRef.current;
      const url = viewportUrlRef.current;
      if (!url) {
        logDebug("viewport.skip.no-url", {
          measured: { height: Math.round(height), width: Math.round(width) },
          snapshot: readViewportDebugSnapshot(observedNode),
          source,
        });
        return;
      }
      const viewport = readViewerViewport(width, height);
      if (!viewport) {
        logDebug("viewport.skip.no-viewport", {
          measured: { height: Math.round(height), width: Math.round(width) },
          snapshot: readViewportDebugSnapshot(observedNode),
          source,
        });
        return;
      }
      const previous = lastPostedViewportRef.current;
      const previousLocal = localViewportSampleRef.current;
      const nextLocal = readLocalViewportSample();
      const viewportObservation = readViewportObservation();
      let viewportControlCommand: StreamViewerCommand | null = null;
      if (viewportObservation) {
        const step = reduceStreamViewerControl(controlStateRef.current, {
          observation: viewportObservation,
          source,
          type: "viewport.observed",
          viewport,
        });
        controlStateRef.current = step.state;
        viewportControlCommand = step.commands[0] ?? null;
      }
      localViewportSampleRef.current = nextLocal;
      const keyboardResize = assessMobileKeyboardViewportResize({
        hasLocalTextInputFocus: hasLocalTextInputFocus(),
        next: viewport,
        nextLocal,
        previous,
        previousLocal,
        state: force ? createMobileKeyboardResizeState() : keyboardResizeStateRef.current,
      });
      keyboardResizeStateRef.current = force ? createMobileKeyboardResizeState() : keyboardResize.state;
      const debugPayload = {
        force,
        keyboardResize: {
          mode: keyboardResize.state.mode,
          suppress: keyboardResize.suppress,
        },
        control: viewportControlCommand,
        local: {
          next: nextLocal,
          previous: previousLocal,
        },
        measured: { height: Math.round(height), width: Math.round(width) },
        previous,
        snapshot: readViewportDebugSnapshot(observedNode),
        source,
        viewport,
      };
      const logViewportDecision = (action: string, reason: string, extra: StreamDebugPayload = {}) => {
        logDebug("viewport.decision", {
          action,
          reason,
          ...debugPayload,
          ...extra,
        });
      };
      const decision = decideViewportPost({
        controlCommand: viewportControlCommand,
        force,
        keyboardResizeSuppress: keyboardResize.suppress,
        previous,
        viewport,
      });
      if (decision.action === "suppress" && decision.reason === "keyboard-resize") {
        logViewportDecision(decision.action, decision.reason);
        logDebug("viewport.suppress.keyboard", debugPayload);
        return;
      }
      if (decision.action === "suppress" && viewportControlCommand?.type === "viewport.hold") {
        logViewportDecision(decision.action, decision.reason, {
          control: viewportControlCommand,
        });
        logDebug("viewport.suppress.control", debugPayload);
        scheduleViewportHoldFollowUp(viewportControlCommand, source);
        return;
      }
      if (decision.action === "skip") {
        logViewportDecision(decision.action, decision.reason);
        logDebug("viewport.skip.equivalent", debugPayload);
        return;
      }
      keyboardResizeStateRef.current = createMobileKeyboardResizeState();
      lastPostedViewportRef.current = viewport;
      const viewportInfo = viewportInfoFromPayload(viewport);
      setViewportInfo(viewportInfo);
      logViewportDecision(decision.action, decision.reason);
      logDebug("viewport.post.start", debugPayload);
      const body = JSON.stringify(viewport);
      // Best-effort: a failed POST (401/410/5xx) is dropped; the next
      // legitimate resize will retry. Don't surface as `trouble` — the
      // stream is still functional, just at a stale viewport.
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        credentials: "omit",
        keepalive: true,
      })
        .then((response) => {
          logDebug("viewport.post.result", {
            ok: response.ok,
            source,
            status: response.status,
            viewport,
          });
        })
        .catch((err) => {
          logDebug("viewport.post.error", {
            error: err instanceof Error ? err.message : String(err),
            source,
            viewport,
          });
          /* see above */
        });
    },
    [logDebug, scheduleViewportHoldFollowUp]
  );

  const drainResizeSources = useCallback((fallback: string) => {
    const sources = Array.from(pendingResizeSourcesRef.current).join("+") || fallback;
    pendingResizeSourcesRef.current.clear();
    return sources;
  }, []);

  const drainPresentationSources = useCallback((fallback: string) => {
    const sources = Array.from(pendingPresentationSourcesRef.current).join("+") || fallback;
    pendingPresentationSourcesRef.current.clear();
    return sources;
  }, []);

  const recordLocalSurfaceViewport = useCallback(
    (source: string) => {
      const observedNode = containerRef.current;
      if (!observedNode) {
        return;
      }
      const rect = observedNode.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return;
      }
      const viewport = readViewerViewport(rect.width, rect.height);
      if (!viewport) {
        return;
      }
      const surfaceViewport = viewportInfoFromPayload(viewport);
      const previous = localSurfaceViewportInfoRef.current;
      if (streamViewportInfosMatch(previous, surfaceViewport)) {
        return;
      }
      localSurfaceViewportInfoRef.current = surfaceViewport;
      setLocalSurfaceViewportInfo(surfaceViewport);
      logDebug("viewport.surface.local", {
        measured: { height: Math.round(rect.height), width: Math.round(rect.width) },
        previous,
        snapshot: readViewportDebugSnapshot(observedNode),
        source,
        viewport,
      });
    },
    [logDebug]
  );

  const measureAndPost = useCallback(
    (source: string) => {
      const observedNode = containerRef.current;
      if (!observedNode) {
        return;
      }
      const rect = observedNode.getBoundingClientRect();
      logDebug("viewport.measure", {
        measured: { height: Math.round(rect.height), width: Math.round(rect.width) },
        snapshot: readViewportDebugSnapshot(observedNode),
        source,
      });
      if (rect.width <= 0 || rect.height <= 0) {
        return;
      }
      recordLocalSurfaceViewport(source);
      postViewport(rect.width, rect.height, { source });
    },
    [logDebug, postViewport, recordLocalSurfaceViewport]
  );

  useEffect(() => {
    requestViewportMeasureRef.current = measureAndPost;
    return () => {
      if (requestViewportMeasureRef.current === measureAndPost) {
        requestViewportMeasureRef.current = null;
      }
    };
  }, [measureAndPost]);

  const scheduleTrailingViewportReconcile = useCallback(
    (source: string) => {
      pendingResizeSourcesRef.current.add(source);
      if (trailingViewportReconcileRef.current) {
        clearTimeout(trailingViewportReconcileRef.current);
      }
      trailingViewportReconcileRef.current = setTimeout(() => {
        trailingViewportReconcileRef.current = null;
        measureAndPost(`${drainResizeSources(source)}+settle`);
      }, STREAM_VIEWER_POLICY.viewportResizeDebounceMs);
    },
    [drainResizeSources, measureAndPost]
  );

  const restoreStablePresentationViewport = useCallback(() => {
    const stableViewport = stablePresentationViewportInfoRef.current ?? presentationViewportInfoRef.current;
    if (stableViewport && !streamViewportInfosMatch(presentationViewportInfoRef.current, stableViewport)) {
      presentationViewportInfoRef.current = stableViewport;
      setPresentationViewportInfo(stableViewport);
    }
    return stableViewport;
  }, []);

  const reducePresentationViewportControl = useCallback((source: string, viewport: ViewportPayload) => {
    const viewportObservation = readViewportObservation();
    if (!viewportObservation) {
      return null;
    }
    const step = reduceStreamViewerControl(presentationControlStateRef.current, {
      observation: viewportObservation,
      source,
      type: "viewport.observed",
      viewport,
    });
    presentationControlStateRef.current = step.state;
    return step.commands[0] ?? null;
  }, []);

  const updatePresentationViewport = useCallback(
    (source: string) => {
      const observedNode = containerRef.current;
      if (!observedNode) {
        return;
      }
      const rect = observedNode.getBoundingClientRect();
      const viewport = readViewerViewport(rect.width, rect.height);
      if (!viewport) {
        return;
      }
      const presentationViewport = viewportInfoFromPayload(viewport);
      const nowMs = Date.now();
      const virtualKeyboard = typeof navigator === "undefined" ? null : readVirtualKeyboardSample();
      const keyboardActive =
        hasLocalTextInputFocus() || presentationKeyboardFocusedRef.current || Boolean(virtualKeyboard);
      presentationKeyboardHoldUntilRef.current = nextPresentationKeyboardHoldUntilMs({
        currentHoldUntilMs: presentationKeyboardHoldUntilRef.current,
        holdMs: STREAM_VIEWER_POLICY.presentationKeyboardOpenHoldMs,
        isKeyboardActive: keyboardActive,
        nowMs,
      });
      const holdForKeyboard = shouldHoldPresentationViewportForKeyboard({
        isMobileViewport: viewport.mobile,
        keyboardActive,
        keyboardHoldUntilMs: presentationKeyboardHoldUntilRef.current,
        nowMs,
        source,
      });
      if (holdForKeyboard) {
        const stableViewport = restoreStablePresentationViewport();
        logDebug("viewport.presentation.hold", {
          keyboardActive,
          keyboardHoldUntilMs: presentationKeyboardHoldUntilRef.current,
          measured: { height: Math.round(rect.height), width: Math.round(rect.width) },
          proposed: presentationViewport,
          reason: keyboardActive ? "keyboard-active" : "keyboard-settling",
          remoteKeyboardFocused: presentationKeyboardFocusedRef.current,
          snapshot: readViewportDebugSnapshot(observedNode),
          source,
          stable: stableViewport,
          virtualKeyboard,
          viewport,
        });
        return;
      }
      const presentationControlCommand = reducePresentationViewportControl(source, viewport);
      if (presentationControlCommand?.type === "viewport.hold") {
        const stableViewport = restoreStablePresentationViewport();
        scheduleViewportHoldFollowUp(presentationControlCommand, source);
        logDebug("viewport.presentation.hold", {
          command: presentationControlCommand,
          measured: { height: Math.round(rect.height), width: Math.round(rect.width) },
          proposed: presentationViewport,
          reason: presentationControlCommand.reason,
          snapshot: readViewportDebugSnapshot(observedNode),
          source,
          stable: stableViewport,
          viewport,
        });
        return;
      }
      if (streamViewportInfosMatch(presentationViewportInfoRef.current, presentationViewport)) {
        logDebug("viewport.presentation.skip", {
          reason: "equivalent",
          source,
          viewport,
        });
        return;
      }
      logDebug("viewport.presentation.pending", {
        measured: { height: Math.round(rect.height), width: Math.round(rect.width) },
        command: presentationControlCommand,
        previous: presentationViewportInfoRef.current,
        snapshot: readViewportDebugSnapshot(observedNode),
        source,
        viewport,
      });
    },
    [logDebug, reducePresentationViewportControl, restoreStablePresentationViewport, scheduleViewportHoldFollowUp]
  );

  const handleNekoPresentationViewportReady = useCallback(
    (readyViewport: StreamViewportInfo, result: { reasons?: string[]; status: "degraded" | "settled" }) => {
      const currentViewport = viewportInfoRef.current;
      if (result.status !== "settled") {
        logDebug("viewport.presentation.remote_skip", {
          current: currentViewport,
          ready: readyViewport,
          reason: "media-degraded",
          result,
        });
        return;
      }
      if (!streamViewportInfosMatch(currentViewport, readyViewport)) {
        logDebug("viewport.presentation.remote_skip", {
          current: currentViewport,
          ready: readyViewport,
          reason: "stale-media-settle",
          result,
        });
        return;
      }
      applyStablePresentationViewport(readyViewport);
      logDebug("viewport.presentation.remote", {
        result,
        viewport: readyViewport,
      });
    },
    [applyStablePresentationViewport, logDebug]
  );

  const schedulePresentationViewport = useCallback(
    (source: string) => {
      const nowMs = Date.now();
      presentationOrientationHoldUntilRef.current = nextPresentationOrientationHoldUntilMs({
        currentHoldUntilMs: presentationOrientationHoldUntilRef.current,
        holdMs: STREAM_VIEWER_POLICY.presentationOrientationHoldMs,
        nowMs,
        source,
      });
      pendingPresentationSourcesRef.current.add(source);
      const shouldDebounce = shouldDebouncePresentationViewportUpdate({
        nowMs,
        orientationHoldUntilMs: presentationOrientationHoldUntilRef.current,
        source,
      });
      if (!shouldDebounce) {
        if (presentationViewportTimerRef.current) {
          clearTimeout(presentationViewportTimerRef.current);
          presentationViewportTimerRef.current = null;
        }
        updatePresentationViewport(drainPresentationSources(source));
        return;
      }
      if (presentationViewportTimerRef.current) {
        clearTimeout(presentationViewportTimerRef.current);
      }
      presentationViewportTimerRef.current = setTimeout(() => {
        presentationViewportTimerRef.current = null;
        updatePresentationViewport(`${drainPresentationSources(source)}+presentation-settle`);
      }, STREAM_VIEWER_POLICY.presentationResizeDebounceMs);
    },
    [drainPresentationSources, updatePresentationViewport]
  );

  // ─── Dynamic viewport resize ──────────────────────────────────────────────
  //
  // The stream surface listens to element size, window size, orientation, and
  // visualViewport changes. All resize signals feed the same trailing debounce:
  // the remote browser should follow the user's settled control surface, not
  // every transient browser-chrome animation frame.
  useEffect(() => {
    if (typeof window === "undefined" || !containerNode) {
      return;
    }
    const scheduleSource = (source: string) => {
      recordLocalSurfaceViewport(source);
      schedulePresentationViewport(source);
      pendingResizeSourcesRef.current.add(source);
      scheduleTrailingViewportReconcile(source);
    };
    const orientationTimers: ReturnType<typeof setTimeout>[] = [];
    const scheduleOrientationSource = (source: string) => {
      scheduleSource(source);
      for (const delayMs of STREAM_VIEWER_POLICY.orientationFollowUpMs) {
        orientationTimers.push(
          setTimeout(() => {
            scheduleSource(`${source}.settle.${delayMs}ms`);
          }, delayMs)
        );
      }
    };
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            scheduleSource("ResizeObserver");
          });
    // ResizeObserver fires synchronously on observe() with the initial rect,
    // so an explicit `resize.initial` source duplicates that work and races the
    // streaming token's input route mounting on first viewport POST. Telemetry
    // showed this race producing a single `viewport.post.error` on
    // `resize.initial+settle` while subsequent ResizeObserver-driven posts
    // succeed.
    resizeObserver?.observe(containerNode);
    const orientationListener = () => scheduleOrientationSource("orientationchange");
    const windowResizeListener = () => scheduleSource("window.resize");
    const visualViewportResizeListener = () => scheduleSource("visualViewport.resize");
    const visualViewportScrollListener = () => scheduleSource("visualViewport.scroll");
    const visualViewport = window.visualViewport;
    const screenOrientation = typeof screen !== "undefined" && "orientation" in screen ? screen.orientation : undefined;
    const screenOrientationListener = () => scheduleOrientationSource("screen.orientation.change");
    window.addEventListener("orientationchange", orientationListener);
    window.addEventListener("resize", windowResizeListener);
    visualViewport?.addEventListener("resize", visualViewportResizeListener);
    visualViewport?.addEventListener("scroll", visualViewportScrollListener);
    screenOrientation?.addEventListener?.("change", screenOrientationListener);

    return () => {
      for (const timer of orientationTimers) {
        clearTimeout(timer);
      }
      resizeObserver?.disconnect();
      window.removeEventListener("orientationchange", orientationListener);
      window.removeEventListener("resize", windowResizeListener);
      visualViewport?.removeEventListener("resize", visualViewportResizeListener);
      visualViewport?.removeEventListener("scroll", visualViewportScrollListener);
      screenOrientation?.removeEventListener?.("change", screenOrientationListener);
    };
  }, [containerNode, recordLocalSurfaceViewport, schedulePresentationViewport, scheduleTrailingViewportReconcile]);

  useEffect(
    () => () => {
      if (presentationViewportTimerRef.current) {
        clearTimeout(presentationViewportTimerRef.current);
        presentationViewportTimerRef.current = null;
      }
      if (trailingViewportReconcileRef.current) {
        clearTimeout(trailingViewportReconcileRef.current);
        trailingViewportReconcileRef.current = null;
      }
      for (const timer of controlViewportReconcileTimersRef.current) {
        clearTimeout(timer);
      }
      controlViewportReconcileTimersRef.current.clear();
    },
    []
  );

  const handleMobileCopy = useCallback(() => {
    logDebug("neko.corner.copy", {
      phase: "start",
      remoteBuffered: Boolean(remoteClipboard),
      surface: clipboardPolicy.surface,
    });
    if (remoteClipboard) {
      copySheetTextToDevice({
        logDebug,
        policy: clipboardPolicy,
        remoteClipboard,
        setCopyState: (state) => {
          logDebug("neko.corner.copy", {
            phase: "device-write-result",
            state,
            surface: clipboardPolicy.surface,
          });
          if (state !== "copied") {
            setClipboardSheetOpen(true);
          }
        },
      }).catch((err) => {
        logDebug("neko.corner.copy", {
          error: err instanceof Error ? err.message : String(err),
          phase: "device-write-error",
          surface: clipboardPolicy.surface,
        });
        setClipboardSheetOpen(true);
      });
      return;
    }
    requestBrowserCopyFromSheet({
      logDebug,
      policy: clipboardPolicy,
      setCopyState: (state) => {
        logDebug("neko.corner.copy", {
          phase: "browser-copy-result",
          state,
          surface: clipboardPolicy.surface,
        });
        if (state === "failed") {
          setClipboardSheetOpen(true);
        }
      },
    });
  }, [clipboardPolicy, logDebug, remoteClipboard]);

  const handleMobilePaste = useCallback(() => {
    logDebug("neko.corner.paste", { phase: "start", surface: clipboardPolicy.surface });
    pasteLocalClipboardIntoNeko()
      .then((pasted) => {
        logDebug("neko.corner.paste", {
          pasted,
          phase: "result",
          surface: clipboardPolicy.surface,
        });
        if (!pasted) {
          setClipboardSheetOpen(true);
        }
      })
      .catch((err) => {
        logDebug("neko.corner.paste", {
          error: err instanceof Error ? err.message : String(err),
          phase: "error",
          surface: clipboardPolicy.surface,
        });
        setClipboardSheetOpen(true);
      });
  }, [clipboardPolicy.surface, logDebug]);

  return (
    <div className="relative flex h-full w-full flex-col bg-black" data-pdpp-stream-debug={debugEnabled}>
      {nekoSession ? (
        <NekoSurface
          debugEnabled={debugEnabled}
          localSurfaceViewportInfo={localSurfaceViewportInfo}
          logDebug={logDebug}
          onPresentationViewportReady={handleNekoPresentationViewportReady}
          presentationViewportInfo={presentationViewportInfo}
          session={nekoSession}
          status={status}
          surfaceRef={setStreamSurfaceNode}
          viewportInfo={viewportInfo}
        />
      ) : (
        <BrowserSurface
          clipboardPolicy={clipboardPolicy}
          containerRef={containerRef}
          debugEnabled={debugEnabled}
          imgSrc={imgSrc}
          inputUrlRef={inputUrlRef}
          logDebug={logDebug}
          status={status}
          surfaceRef={setStreamSurfaceNode}
          viewportInfo={viewportInfo}
        />
      )}
      <CornerControls
        connectorName={connectorName}
        location={location}
        onClose={onClose}
        onCopy={nekoSession && clipboardPolicy.showMobileCopyButton ? handleMobileCopy : undefined}
        onKeyboard={
          nekoSession && clipboardPolicy.showKeyboardButton
            ? () => {
                focusNekoKeyboard();
                logDebug("neko.corner.keyboard", {
                  snapshot: readSurfaceDebugSnapshot(containerRef.current),
                });
              }
            : undefined
        }
        onPaste={nekoSession && clipboardPolicy.showMobilePasteButton ? handleMobilePaste : undefined}
        status={status}
      />
      {status.display === "trouble" ? <TroubleToast message={status.troubleMessage} /> : null}
      {popup ? <PopupToast message={popup.message} /> : null}
      {nekoSession &&
      remoteClipboard &&
      clipboardPolicy.showClipboardSheet &&
      !clipboardSheetOpen &&
      clipboardNoticeOpen ? (
        <ClipboardNoticeToast />
      ) : null}
      {nekoSession && clipboardPolicy.showClipboardSheet ? (
        <ClipboardSheet
          capabilities={clipboardCapabilities}
          connectorName={connectorName}
          logDebug={logDebug}
          onClearRemoteClipboard={() => setRemoteClipboard(null)}
          onOpenChange={setClipboardSheetOpen}
          open={clipboardSheetOpen}
          policy={clipboardPolicy}
          remoteClipboard={remoteClipboard}
          remoteInputSensitive={remoteInputSensitive}
        />
      ) : null}
    </div>
  );
}

function normalizeNekoClientConfig(payload: NekoClientConfigResponse): NekoClientConfig {
  const rawServerPath =
    typeof payload.server_path === "string" && payload.server_path.length > 0 ? payload.server_path : "/neko";
  const serverPath = rawServerPath.startsWith("/") ? `${window.location.origin}${rawServerPath}` : rawServerPath;
  const rawStatusPath =
    typeof payload.status_path === "string" && payload.status_path.length > 0 ? payload.status_path : null;
  const statusPath = rawStatusPath?.startsWith("/") ? `${window.location.origin}${rawStatusPath}` : rawStatusPath;
  const username = payload.login?.username;
  const password = payload.login?.password;
  return {
    login: typeof username === "string" && typeof password === "string" ? { username, password } : null,
    serverPath,
    statusPath,
  };
}

function readNekoScreenSize(payload: unknown): { height: number; width: number } | null {
  const root = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  const status = root?.status && typeof root.status === "object" ? (root.status as Record<string, unknown>) : root;
  const screen =
    status?.screen && typeof status.screen === "object" ? (status.screen as Record<string, unknown>) : null;
  const size = screen?.size && typeof screen.size === "object" ? (screen.size as Record<string, unknown>) : screen;
  const width = Number(size?.width);
  const height = Number(size?.height);
  return Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0 ? { width, height } : null;
}

function readNekoStatusSnapshot(payload: unknown): NekoStatusSnapshot {
  const root = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  const status = root?.status && typeof root.status === "object" ? (root.status as Record<string, unknown>) : null;
  const page = status?.page && typeof status.page === "object" ? (status.page as Record<string, unknown>) : null;
  const pageMetricsMismatch =
    status?.page_metrics_mismatch && typeof status.page_metrics_mismatch === "object"
      ? (status.page_metrics_mismatch as Record<string, unknown>)
      : null;
  const pageMetricsMismatchAfterReapply =
    status?.page_metrics_mismatch_after_reapply && typeof status.page_metrics_mismatch_after_reapply === "object"
      ? (status.page_metrics_mismatch_after_reapply as Record<string, unknown>)
      : null;
  // The adapter drains `window.__pdppPlaygroundEvents` into the page
  // status response; surface them up so the viewer can correlate
  // remote-side click/focus/scroll events against local touch telemetry.
  let pageWithoutPlayground = page;
  let playgroundEvents: Array<Record<string, unknown>> | null = null;
  if (page) {
    const rawPlaygroundEvents = page.playgroundEvents;
    if (Array.isArray(rawPlaygroundEvents) && rawPlaygroundEvents.length > 0) {
      playgroundEvents = rawPlaygroundEvents.filter(
        (entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object"
      );
    }
    if ("playgroundEvents" in page) {
      // Avoid logging the buffer twice: the dedicated `playground.*`
      // events carry the per-event detail.
      const { playgroundEvents: _drained, ...rest } = page;
      pageWithoutPlayground = rest;
    }
  }
  return {
    page: pageWithoutPlayground,
    pageCdpAvailable: typeof status?.page_cdp_available === "boolean" ? status.page_cdp_available : null,
    pageMetricsMismatch,
    pageMetricsMismatchAfterReapply,
    playgroundEvents,
    screen: readNekoScreenSize(payload),
  };
}

async function fetchNekoStatus(statusPath: string): Promise<NekoStatusSnapshot> {
  const response = await fetch(statusPath, { credentials: "same-origin" });
  if (!response.ok) {
    return {
      page: null,
      pageCdpAvailable: null,
      pageMetricsMismatch: null,
      pageMetricsMismatchAfterReapply: null,
      playgroundEvents: null,
      screen: null,
    };
  }
  return readNekoStatusSnapshot(await response.json());
}

async function fetchNekoStatusBestEffort(statusPath: string): Promise<NekoStatusSnapshot> {
  try {
    return await fetchNekoStatus(statusPath);
  } catch {
    return {
      page: null,
      pageCdpAvailable: null,
      pageMetricsMismatch: null,
      pageMetricsMismatchAfterReapply: null,
      playgroundEvents: null,
      screen: null,
    };
  }
}

function metricNearlyEqual(actual: unknown, expected: unknown, tolerance = 1): boolean {
  const a = typeof actual === "number" && Number.isFinite(actual) ? actual : null;
  const b = typeof expected === "number" && Number.isFinite(expected) ? expected : null;
  return a !== null && b !== null && Math.abs(a - b) <= tolerance;
}

function pageFitsViewport(status: NekoStatusSnapshot, viewport: StreamViewportInfo): boolean {
  if (status.pageMetricsMismatch || status.pageMetricsMismatchAfterReapply) {
    return false;
  }
  if (!status.page || typeof status.page !== "object") {
    return true;
  }
  const target = viewportCaptureSize(viewport);
  return (
    metricNearlyEqual(status.page.innerWidth, viewport.width) &&
    metricNearlyEqual(status.page.innerHeight, viewport.height) &&
    metricNearlyEqual(status.page.screenWidth, target.width) &&
    metricNearlyEqual(status.page.screenHeight, target.height) &&
    (viewport.deviceScaleFactor === undefined ||
      metricNearlyEqual(status.page.devicePixelRatio, viewport.deviceScaleFactor, 0.01))
  );
}

function screenFitsViewport(screen: { height: number; width: number }, viewport: StreamViewportInfo): boolean {
  const target = viewportCaptureSize(viewport);
  const isPortraitLike = (size: { height: number; width: number }) => size.height > size.width * 1.1;
  const isLandscapeLike = (size: { height: number; width: number }) => size.width > size.height * 1.1;
  const orientationCompatible =
    (isPortraitLike(target) && isPortraitLike(screen)) ||
    (isLandscapeLike(target) && isLandscapeLike(screen)) ||
    !(isPortraitLike(target) || isLandscapeLike(target));
  if (!orientationCompatible) {
    return false;
  }
  const scale = Math.max(target.width / screen.width, target.height / screen.height);
  const displayedWidth = screen.width * scale;
  const displayedHeight = screen.height * scale;
  const horizontalCropArea = Math.max(0, displayedWidth - target.width) * target.height;
  const verticalCropArea = Math.max(0, displayedHeight - target.height) * target.width;
  const cropArea = horizontalCropArea + verticalCropArea * VERTICAL_CROP_WEIGHT;
  return cropArea / (target.width * target.height) <= MAX_COVER_CROP_RATIO;
}

function waitForNekoStatusPoll(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, STREAM_VIEWER_POLICY.nekoStatusPollMs);
  });
}

async function loadNekoClientConfig(clientConfigPath: string): Promise<NekoClientConfig> {
  const response = await fetch(clientConfigPath, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`n.eko client config failed with HTTP ${response.status}`);
  }
  const payload = (await response.json()) as NekoClientConfigResponse;
  return normalizeNekoClientConfig(payload);
}

// ─── The direct n.eko WebRTC surface ──────────────────────────────────────────

function NekoSurface({
  debugEnabled,
  localSurfaceViewportInfo,
  logDebug,
  onPresentationViewportReady,
  presentationViewportInfo,
  session,
  surfaceRef,
  status,
  viewportInfo,
}: {
  debugEnabled: boolean;
  localSurfaceViewportInfo: StreamViewportInfo | null;
  logDebug: StreamDebugLogger;
  onPresentationViewportReady: (
    viewport: StreamViewportInfo,
    result: { reasons?: string[]; status: "degraded" | "settled" }
  ) => void;
  presentationViewportInfo: StreamViewportInfo | null;
  session: NekoSessionInfo;
  surfaceRef: (node: HTMLDivElement | null) => void;
  status: ConnectionStatus;
  viewportInfo: StreamViewportInfo | null;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const layoutRequestRef = useRef(0);
  const firstNekoLayoutAppliedRef = useRef(false);
  const mediaSettleStateRef = useRef(createNekoMediaSettleState());
  const presentationViewportInfoRef = useRef(presentationViewportInfo);
  const [clientConfig, setClientConfig] = useState<NekoClientConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mediaReady, setMediaReady] = useState(false);
  useSurfaceDebugTelemetry({ containerRef, debugEnabled, logDebug, surface: "neko", viewportInfo });
  useVisualQualityDebugTelemetry({ containerRef, debugEnabled, logDebug, surface: "neko", viewportInfo });

  useEffect(() => {
    presentationViewportInfoRef.current = presentationViewportInfo;
  }, [presentationViewportInfo]);

  useEffect(() => {
    const mountNode = containerRef.current;
    if (!mountNode) {
      return;
    }
    const nekoMountNode: HTMLElement = mountNode;
    let cancelled = false;
    setClientConfig(null);
    setError(null);
    setMediaReady(false);

    const connection = loadNekoClientConfig(session.clientConfigPath)
      .then(async (config) => {
        if (cancelled) {
          return;
        }
        setClientConfig(config);
        await startNeko(nekoMountNode, config);
        if (cancelled) {
          stopNeko(nekoMountNode);
          return;
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "n.eko direct stream failed");
        }
      });

    connection.catch(() => {
      /* handled above */
    });

    return () => {
      cancelled = true;
      setClientConfig(null);
      stopNeko(nekoMountNode);
    };
  }, [session.clientConfigPath]);

  useEffect(() => {
    const viewport = presentationViewportInfo ?? viewportInfo;
    if (!viewport) {
      return;
    }
    const layout = viewportLayoutFromInfo(viewport);
    const actualContainerRect = readContainerRect(containerRef.current);
    const containerRect = stablePresentationContainerRect(actualContainerRect, presentationViewportInfo);
    setNekoPresentationViewportLayout(layout, { containerRect });
    logDebug("neko.layout.presentation", {
      actualContainerRect,
      containerRect,
      layout,
      reason: presentationViewportInfo ? "local-viewport" : "posted-viewport",
    });
  }, [logDebug, presentationViewportInfo, viewportInfo]);

  useEffect(() => {
    if (!viewportInfo) {
      layoutRequestRef.current += 1;
      if (!presentationViewportInfoRef.current) {
        setNekoViewportLayout(null);
      }
      logDebug("neko.layout.clear", {
        reason: "missing-viewport",
      });
      return;
    }

    // Gate the first layout call on the status path being known. If we apply
    // an optimistic layout before clientConfig resolves, n.eko picks a screen
    // mode from the synthesized viewport (often the wrong one), which then
    // emits `neko.layout.fallback reason=missing-status-path`. The optimistic
    // path is only safe once we already have a real screen size from the
    // status endpoint — i.e. on subsequent viewportInfo changes after the
    // first `apply-screen` call.
    const statusPath = clientConfig?.statusPath ?? null;
    if (clientConfig === null && !firstNekoLayoutAppliedRef.current) {
      logDebug("neko.layout.deferred", {
        reason: "client-config-pending",
        viewport: viewportInfo,
      });
      return;
    }

    const viewport = viewportInfo;
    const optimisticLayout = viewportLayoutFromInfo(viewport);
    const containerRect = readContainerRect(containerRef.current);
    const applyRequestedLayout =
      !presentationViewportInfo || streamViewportInfosMatch(presentationViewportInfo, viewport);
    if (applyRequestedLayout) {
      setNekoViewportLayout(optimisticLayout, { containerRect });
      logDebug("neko.layout.optimistic", {
        containerRect,
        layout: optimisticLayout,
        reason: "viewport-changed",
      });
    } else {
      logDebug("neko.layout.deferred_presentation", {
        containerRect,
        layout: optimisticLayout,
        presentationViewport: presentationViewportInfo,
        reason: "media-not-settled",
        viewport,
      });
    }

    if (!statusPath) {
      logDebug("neko.layout.fallback", {
        layout: optimisticLayout,
        reason: "no-status-path-configured",
      });
      return;
    }
    const resolvedStatusPath = statusPath;

    const requestId = layoutRequestRef.current + 1;
    layoutRequestRef.current = requestId;
    let cancelled = false;
    let latestPolledScreen: { height: number; width: number } | null = null;
    let sawFittingScreen = false;

    function applyScreen(screen: { height: number; width: number }) {
      const layout = {
        screenHeight: screen.height,
        screenWidth: screen.width,
        viewportHeight: viewport.height,
        viewportWidth: viewport.width,
      };
      const rect = readContainerRect(containerRef.current);
      if (!applyRequestedLayout) {
        logDebug("neko.layout.apply-screen.deferred", {
          containerRect: rect,
          layout,
          presentationViewport: presentationViewportInfo,
          reason: "media-not-settled",
          requestId,
        });
        return;
      }
      setNekoViewportLayout(layout, { containerRect: rect });
      firstNekoLayoutAppliedRef.current = true;
      logDebug("neko.layout.apply-screen", {
        containerRect: rect,
        layout,
        requestId,
      });
    }

    function applyFallback() {
      const screen = latestPolledScreen ?? viewportCaptureSize(viewport);
      const layout = {
        screenHeight: screen.height,
        screenWidth: screen.width,
        viewportHeight: viewport.height,
        viewportWidth: viewport.width,
      };
      const rect = readContainerRect(containerRef.current);
      if (!applyRequestedLayout) {
        logDebug("neko.layout.fallback.deferred", {
          containerRect: rect,
          layout,
          presentationViewport: presentationViewportInfo,
          reason: latestPolledScreen ? "last-polled-screen-did-not-fit" : "no-fitting-screen-status",
          requestId,
        });
        return;
      }
      setNekoViewportLayout(layout, { containerRect: rect });
      firstNekoLayoutAppliedRef.current = true;
      logDebug("neko.layout.fallback", {
        containerRect: rect,
        layout,
        reason: latestPolledScreen ? "last-polled-screen-did-not-fit" : "no-fitting-screen-status",
        requestId,
      });
    }

    function isCurrentRequest() {
      return !cancelled && layoutRequestRef.current === requestId;
    }

    function emitPlaygroundEvents(status: NekoStatusSnapshot) {
      if (!status.playgroundEvents || status.playgroundEvents.length === 0) {
        return;
      }
      for (const entry of status.playgroundEvents) {
        const type = typeof entry.type === "string" ? entry.type : "unknown";
        // Each remote-page event is mirrored into the viewer's debug
        // sink so the operator can correlate by approximate timestamp
        // against `neko.touch.start` / `neko.touch_scroll_bridge.tap`
        // / `neko.touch_scroll_bridge.native_tap_observed`.
        logDebug(`playground.${type}`, {
          ...entry,
          source: "remote-status-poll",
        });
      }
    }

    function handlePolledStatus(status: NekoStatusSnapshot) {
      emitPlaygroundEvents(status);
      if (!isCurrentRequest()) {
        return "done";
      }
      const screen = status.screen;
      if (!screen) {
        logDebug("neko.status.poll", {
          page: status.page,
          pageCdpAvailable: status.pageCdpAvailable,
          requestId,
          result: "missing-screen",
          viewport,
        });
        return "retry";
      }

      latestPolledScreen = screen;
      const fitsScreen = screenFitsViewport(screen, viewport);
      const fitsPage = pageFitsViewport(status, viewport);
      const fits = fitsScreen && fitsPage;
      logDebug("neko.status.poll", {
        fits,
        fitsPage,
        fitsScreen,
        page: status.page,
        pageCdpAvailable: status.pageCdpAvailable,
        pageMetricsMismatch: status.pageMetricsMismatch,
        pageMetricsMismatchAfterReapply: status.pageMetricsMismatchAfterReapply,
        requestId,
        result: fits ? "done" : "retry",
        screen,
        viewport,
      });
      if (!fits) {
        return "retry";
      }
      sawFittingScreen = true;
      applyScreen(screen);
      return "done";
    }

    async function pollForLayout() {
      for (let attempt = 1; attempt <= STREAM_VIEWER_POLICY.nekoStatusPollAttempts; attempt += 1) {
        logDebug("neko.status.poll-start", {
          attempt,
          requestId,
          viewport,
        });
        const status = await fetchNekoStatusBestEffort(resolvedStatusPath);
        if (handlePolledStatus(status) === "done") {
          return;
        }
        const canRetry = attempt < STREAM_VIEWER_POLICY.nekoStatusPollAttempts;
        if (canRetry) {
          await waitForNekoStatusPoll();
        }
      }
      if (!sawFittingScreen && isCurrentRequest()) {
        applyFallback();
      }
    }

    pollForLayout().catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [clientConfig, logDebug, presentationViewportInfo, viewportInfo]);

  useEffect(() => {
    if (!(clientConfig && viewportInfo)) {
      mediaSettleStateRef.current = createNekoMediaSettleState();
      return;
    }

    setMediaReady(false);
    mediaSettleStateRef.current = createNekoMediaSettleState();
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let pollCount = 0;

    const poll = () => {
      if (cancelled) {
        return;
      }
      pollCount += 1;
      const sample = readNekoMediaSettleSample(viewportCaptureSize(viewportInfo));
      if (sample) {
        const result = assessNekoMediaSettle({
          maxSettlingSamples: STREAM_VIEWER_POLICY.nekoMediaSettleMaxPolls,
          sample,
          state: mediaSettleStateRef.current,
        });
        mediaSettleStateRef.current = result.state;
        logDebug("neko.media.settle.sample", {
          pollCount,
          reasons: result.reasons,
          sample,
          status: result.status,
        });
        if (result.status === "settled") {
          setMediaReady(true);
          onPresentationViewportReady(viewportInfo, { status: "settled" });
          return;
        }
        if (result.status === "degraded") {
          setMediaReady(true);
          logDebug("viewport.presentation.remote_skip", {
            reason: "media-degraded",
            result: { reasons: result.reasons, status: "degraded" },
            viewport: viewportInfo,
          });
          return;
        }
      } else {
        logDebug("neko.media.settle.skip", {
          pollCount,
          reason: "missing-neko-instance",
          viewport: viewportInfo,
        });
      }
      if (pollCount < STREAM_VIEWER_POLICY.nekoMediaSettleMaxPolls) {
        pollTimer = setTimeout(poll, STREAM_VIEWER_POLICY.nekoMediaSettlePollMs);
      }
    };

    pollTimer = setTimeout(poll, STREAM_VIEWER_POLICY.nekoMediaSettlePollMs);
    return () => {
      cancelled = true;
      if (pollTimer) {
        clearTimeout(pollTimer);
      }
    };
  }, [clientConfig, logDebug, onPresentationViewportReady, viewportInfo]);

  const presentationMatchesRequestedViewport =
    !!presentationViewportInfo && !!viewportInfo && streamViewportInfosMatch(presentationViewportInfo, viewportInfo);
  const localSurfaceCanDisplay =
    presentationMatchesRequestedViewport &&
    localSurfaceCanDisplayPresentation(localSurfaceViewportInfo, presentationViewportInfo);
  const showLoadingOverlay = !(
    error ||
    (mediaReady && presentationMatchesRequestedViewport && localSurfaceCanDisplay)
  );

  return (
    <div className="flex flex-1 items-center justify-center overflow-hidden">
      <div
        aria-label="Connector browser stream"
        className="pdpp-stream-frame relative overflow-hidden"
        data-pdpp-stream-loading={showLoadingOverlay || undefined}
        ref={(node) => {
          containerRef.current = node;
          surfaceRef(node);
        }}
        role="application"
      >
        {error ? (
          <div
            className="absolute inset-0 z-20 flex items-center justify-center bg-background/95 p-6 text-center text-muted-foreground text-sm"
            data-pdpp-stream-ui
          >
            <div className="max-w-sm">
              <p className="font-medium text-foreground">The n.eko WebRTC stream did not attach.</p>
              <p className="mt-2">{error}</p>
            </div>
          </div>
        ) : null}
        {showLoadingOverlay ? (
          <div
            aria-hidden="true"
            className="absolute inset-0 z-20 flex items-center justify-center bg-black text-sm text-white/70"
            data-pdpp-stream-loading
          >
            {status.display === "live" ? "Starting WebRTC stream..." : "Waiting for browser..."}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function BrowserSurface({
  clipboardPolicy,
  containerRef,
  debugEnabled,
  imgSrc,
  inputUrlRef,
  logDebug,
  surfaceRef,
  status,
  viewportInfo,
}: {
  clipboardPolicy: ClipboardPolicyDecision;
  containerRef: RefObject<HTMLDivElement | null>;
  debugEnabled: boolean;
  imgSrc: string | null;
  inputUrlRef: RefObject<string | null>;
  logDebug: StreamDebugLogger;
  surfaceRef: (node: HTMLDivElement | null) => void;
  status: ConnectionStatus;
  viewportInfo: StreamViewportInfo | null;
}) {
  // The aspect of the connector's browser viewport. Letterboxed inside the
  // overlay's full screen — that's correct: the operator's phone aspect
  // ratio isn't the connector's.
  const aspect = viewportInfo ? `${viewportInfo.width} / ${viewportInfo.height}` : "16 / 10";
  const imgRef = useRef<HTMLImageElement | null>(null);
  const clipboardPolicyRef = useRef(clipboardPolicy);
  clipboardPolicyRef.current = clipboardPolicy;

  // Throttle state for continuous-motion events: reduces network requests from
  // ~60/sec down to ~30/sec. Mouse and touch motion don't need sub-frame precision;
  // throttling prevents network saturation and reference-side CDP back-pressure.
  // Only mousemove and touchmove are throttled; everything else (down/up/click/
  // key/wheel/paste/touchstart/touchend) fires immediately. The cancel path
  // discards any pending throttled coords so a stale move doesn't outlive the gesture.
  const motionThrottleRef = useRef<{
    mouseTimeoutId: ReturnType<typeof setTimeout> | null;
    mousePendingCoords: { x: number; y: number } | null;
    touchTimeoutId: ReturnType<typeof setTimeout> | null;
    touchPendingTouch: { x: number; y: number; id: number } | null;
  }>({
    mouseTimeoutId: null,
    mousePendingCoords: null,
    touchTimeoutId: null,
    touchPendingTouch: null,
  });
  const MOTION_THROTTLE_MS = 33; // ~30 Hz; generous for remote stream

  // Mobile soft-keyboard trigger. We can't ask CDP whether the streamed page's
  // focused element wants text (Runtime/DOM are blocked by the stealth
  // allowlist — see server/streaming/cdp-method-allowlist.test.js). Instead,
  // place a visually-hidden but focusable <input> inside the surface; on the
  // first touch interaction we focus() it so the OS opens the soft keyboard.
  // Keystrokes still bubble up to the role="application" div's onKeyDown/Up
  // handlers (single dispatch — the input has no key handlers of its own), so
  // CDP receives exactly one keyboard event per press regardless of focus.
  // Gated by `(pointer: coarse)` so desktop's real keyboard isn't disrupted
  // by stealing focus to the hidden input.
  const softKeyboardInputRef = useRef<HTMLInputElement | null>(null);
  useSurfaceDebugTelemetry({ containerRef, debugEnabled, logDebug, surface: "cdp-frame", viewportInfo });
  useVisualQualityDebugTelemetry({ containerRef, debugEnabled, logDebug, surface: "cdp-frame", viewportInfo });
  function focusSoftKeyboardIfMobile() {
    if (typeof window === "undefined") {
      return;
    }
    try {
      if (!window.matchMedia("(pointer: coarse)").matches) {
        logDebug("surface.cdp-frame.soft_keyboard.skip", {
          reason: "fine-pointer",
        });
        return;
      }
    } catch {
      logDebug("surface.cdp-frame.soft_keyboard.skip", {
        reason: "match-media-error",
      });
      return;
    }
    softKeyboardInputRef.current?.focus();
    logDebug("surface.cdp-frame.soft_keyboard.focus", {
      active: document.activeElement === softKeyboardInputRef.current,
      snapshot: readSurfaceDebugSnapshot(containerRef.current),
    });
  }

  // Stable refs so the wheel/paste useEffect doesn't tear down on every render.
  // These functions read from refs only (containerRef, inputUrlRef) so capturing
  // them once on mount is correct and matches the React handler behaviour.
  const postInput = useCallback(
    async (payload: Record<string, unknown>) => {
      const url = inputUrlRef.current;
      if (!url) {
        logDebug("stream.input.skip", {
          payload: inputPostDebugPayload(payload),
          reason: "missing-input-url",
        });
        return;
      }
      const logInput = shouldLogInputPost(payload);
      if (logInput) {
        logDebug("stream.input.post.start", {
          payload: inputPostDebugPayload(payload),
        });
      }
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          credentials: "omit",
        });
        if (logInput) {
          logDebug("stream.input.post.result", {
            ok: response.ok,
            payload: inputPostDebugPayload(payload),
            status: response.status,
          });
        }
      } catch (err) {
        if (logInput) {
          logDebug("stream.input.post.error", {
            error: err instanceof Error ? err.message : String(err),
            payload: inputPostDebugPayload(payload),
          });
        }
        /* a single dropped input is non-fatal; the user will retry */
      }
    },
    [inputUrlRef, logDebug]
  );

  const localCoords = useCallback(
    (event: { clientX: number; clientY: number }): { x: number; y: number } | null => {
      const node = containerRef.current;
      if (!node) {
        return null;
      }
      const img = imgRef.current;
      return pointToStreamViewport(event, {
        containerBox: node.getBoundingClientRect(),
        imageBox: img?.getBoundingClientRect(),
        viewport: viewportInfo,
      });
    },
    [containerRef, viewportInfo]
  );

  function handleMouseMove(e: ReactMouseEvent<HTMLDivElement>) {
    const c = localCoords(e);
    if (!c) {
      return;
    }
    const state = motionThrottleRef.current;
    state.mousePendingCoords = c;
    if (state.mouseTimeoutId) {
      return;
    }
    postInput({ type: "mouse", action: "mousemove", x: c.x, y: c.y }).catch(() => undefined);
    state.mouseTimeoutId = setTimeout(() => {
      state.mouseTimeoutId = null;
      if (state.mousePendingCoords) {
        const coords = state.mousePendingCoords;
        state.mousePendingCoords = null;
        postInput({ type: "mouse", action: "mousemove", x: coords.x, y: coords.y }).catch(() => undefined);
      }
    }, MOTION_THROTTLE_MS);
  }

  function handleMouseDown(e: ReactMouseEvent<HTMLDivElement>) {
    const c = localCoords(e);
    if (!c) {
      return;
    }
    postInput({ type: "mouse", action: "mousedown", x: c.x, y: c.y, button: e.button ?? 0 }).catch(() => undefined);
  }

  function handleMouseUp(e: ReactMouseEvent<HTMLDivElement>) {
    const c = localCoords(e);
    if (!c) {
      return;
    }
    postInput({ type: "mouse", action: "mouseup", x: c.x, y: c.y, button: e.button ?? 0 }).catch(() => undefined);
  }

  function firstChangedTouch(e: ReactTouchEvent<HTMLDivElement>): { x: number; y: number; id: number } | null {
    // The wire schema accepts a single touch point per event. We send the
    // first changed touch — multi-touch isn't supported on the wire and
    // splitting one gesture into multiple events would race the CDP queue.
    const t = e.changedTouches[0];
    if (!t) {
      return null;
    }
    const coords = localCoords({ clientX: t.clientX, clientY: t.clientY });
    if (!coords) {
      return null;
    }
    return { ...coords, id: t.identifier };
  }

  function handleTouchStart(e: ReactTouchEvent<HTMLDivElement>) {
    // Focus the hidden input so the mobile OS opens the soft keyboard. Safe
    // to re-call on every touch — focus() on an already-focused element is a
    // no-op, and re-focusing recovers from cases where the OS dismissed the
    // keyboard after the operator tapped elsewhere on the streamed page.
    focusSoftKeyboardIfMobile();
    const t = firstChangedTouch(e);
    if (!t) {
      return;
    }
    postInput({ type: "touch", action: "touchstart", x: t.x, y: t.y, id: t.id }).catch(() => undefined);
  }

  function handleTouchMove(e: ReactTouchEvent<HTMLDivElement>) {
    const t = firstChangedTouch(e);
    if (!t) {
      return;
    }
    const state = motionThrottleRef.current;
    state.touchPendingTouch = t;
    if (state.touchTimeoutId) {
      return;
    }
    postInput({ type: "touch", action: "touchmove", x: t.x, y: t.y, id: t.id }).catch(() => undefined);
    state.touchTimeoutId = setTimeout(() => {
      state.touchTimeoutId = null;
      if (state.touchPendingTouch) {
        const pending = state.touchPendingTouch;
        state.touchPendingTouch = null;
        postInput({ type: "touch", action: "touchmove", x: pending.x, y: pending.y, id: pending.id }).catch(
          () => undefined
        );
      }
    }, MOTION_THROTTLE_MS);
  }

  function handleTouchEnd(e: ReactTouchEvent<HTMLDivElement>) {
    // Drop any in-flight throttled touchmove so a stale coord doesn't arrive
    // after the gesture ended.
    const state = motionThrottleRef.current;
    if (state.touchTimeoutId) {
      clearTimeout(state.touchTimeoutId);
      state.touchTimeoutId = null;
    }
    state.touchPendingTouch = null;
    const t = firstChangedTouch(e);
    if (!t) {
      // Wire schema allows touchend with empty touchPoints (id ignored server-side).
      postInput({ type: "touch", action: "touchend", x: 0, y: 0 }).catch(() => undefined);
      return;
    }
    postInput({ type: "touch", action: "touchend", x: t.x, y: t.y, id: t.id }).catch(() => undefined);
  }

  function handleTouchCancel(e: ReactTouchEvent<HTMLDivElement>) {
    // Wire schema has no `touchcancel`; the server's CDP mapper produces
    // `Input.dispatchTouchEvent` with `type: 'touchEnd'` on touchend, which is
    // the safest representation for a cancelled gesture too. Reuse that path
    // so the remote browser doesn't think a touch is still pressed.
    handleTouchEnd(e);
  }

  function handleKey(e: ReactKeyboardEvent<HTMLDivElement>, action: "keydown" | "keyup") {
    // Don't preventDefault Escape — let base-ui Dialog handle it.
    if (e.key === "Escape") {
      return;
    }
    e.preventDefault();
    logDebug("surface.cdp-frame.keyboard.forward", keyboardDebugPayload(e, action));
    postInput({
      type: "keyboard",
      action,
      key: e.key,
      code: e.code,
      modifiers: (e.altKey ? 1 : 0) + (e.ctrlKey ? 2 : 0) + (e.metaKey ? 4 : 0) + (e.shiftKey ? 8 : 0),
    }).catch(() => undefined);
  }

  // Wheel and paste need non-passive listeners so we can preventDefault.
  // React's synthetic onWheel and onPaste both attach as passive in modern
  // React/Next, which silently breaks preventDefault on the operator's page.
  // We attach native listeners directly to the same DOM node the React
  // handlers are bound to (the role="application" surface).
  useEffect(() => {
    const node = containerRef.current;
    if (!node) {
      return;
    }
    function onWheel(event: WheelEvent) {
      event.preventDefault();
      const c = localCoords({ clientX: event.clientX, clientY: event.clientY });
      if (!c) {
        return;
      }
      postInput({
        type: "scroll",
        x: c.x,
        y: c.y,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
      }).catch(() => undefined);
    }
    function onPaste(event: ClipboardEvent) {
      // Always preventDefault even on empty paste so the operator's local
      // browser doesn't act on it inside our overlay.
      event.preventDefault();
      const currentClipboardPolicy = clipboardPolicyRef.current;
      if (!currentClipboardPolicy.canForwardNativePasteEvent) {
        logDebug("surface.cdp-frame.clipboard.paste", {
          phase: "skipped",
          policy: currentClipboardPolicy.directionPolicy,
          reason: "policy-denied",
          surface: currentClipboardPolicy.surface,
          target: elementDebugSnapshot(event.target),
        });
        return;
      }
      const text = event.clipboardData?.getData("text") ?? "";
      logDebug("surface.cdp-frame.clipboard.paste", {
        length: text.length,
        phase: "native-paste",
        policy: currentClipboardPolicy.directionPolicy,
        surface: currentClipboardPolicy.surface,
        target: elementDebugSnapshot(event.target),
      });
      if (text.length === 0) {
        return;
      }
      postInput({ type: "paste", text }).catch(() => undefined);
    }
    node.addEventListener("wheel", onWheel, { passive: false });
    node.addEventListener("paste", onPaste);
    return () => {
      node.removeEventListener("wheel", onWheel);
      node.removeEventListener("paste", onPaste);
    };
  }, [containerRef, localCoords, logDebug, postInput]);

  return (
    <div className="flex flex-1 items-center justify-center overflow-hidden">
      <div
        aria-label="Connector browser stream"
        className="pdpp-stream-frame relative focus-within:ring-2 focus-within:ring-primary/40 focus-within:ring-inset"
        onKeyDown={(e) => handleKey(e, "keydown")}
        onKeyUp={(e) => handleKey(e, "keyup")}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onTouchCancel={handleTouchCancel}
        onTouchEnd={handleTouchEnd}
        onTouchMove={handleTouchMove}
        onTouchStart={handleTouchStart}
        ref={surfaceRef}
        role="application"
        style={{ aspectRatio: aspect, height: "100%", width: "100%" }}
        tabIndex={0}
      >
        {imgSrc ? (
          <img
            alt={`${status.display === "live" ? "Live" : "Buffering"} connector browser frame`}
            className="h-full w-full select-none object-contain"
            draggable={false}
            ref={imgRef}
            src={imgSrc}
          />
        ) : (
          <SurfacePlaceholder display={status.display} />
        )}
        {/* Mobile soft-keyboard sentinel. Visually hidden but focusable: the
            OS won't open the soft keyboard without a focused text field, so
            we focus this input on first touch (gated to `(pointer: coarse)`).
            Keystrokes bubble up to the surface's onKeyDown/onKeyUp — no
            handlers here, no double-dispatch. Not display:none / not
            visibility:hidden — those make focus() a silent no-op on iOS. */}
        <input
          aria-hidden
          autoCapitalize="off"
          autoCorrect="off"
          inputMode="text"
          onChange={() => {
            /* controlled at "" so the soft keyboard sees a fresh empty field
               every keystroke and never accumulates a value or autofills */
          }}
          ref={softKeyboardInputRef}
          spellCheck={false}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "1px",
            height: "1px",
            opacity: 0,
            pointerEvents: "none",
            border: 0,
            padding: 0,
            margin: 0,
            background: "transparent",
            color: "transparent",
            caretColor: "transparent",
          }}
          type="text"
          value=""
        />
      </div>
    </div>
  );
}

function SurfacePlaceholder({ display }: { display: DisplayState }) {
  return (
    <div className="flex h-full w-full items-center justify-center p-8">
      {display === "trouble" ? null : <Spinner />}
    </div>
  );
}

function Spinner() {
  return (
    <span
      aria-hidden
      className="inline-block h-6 w-6 rounded-full border-2 border-foreground/15 border-t-foreground/55"
      style={{ animation: "spin 800ms linear infinite" }}
    />
  );
}

function ClipboardNoticeToast() {
  return (
    <div className="pdpp-stream-toast-zone" data-slot="clipboard" role="status">
      <div className="pdpp-stream-toast-bubble text-left" data-pdpp-stream-ui>
        <span className="font-medium text-foreground">Copy ready.</span>
      </div>
    </div>
  );
}

type ClipboardCopyState = "idle" | "copied" | "manual" | "failed";
type ClipboardPasteState = "idle" | "ready" | "sent" | "manual" | "failed";

function localClipboardStatus(pasteState: ClipboardPasteState, needsManualReadFallback: boolean): string {
  if (pasteState === "ready") {
    return "Clipboard text is ready. Tap Send to browser.";
  }
  if (pasteState === "sent") {
    return "Sent to the browser.";
  }
  if (pasteState === "manual") {
    return "Paste into the field below, then send it to the browser.";
  }
  if (pasteState === "failed") {
    return "The browser did not accept the paste. Try focusing the field again.";
  }
  if (needsManualReadFallback) {
    return "If your browser blocks clipboard access, paste into the field manually.";
  }
  return "Paste from this device or type text manually.";
}

function remoteClipboardStatus(copyState: ClipboardCopyState, remoteClipboard: RemoteClipboardBuffer | null): string {
  if (copyState === "copied") {
    return "Copied to this device.";
  }
  if (copyState === "manual") {
    return "Use the text field below and your OS copy menu.";
  }
  if (copyState === "failed") {
    return "Copy failed. Use the selectable text fallback.";
  }
  if (remoteClipboard) {
    return "Remote text is buffered only in this session.";
  }
  return "Copy text inside the browser first.";
}

async function readDeviceClipboardIntoSheet({
  logDebug,
  policy,
  setLocalText,
  setPasteState,
}: {
  logDebug: StreamDebugLogger;
  policy: ClipboardPolicyDecision;
  setLocalText: (text: string) => void;
  setPasteState: (state: ClipboardPasteState) => void;
}) {
  if (!policy.canReadLocalClipboard) {
    setPasteState("manual");
    logDebug("clipboard.local_to_remote", {
      method: "navigator.clipboard.readText",
      phase: "read-skipped",
      policy: policy.directionPolicy,
      reason: "policy-denied",
      surface: policy.surface,
    });
    return;
  }
  logDebug("clipboard.local_to_remote", {
    method: "navigator.clipboard.readText",
    phase: "read-start",
    policy: policy.directionPolicy,
    surface: policy.surface,
  });
  try {
    const text = await navigator.clipboard.readText();
    setLocalText(text);
    setPasteState(text.length > 0 ? "ready" : "manual");
    logDebug(
      "clipboard.local_to_remote",
      clipboardDebugMetadata(text, {
        method: "navigator.clipboard.readText",
        phase: "read-result",
        policy: policy.directionPolicy,
        surface: policy.surface,
      })
    );
  } catch (err) {
    setPasteState("manual");
    logDebug("clipboard.local_to_remote", {
      error: err instanceof Error ? err.message : String(err),
      method: "navigator.clipboard.readText",
      phase: "read-error",
      policy: policy.directionPolicy,
      surface: policy.surface,
    });
  }
}

function sendSheetTextToBrowser({
  localText,
  logDebug,
  policy,
  setLocalText,
  setPasteState,
}: {
  localText: string;
  logDebug: StreamDebugLogger;
  policy: ClipboardPolicyDecision;
  setLocalText: (text: string) => void;
  setPasteState: (state: ClipboardPasteState) => void;
}) {
  const localToRemoteAllowed =
    policy.directionPolicy === "local-to-remote" || policy.directionPolicy === "bidirectional-text";
  if (!localToRemoteAllowed) {
    setPasteState("failed");
    logDebug("clipboard.local_to_remote", {
      method: "control.paste",
      phase: "send-skipped",
      policy: policy.directionPolicy,
      reason: "policy-denied",
      surface: policy.surface,
    });
    return;
  }
  const pasted = pasteTextIntoNeko(localText);
  logDebug(
    "clipboard.local_to_remote",
    clipboardDebugMetadata(localText, {
      method: "control.paste",
      phase: "send-result",
      policy: policy.directionPolicy,
      sent: pasted,
      surface: policy.surface,
    })
  );
  if (pasted) {
    setLocalText("");
    setPasteState("sent");
    return;
  }
  setPasteState("failed");
}

async function copySheetTextToDevice({
  logDebug,
  policy,
  remoteClipboard,
  setCopyState,
}: {
  logDebug: StreamDebugLogger;
  policy: ClipboardPolicyDecision;
  remoteClipboard: RemoteClipboardBuffer | null;
  setCopyState: (state: ClipboardCopyState) => void;
}) {
  if (!remoteClipboard) {
    return;
  }
  if (!policy.canWriteLocalClipboard) {
    setCopyState("manual");
    logDebug("clipboard.remote_to_local", {
      method: "navigator.clipboard.writeText",
      phase: "write-skipped",
      policy: policy.directionPolicy,
      reason: "policy-denied",
      surface: policy.surface,
    });
    return;
  }
  const { text } = remoteClipboard;
  logDebug(
    "clipboard.remote_to_local",
    clipboardDebugMetadata(text, {
      method: "navigator.clipboard.writeText",
      phase: "write-start",
      policy: policy.directionPolicy,
      surface: policy.surface,
    })
  );
  try {
    await navigator.clipboard.writeText(text);
    setCopyState("copied");
    logDebug(
      "clipboard.remote_to_local",
      clipboardDebugMetadata(text, {
        method: "navigator.clipboard.writeText",
        phase: "write-ok",
        policy: policy.directionPolicy,
        surface: policy.surface,
      })
    );
  } catch (err) {
    setCopyState("manual");
    logDebug(
      "clipboard.remote_to_local",
      clipboardDebugMetadata(text, {
        error: err instanceof Error ? err.message : String(err),
        method: "navigator.clipboard.writeText",
        phase: "write-error",
        policy: policy.directionPolicy,
        surface: policy.surface,
      })
    );
  }
}

function requestBrowserCopyFromSheet({
  logDebug,
  policy,
  setCopyState,
}: {
  logDebug: StreamDebugLogger;
  policy: ClipboardPolicyDecision;
  setCopyState: (state: ClipboardCopyState) => void;
}) {
  const remoteToLocalAllowed =
    policy.directionPolicy === "remote-to-local" || policy.directionPolicy === "bidirectional-text";
  if (!remoteToLocalAllowed) {
    setCopyState("failed");
    logDebug("clipboard.remote_to_local", {
      method: "control.copy",
      phase: "browser-copy-skipped",
      policy: policy.directionPolicy,
      reason: "policy-denied",
      surface: policy.surface,
    });
    return;
  }
  const dispatched = copyRemoteSelectionFromNeko();
  logDebug("clipboard.remote_to_local", {
    method: "control.copy",
    phase: "browser-copy-requested",
    policy: policy.directionPolicy,
    sent: dispatched,
    surface: policy.surface,
  });
  if (!dispatched) {
    setCopyState("failed");
  }
}

function ClipboardSheet({
  capabilities,
  connectorName,
  logDebug,
  onClearRemoteClipboard,
  onOpenChange,
  open,
  policy,
  remoteClipboard,
  remoteInputSensitive,
}: {
  capabilities: ClipboardCapabilities;
  connectorName: string;
  logDebug: StreamDebugLogger;
  onClearRemoteClipboard: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  policy: ClipboardPolicyDecision;
  remoteClipboard: RemoteClipboardBuffer | null;
  remoteInputSensitive: boolean;
}) {
  const [copyState, setCopyState] = useState<ClipboardCopyState>("idle");
  const [localText, setLocalText] = useState("");
  const [pasteState, setPasteState] = useState<ClipboardPasteState>("idle");
  const [revealLocalText, setRevealLocalText] = useState(false);
  const localInputMasked = remoteInputSensitive && !revealLocalText;
  const canPasteLocalToRemote =
    policy.directionPolicy === "local-to-remote" || policy.directionPolicy === "bidirectional-text";
  const canSendLocalText = localText.length > 0 && canPasteLocalToRemote;
  const canRequestRemoteCopy =
    policy.directionPolicy === "remote-to-local" || policy.directionPolicy === "bidirectional-text";

  useEffect(() => {
    if (!open) {
      setCopyState("idle");
      setPasteState("idle");
      setRevealLocalText(false);
    }
  }, [open]);

  const pasteFromDevice = () => readDeviceClipboardIntoSheet({ logDebug, policy, setLocalText, setPasteState });
  const sendToBrowser = () => sendSheetTextToBrowser({ localText, logDebug, policy, setLocalText, setPasteState });
  const copyToDevice = () => copySheetTextToDevice({ logDebug, policy, remoteClipboard, setCopyState });
  const requestBrowserCopy = () => requestBrowserCopyFromSheet({ logDebug, policy, setCopyState });

  const localStatus = localClipboardStatus(pasteState, capabilities.needsManualReadFallback);
  const copyStatus = remoteClipboardStatus(copyState, remoteClipboard);

  return (
    <Dialog modal onOpenChange={onOpenChange} open={open}>
      <DialogPortal>
        <DialogBackdrop className="bg-black/30" data-pdpp-stream-ui />
        <DialogPopup
          aria-label={`${connectorName} browser clipboard`}
          className="pdpp-stream-clipboard-sheet fixed inset-x-3 top-auto bottom-3 m-0 flex max-h-[min(82vh,42rem)] max-w-none translate-x-0 translate-y-0 flex-col gap-4 overflow-hidden rounded-2xl border border-border/80 bg-background p-0 shadow-2xl data-[ending-style]:translate-y-full data-[starting-style]:translate-y-full data-[ending-style]:scale-100 data-[starting-style]:scale-100 sm:right-5 sm:left-auto sm:w-[28rem]"
          data-pdpp-stream-ui
        >
          <div className="flex items-start justify-between gap-3 border-border/70 border-b px-4 py-3">
            <div>
              <DialogTitle className="text-base">Clipboard</DialogTitle>
              <DialogDescription className="mt-1 text-sm">
                Move text between this device and the streamed browser with an explicit tap.
              </DialogDescription>
            </div>
            <Button
              aria-label="Close clipboard"
              onClick={() => onOpenChange(false)}
              size="icon-xs"
              type="button"
              variant="ghost"
            >
              ×
            </Button>
          </div>
          <div className="flex flex-1 flex-col gap-5 overflow-y-auto overscroll-contain px-4 pb-4">
            <section className="grid gap-3">
              <div className="space-y-1">
                <h3 className="pdpp-eyebrow">This device to browser</h3>
                <p className="pdpp-caption text-muted-foreground">{localStatus}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={!(canPasteLocalToRemote && policy.canReadLocalClipboard)}
                  onClick={pasteFromDevice}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Paste from device
                </Button>
                <Button disabled={!canSendLocalText} onClick={sendToBrowser} size="sm" type="button">
                  Send to browser
                </Button>
                {remoteInputSensitive ? (
                  <Button onClick={() => setRevealLocalText((shown) => !shown)} size="sm" type="button" variant="ghost">
                    {revealLocalText ? "Hide text" : "Show text"}
                  </Button>
                ) : null}
              </div>
              <textarea
                aria-label={`Text to paste into ${connectorName} browser`}
                autoCapitalize="off"
                autoCorrect="off"
                className="pdpp-stream-clipboard-textarea min-h-24 resize-y rounded-lg border border-border/80 bg-muted/30 p-3 text-foreground text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                data-masked={localInputMasked ? "true" : "false"}
                onChange={(event) => {
                  setLocalText(event.target.value);
                  setPasteState(event.target.value.length > 0 ? "ready" : "idle");
                }}
                onPaste={(event) => {
                  const text = event.clipboardData.getData("text");
                  logDebug(
                    "clipboard.local_to_remote",
                    clipboardDebugMetadata(text, {
                      method: "textarea.paste",
                      phase: "native-paste",
                      policy: policy.directionPolicy,
                      surface: policy.surface,
                    })
                  );
                }}
                placeholder={remoteInputSensitive ? "Paste sensitive text here" : "Paste or type text here"}
                spellCheck={false}
                value={localText}
              />
            </section>
            <section className="grid gap-3 border-border/70 border-t pt-4">
              <div className="space-y-1">
                <h3 className="pdpp-eyebrow">Browser to this device</h3>
                <p className="pdpp-caption text-muted-foreground">{copyStatus}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={!canRequestRemoteCopy}
                  onClick={requestBrowserCopy}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Copy browser selection
                </Button>
                <Button
                  disabled={!(remoteClipboard && policy.canWriteLocalClipboard)}
                  onClick={copyToDevice}
                  size="sm"
                  type="button"
                >
                  Copy to device
                </Button>
                <Button
                  disabled={!remoteClipboard}
                  onClick={onClearRemoteClipboard}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Clear
                </Button>
              </div>
              <textarea
                aria-label="Text copied from browser"
                className="min-h-20 resize-y rounded-lg border border-border/80 bg-muted/30 p-3 text-foreground text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                readOnly
                value={remoteClipboard?.text ?? ""}
              />
            </section>
          </div>
        </DialogPopup>
      </DialogPortal>
    </Dialog>
  );
}

// ─── Corner controls + status dot ─────────────────────────────────────────────

function CornerControls({
  connectorName,
  location,
  onClipboard,
  onCopy,
  onClose,
  onKeyboard,
  onPaste,
  status,
}: {
  connectorName: string;
  location: LocationInfo | null;
  onClipboard?: () => void;
  onCopy?: () => void;
  onClose: () => void;
  onKeyboard?: () => void;
  onPaste?: () => void;
  status: ConnectionStatus;
}) {
  return (
    <div className="pdpp-stream-corner-controls">
      {location ? <LocationLabel location={location} /> : null}
      <div className="pdpp-stream-control-row">
        <StatusDot status={status} />
        {onClipboard ? (
          <button
            aria-label={`Open clipboard for ${connectorName} browser`}
            className="pdpp-stream-control-button"
            data-pdpp-stream-ui
            onClick={onClipboard}
            type="button"
          >
            <svg
              aria-hidden
              fill="none"
              height="16"
              stroke="currentColor"
              strokeLinecap="round"
              strokeWidth="1.75"
              viewBox="0 0 16 16"
              width="16"
            >
              <title>Clipboard</title>
              <path d="M5.25 4.5h5.5a1.5 1.5 0 0 1 1.5 1.5v6.25a1.5 1.5 0 0 1-1.5 1.5h-5.5a1.5 1.5 0 0 1-1.5-1.5V6a1.5 1.5 0 0 1 1.5-1.5Z" />
              <path d="M6 2.5h4M6.25 7.25h3.5M6.25 9.75h2.25" />
            </svg>
          </button>
        ) : null}
        {onCopy ? (
          <button
            aria-label={`Copy selected text from ${connectorName} browser`}
            className="pdpp-stream-control-button"
            data-pdpp-stream-ui
            onClick={onCopy}
            type="button"
          >
            <svg
              aria-hidden
              fill="none"
              height="16"
              stroke="currentColor"
              strokeLinecap="round"
              strokeWidth="1.75"
              viewBox="0 0 16 16"
              width="16"
            >
              <title>Copy</title>
              <path d="M5.25 5.25h6a1.25 1.25 0 0 1 1.25 1.25v5.75a1.25 1.25 0 0 1-1.25 1.25h-6A1.25 1.25 0 0 1 4 12.25V6.5a1.25 1.25 0 0 1 1.25-1.25Z" />
              <path d="M2.5 10.5V3.75A1.25 1.25 0 0 1 3.75 2.5h6.75" />
            </svg>
          </button>
        ) : null}
        {onPaste ? (
          <button
            aria-label={`Paste from this device into ${connectorName} browser`}
            className="pdpp-stream-control-button"
            data-pdpp-stream-ui
            onClick={onPaste}
            type="button"
          >
            <svg
              aria-hidden
              fill="none"
              height="16"
              stroke="currentColor"
              strokeLinecap="round"
              strokeWidth="1.75"
              viewBox="0 0 16 16"
              width="16"
            >
              <title>Paste</title>
              <path d="M6 2.5h4M5.25 4.5h5.5a1.5 1.5 0 0 1 1.5 1.5v6.25a1.5 1.5 0 0 1-1.5 1.5h-5.5a1.5 1.5 0 0 1-1.5-1.5V6a1.5 1.5 0 0 1 1.5-1.5Z" />
              <path d="M6.25 7.25h3.5M6.25 9.75h2.25" />
            </svg>
          </button>
        ) : null}
        {onKeyboard ? (
          <button
            aria-label={`Show keyboard for ${connectorName} browser`}
            className="pdpp-stream-control-button"
            data-pdpp-stream-ui
            onClick={onKeyboard}
            type="button"
          >
            <svg
              aria-hidden
              fill="none"
              height="16"
              stroke="currentColor"
              strokeLinecap="round"
              strokeWidth="1.75"
              viewBox="0 0 16 16"
              width="16"
            >
              <title>Keyboard</title>
              <rect height="9.5" rx="1.6" width="13" x="1.5" y="3.25" />
              <path d="M4 6h.01M6.65 6h.01M9.35 6h.01M12 6h.01M4 8.8h.01M6.65 8.8h2.7M12 8.8h.01" />
            </svg>
          </button>
        ) : null}
        <button
          aria-label={`Close ${connectorName} browser`}
          className="pdpp-stream-control-button"
          onClick={onClose}
          type="button"
        >
          <svg
            aria-hidden
            fill="none"
            height="16"
            stroke="currentColor"
            strokeLinecap="round"
            strokeWidth="1.75"
            viewBox="0 0 16 16"
            width="16"
          >
            <title>Close</title>
            <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
          </svg>
        </button>
      </div>
    </div>
  );
}

/**
 * Shows the streamed page's hostname (bold) + path (muted) so the operator
 * knows *where* the connector currently is — important for safety ("am I
 * actually on accounts.google.com?") and for sense-making between frames.
 *
 * Truncates aggressively so a long path can't push the close button off
 * screen on a phone. Title rides as a tooltip for desktop hover.
 */
function LocationLabel({ location }: { location: LocationInfo }) {
  return (
    <div
      // `aria-live="polite"` so screen readers hear the new location without
      // interrupting in-progress speech (the hostname is contextual, not
      // urgent). The wrapper divides label tone (host vs path) visually.
      aria-live="polite"
      className="pdpp-stream-location-label"
      title={location.title ?? `${location.hostname}${location.pathname}`}
    >
      <span className="pdpp-caption truncate font-medium text-foreground">{location.hostname}</span>
      {location.pathname ? (
        <span className="pdpp-caption truncate text-muted-foreground">{location.pathname}</span>
      ) : null}
    </div>
  );
}

function statusTone(state: DisplayState): string {
  if (state === "live") {
    return "bg-[color:var(--success)]";
  }
  if (state === "trouble") {
    return "bg-destructive";
  }
  return "bg-[color:var(--warning)]";
}

function statusLabel(state: DisplayState): string {
  if (state === "live") {
    return "Stream is live";
  }
  if (state === "trouble") {
    return "Stream has trouble";
  }
  return "Stream is connecting";
}

function StatusDot({ status }: { status: ConnectionStatus }) {
  const tone = statusTone(status.display);
  const label = statusLabel(status.display);
  return (
    <span className="pointer-events-none inline-flex h-10 items-center justify-center px-1">
      <span aria-hidden className={`inline-block h-2 w-2 rounded-full ring-2 ring-background/85 ${tone}`} />
      <span className="sr-only" role="status">
        {label}
      </span>
    </span>
  );
}

// ─── Trouble toast (only shown when display === "trouble") ────────────────────

function TroubleToast({ message }: { message: string | null }) {
  if (!message) {
    return null;
  }
  return (
    <div aria-live="polite" className="pdpp-stream-toast-zone">
      <p className="pdpp-caption pdpp-stream-toast-bubble">{message}</p>
    </div>
  );
}

// ─── Popup toast (informational; informs the operator a new tab opened) ───────

/**
 * Surfaces popup-tab events from `popup_opened`. We don't attach to the popup
 * (different page = different wsUrl), so this is honest "we know it happened
 * but can't show it" copy — not a failure tone.
 *
 * Visually mirrors `TroubleToast` so corner geometry is consistent, but
 * stacked one row up so a popup notice + a connection trouble can coexist
 * without overlapping. `aria-live="polite"` because operators are looking
 * at the stream — interrupting their context with `assertive` would be
 * heavier than this informational signal warrants.
 */
function PopupToast({ message }: { message: string }) {
  return (
    <div aria-live="polite" className="pdpp-stream-toast-zone" data-slot="popup">
      <p className="pdpp-caption pdpp-stream-toast-bubble">{message}</p>
    </div>
  );
}

// ─── Resolved (success) surface ───────────────────────────────────────────────

/**
 * Shown when the run timeline reports the pending interaction has been
 * satisfied. Quiet, declarative, ephemeral. Attempts `window.close()` for
 * popup-opened tabs; the explicit button covers the rest.
 */
export function ResolvedSurface({ connector }: { connector: ConnectorContext | null }) {
  const subject = connector?.displayName ?? "The connector";

  useEffect(() => {
    const id = window.setTimeout(() => {
      if (typeof window === "undefined") {
        return;
      }
      try {
        if (window.opener || window.history.length <= 1) {
          window.close();
        }
      } catch {
        /* close blocked; the explicit button stays available */
      }
    }, 6000);
    return () => window.clearTimeout(id);
  }, []);

  return (
    <main className="relative min-h-dvh">
      <WordmarkCorner />
      <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-stretch justify-center px-5 py-16">
        <section
          aria-labelledby="stream-resolved-title"
          className="flex flex-col gap-5 rounded-lg px-5 py-6 sm:px-6 sm:py-7"
          data-surface="human"
        >
          <p className="pdpp-body-lg text-foreground" id="stream-resolved-title">
            {subject} is back on it.
          </p>
          <p className="pdpp-body text-foreground">You can close this tab.</p>
          <Button
            className="h-12 w-full"
            onClick={() => {
              try {
                window.close();
              } catch {
                /* the tab may not be closeable */
              }
            }}
            size="lg"
            type="button"
          >
            Close this tab
          </Button>
        </section>
      </div>
    </main>
  );
}

// ─── Unsupported interaction kind (credentials / OTP) ────────────────────────

/**
 * Edge case: the operator landed on a step whose kind isn't satisfied by the
 * streaming companion (credential entry, OTP, etc.). The brief is firm about
 * not adding navigation chrome, but a stuck operator with no path forward is
 * worse — keep one explicit escape to the run timeline.
 */
function UnsupportedSurface({
  connector,
  interactionMessage,
  runHref,
}: {
  connector: ConnectorContext | null;
  interactionMessage: string;
  runHref: string;
}) {
  return (
    <main className="relative min-h-dvh">
      <WordmarkCorner />
      <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-stretch justify-center px-5 py-16">
        <section
          aria-labelledby="stream-unsupported-title"
          className="flex flex-col gap-5 rounded-lg px-5 py-6 sm:px-6 sm:py-7"
          data-surface="human"
        >
          {connector ? <p className="pdpp-eyebrow text-foreground">{connector.displayName}</p> : null}
          <p className="pdpp-body-lg text-foreground" id="stream-unsupported-title">
            {interactionMessage}
          </p>
          <p className="pdpp-body text-foreground">This step takes a credential, not a browser.</p>
          <Link className="block w-full" href={runHref}>
            <Button className="h-12 w-full" size="lg" type="button">
              Open run timeline
            </Button>
          </Link>
        </section>
      </div>
    </main>
  );
}
