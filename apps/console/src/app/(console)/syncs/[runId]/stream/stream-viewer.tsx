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

import {
  assessNekoMediaSettle,
  createNekoMediaSettleState,
  type NekoMediaSettleSample,
} from "@opendatalabs/remote-surface/backends/neko";
import {
  assessClipboardCapabilities,
  assessMobileKeyboardViewportResize,
  buildViewportPayload,
  CdpSurfaceAdapter,
  type ClipboardCapabilities,
  type ClipboardDirectionPolicy,
  type ClipboardHelperMode,
  type ClipboardPolicyDecision,
  classifyClipboardBrowser,
  clipboardLengthBucket,
  createMobileKeyboardResizeState,
  createStreamViewerControlState,
  decideClipboardPolicy,
  type LocalViewportSample,
  localSurfaceCanDisplayPresentation,
  type NekoMediaSettleTarget,
  NekoSurfaceAdapter,
  nekoMediaSettleTarget,
  nekoMediaSettleTargetsMatch,
  nextPresentationKeyboardHoldUntilMs,
  nextPresentationOrientationHoldUntilMs,
  pointToStreamViewport,
  reduceStreamViewerControl,
  type StreamViewerCommand,
  type StreamViewportInfo,
  shouldDebouncePresentationViewportUpdate,
  shouldHoldPresentationViewportForKeyboard,
  stablePresentationContainerRect,
  streamViewportInfosMatch,
  toNekoNativeViewportInfo,
  type ViewportObservation,
  type ViewportPayload,
  viewportCaptureSize,
  viewportInfoFromPayload,
  viewportPayloadsAreEquivalent,
} from "@opendatalabs/remote-surface/client";
import {
  classifyVisualQualityIssues,
  computePixelFitTelemetry,
  computeStreamCaptureTargetForContext,
} from "@opendatalabs/remote-surface/diagnostics";
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
} from "@opendatalabs/remote-surface/protocol";
import {
  buttonVariants,
  IcButton,
  IcDialog,
  IcDialogBackdrop,
  IcDialogDescription,
  IcDialogPopup,
  IcDialogPortal,
  IcDialogTitle,
  IcInput,
} from "@pdpp/brand-react";
import { dashboardRoutes } from "@pdpp/operator-ui/components/views/routes";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, type RefObject, useCallback, useEffect, useRef, useState, useTransition } from "react";
import { PdppLogo } from "@/components/pdpp-logo.tsx";
import { submitRunInteractionAction } from "../actions.ts";
import { type MintedStreamSession, mintStreamSessionAction, reportStreamReachFailureAction } from "./actions.ts";
import {
  NEKO_MEDIA_LAYOUT_EVENT,
  type NekoClientConfig,
  readNekoMediaSettleSample,
  setNekoPresentationViewportLayout,
  setNekoRemoteCopyFallback,
  setNekoViewportLayout,
} from "./neko-client.ts";
import { createNekoClientApi } from "./neko-client-api-shim.ts";
import { fetchNekoClientConfigResponse } from "./neko-client-config.ts";
import {
  claimPlaygroundEvent,
  createPlaygroundSeenRegistry,
  type PlaygroundSeenRegistry,
} from "./playground-event-dedupe.ts";
import { classifyStreamReachFailure, type StreamReachProbeResult } from "./stream-reach-diagnostics.ts";
import { sampleVideoSharpnessTelemetry } from "./stream-visual-quality.ts";
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
  interactionRequiresResponse?: boolean;
  pollForResolution?: boolean;
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
  playgroundEvents: Record<string, unknown>[] | null;
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

async function readStreamReachProbeCode(probe: Response): Promise<string | null> {
  try {
    const body = (await probe.json()) as { error?: { code?: unknown } };
    const code = body?.error?.code;
    return typeof code === "string" ? code : null;
  } catch {
    return null;
  }
}

async function probeStreamReach(url: string | null): Promise<StreamReachProbeResult> {
  if (!url) {
    return { probeError: true, probeStatus: null };
  }
  const abort = new AbortController();
  try {
    const probe = await fetch(url, {
      cache: "no-store",
      method: "GET",
      signal: abort.signal,
    });
    return {
      probeCode: probe.ok ? null : await readStreamReachProbeCode(probe),
      probeError: false,
      probeStatus: probe.status,
    };
  } catch {
    return { probeError: true, probeStatus: null };
  } finally {
    abort.abort();
  }
}

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

const SUPPORTED_KINDS = new Set(["manual_action", "otp"]);
const INITIAL_INTERACTION_ACTION_STATE = { error: null, status: null } as const;

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
  nekoMediaSettleMaxPolls: 40,
  nekoMediaSettlePollMs: 250,
  nekoStatusPollAttempts: 20,
  nekoStatusPollMs: 50,
  // Post-settle debug drain cadence. Keep it slower than the 50ms
  // layout poll so telemetry does not perturb the stream UX.
  nekoDebugDrainPollMs: 250,
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

type StreamDebugPayload = Record<string, unknown>;
type StreamDebugLogger = (type: string, payload?: StreamDebugPayload) => void;
type KeyboardFocusPayload = Extract<ReturnType<typeof parseKeyboardFocusMessage>, { ok: true }>["value"];

interface RemoteKeyboardFocusContext {
  keyboardBlurTimeoutRef: { current: ReturnType<typeof setTimeout> | null };
  logDebug: StreamDebugLogger;
  presentationKeyboardFocusedRef: { current: boolean };
  presentationKeyboardHoldUntilRef: { current: number };
  setRemoteInputSensitive: (sensitive: boolean) => void;
  surfaceAdapterRef: { current: NekoSurfaceAdapter | null };
}

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

function applyRemoteKeyboardFocus(payload: KeyboardFocusPayload, context: RemoteKeyboardFocusContext): void {
  if (payload.focused) {
    markRemoteKeyboardFocused(payload, context);
    return;
  }
  scheduleRemoteKeyboardBlur(context);
}

function markRemoteKeyboardFocused(
  payload: KeyboardFocusPayload,
  {
    keyboardBlurTimeoutRef,
    logDebug,
    presentationKeyboardFocusedRef,
    presentationKeyboardHoldUntilRef,
    setRemoteInputSensitive,
    surfaceAdapterRef,
  }: RemoteKeyboardFocusContext
): void {
  presentationKeyboardFocusedRef.current = true;
  presentationKeyboardHoldUntilRef.current = nextPresentationKeyboardHoldUntilMs({
    currentHoldUntilMs: presentationKeyboardHoldUntilRef.current,
    holdMs: STREAM_VIEWER_POLICY.presentationKeyboardOpenHoldMs,
    isKeyboardActive: true,
    nowMs: Date.now(),
  });
  const inputType = payload.element?.inputType?.toLowerCase() ?? "";
  setRemoteInputSensitive(inputType === "password");
  if (keyboardBlurTimeoutRef.current) {
    clearTimeout(keyboardBlurTimeoutRef.current);
    keyboardBlurTimeoutRef.current = null;
  }
  updateAdapterRemoteInputFocus(surfaceAdapterRef.current, true, logDebug);
}

function scheduleRemoteKeyboardBlur({
  keyboardBlurTimeoutRef,
  logDebug,
  presentationKeyboardFocusedRef,
  presentationKeyboardHoldUntilRef,
  setRemoteInputSensitive,
  surfaceAdapterRef,
}: RemoteKeyboardFocusContext): void {
  if (keyboardBlurTimeoutRef.current) {
    clearTimeout(keyboardBlurTimeoutRef.current);
  }
  keyboardBlurTimeoutRef.current = setTimeout(() => {
    keyboardBlurTimeoutRef.current = null;
    updateAdapterRemoteInputFocus(surfaceAdapterRef.current, false, logDebug);
    setRemoteInputSensitive(false);
  }, STREAM_VIEWER_POLICY.keyboardRemoteBlurGraceMs);
  presentationKeyboardFocusedRef.current = false;
  presentationKeyboardHoldUntilRef.current = Math.max(
    presentationKeyboardHoldUntilRef.current,
    Date.now() + STREAM_VIEWER_POLICY.presentationKeyboardCloseHoldMs
  );
}

function updateAdapterRemoteInputFocus(
  adapter: NekoSurfaceAdapter | null,
  focused: boolean,
  logDebug: StreamDebugLogger
): void {
  if (adapter?.getLifecycleState() !== "mounted") {
    logDebug("neko.keyboard_focus.adapter_unavailable", {
      focused,
      state: adapter?.getLifecycleState() ?? null,
    });
    return;
  }
  adapter.setRemoteInputFocused(focused);
  if (focused) {
    adapter.focusTextInput();
    return;
  }
  adapter.blurTextInput();
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
interface ReadViewerViewportOptions {
  deviceScaleFactor?: number;
  highDprCapture?: boolean;
}

const NEKO_NATIVE_VIEWPORT_OPTIONS: ReadViewerViewportOptions = {
  deviceScaleFactor: 1,
  highDprCapture: false,
};

function readViewerViewport(width: number, height: number, options: ReadViewerViewportOptions = {}) {
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
  const deviceScaleFactor = options.deviceScaleFactor ?? window.devicePixelRatio ?? 1;
  const mobile = coarsePointer || MOBILE_USER_AGENT_RE.test(window.navigator.userAgent);
  const captureTarget = computeStreamCaptureTargetForContext({
    devicePixelRatio: deviceScaleFactor,
    highDprCapture: options.highDprCapture ?? mobile,
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

function useStableNekoNativeViewportInfo(
  enabled: boolean,
  viewport: StreamViewportInfo | null
): StreamViewportInfo | null {
  const stableViewportRef = useRef<StreamViewportInfo | null>(null);
  const nextViewport = enabled ? toNekoNativeViewportInfo(viewport) : viewport;

  if (!streamViewportInfosMatch(stableViewportRef.current, nextViewport)) {
    stableViewportRef.current = nextViewport;
  }

  return stableViewportRef.current;
}

function positiveViewportSize(size: { height?: number; width?: number } | null | undefined): boolean {
  return !!size && Number(size.width) > 0 && Number(size.height) > 0;
}

function nekoMediaSettleSampleHasDisplayableFrame(sample: NekoMediaSettleSample): boolean {
  if (!(positiveViewportSize(sample.media) && positiveViewportSize(sample.screen))) {
    return false;
  }
  const inbound = sample.inbound;
  const inboundHasFrame =
    !inbound ||
    (Number(inbound.frameWidth) > 0 && Number(inbound.frameHeight) > 0) ||
    Number(inbound.framesPerSecond) > 0 ||
    Number(inbound.framesDecoded) > 0;
  return inboundHasFrame;
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

function keyboardDebugPayload(event: KeyboardEvent, action: string): StreamDebugPayload {
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
        const issues = occluded ? [] : classifyVisualQualityIssues(media);
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
  interactionRequiresResponse = true,
  pollForResolution = true,
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
    if (!pollForResolution) {
      return;
    }
    const id = setInterval(() => router.refresh(), RESOLUTION_POLL_MS);
    return () => clearInterval(id);
  }, [pollForResolution, router]);

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

  // Operator might land on an unsupported interaction kind (credentials).
  // Browser-backed OTP flows are streamable; credentials-only prompts are not.
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
        interactionKind={interactionKind}
        interactionMessage={interactionMessage}
        interactionRequiresResponse={interactionRequiresResponse}
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
      <IcButton
        aria-busy={isMinting || undefined}
        aria-describedby={troubleMessage ? "stream-trouble-note" : undefined}
        className="h-12 w-full"
        disabled={isMinting}
        onClick={onAction}
        size="lg"
        type="button"
      >
        {label}
      </IcButton>
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
  interactionKind: string;
  interactionMessage: string;
  interactionRequiresResponse: boolean;
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
  interactionKind,
  interactionMessage,
  interactionRequiresResponse,
  onClose,
  onStatus,
  open,
  runId,
  status,
}: StreamOverlayProps) {
  return (
    <IcDialog
      // `dismissible={false}` would block Esc too. We want Esc to close
      // (a11y + desktop convention), but we don't want backdrop-click to
      // close (operators might miss-click while interacting with the
      // streamed page). We achieve that by stopping pointer events on the
      // backdrop while still allowing the explicit close button + Esc.
      modal
      onOpenChange={(next: boolean) => {
        if (!next) {
          onClose();
        }
      }}
      open={open}
    >
      <IcDialogPortal>
        {/* On phone the popup is the viewport — backdrop is invisible.
            On desktop we let the backdrop dim around the popup, which has
            margins. The backdrop renders regardless so base-ui's pointer
            and scroll-lock machinery behave. */}
        <IcDialogBackdrop className="pdpp-stream-dialog-backdrop" />
        <IcDialogPopup aria-label={`${connectorName} live browser`} className="pdpp-stream-dialog">
          {open && initialSession ? (
            <StreamStage
              connectorName={connectorName}
              initialSession={initialSession}
              interactionId={interactionId}
              interactionKind={interactionKind}
              interactionMessage={interactionMessage}
              interactionRequiresResponse={interactionRequiresResponse}
              onClose={onClose}
              onStatus={onStatus}
              runId={runId}
              status={status}
            />
          ) : null}
        </IcDialogPopup>
      </IcDialogPortal>
    </IcDialog>
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
  interactionKind: string;
  interactionMessage: string;
  interactionRequiresResponse: boolean;
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
  interactionKind,
  interactionMessage,
  interactionRequiresResponse,
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
  // Armed when the corner X is pressed while a manual/browser interaction is
  // pending; renders the inline close-confirmation bubble instead of ending
  // the session outright. See `handleCloseRequest`.
  const [closeConfirmArmed, setCloseConfirmArmed] = useState(false);
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
    // Step-5 ruling 1: scope the corner keyboard button to n.eko
    // (remote-surface) sessions; cdp and other backends keep it hidden.
    sessionBackend: nekoSession ? "neko" : "unknown",
  });
  const clipboardCapabilitiesRef = useRef(clipboardCapabilities);
  const clipboardPolicyRef = useRef(clipboardPolicy);
  const pendingResizeSourcesRef = useRef<Set<string>>(new Set());
  const pendingPresentationSourcesRef = useRef<Set<string>>(new Set());
  // Step 5b: hoist adapter ref so corner-keyboard handler can call
  // adapter.focusTextInput(), which binds MobileTextInputController.
  const nekoSurfaceAdapterRef = useRef<NekoSurfaceAdapter | null>(null);
  const presentationKeyboardFocusedRef = useRef(false);
  const presentationKeyboardHoldUntilRef = useRef(0);
  const presentationOrientationHoldUntilRef = useRef(0);
  const presentationViewportTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const trailingViewportReconcileRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const controlViewportReconcileTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const requestViewportMeasureRef = useRef<((source: string) => void) | null>(null);
  const nekoNativeViewportRef = useRef(false);
  const setStreamSurfaceNode = useCallback((node: HTMLDivElement | null) => {
    containerRef.current = node;
    setContainerNode(node);
  }, []);

  const readStageViewport = useCallback(
    (width: number, height: number) =>
      readViewerViewport(width, height, nekoNativeViewportRef.current ? NEKO_NATIVE_VIEWPORT_OPTIONS : {}),
    []
  );

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

  const setCanonicalViewportInfo = useCallback((nextViewport: StreamViewportInfo) => {
    viewportInfoRef.current = nextViewport;
    setViewportInfo(nextViewport);
  }, []);

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
          setCanonicalViewportInfo(payload.viewport);
          localSurfaceViewportInfoRef.current = payload.viewport;
          setLocalSurfaceViewportInfo(payload.viewport);
          lastPostedViewportRef.current = readViewerViewport(payload.viewport.width, payload.viewport.height) ?? null;
        }
        logDebug("stream_session_attached", {
          hasViewport: Boolean(payload.viewport),
          viewport: payload.viewport ?? null,
        });
        callbacks.onAttached();
      });
      source.addEventListener("backend_ready", (ev) => {
        const parsed = parseBackendReadyMessage(streamEventData(ev));
        if (!parsed.ok) {
          return;
        }
        const payload = parsed.value;
        onStatus(LIVE);
        logDebug("overlay_cleared", {
          backend: payload.backend,
          phase: "backend_ready",
        });
        if (payload.backend === "neko" && typeof payload.iframe_path === "string" && payload.iframe_path.length > 0) {
          const entryPath = payload.iframe_path.replace(TRAILING_SLASH_RE, "");
          nekoNativeViewportRef.current = true;
          const nativeViewportInfo = toNekoNativeViewportInfo(viewportInfoRef.current);
          if (nativeViewportInfo) {
            setCanonicalViewportInfo(nativeViewportInfo);
            logDebug("neko.viewport.native_canonical", {
              reason: "backend-ready",
              viewport: nativeViewportInfo,
            });
          }
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
          requestViewportMeasureRef.current?.("neko-backend-ready");
          return;
        }
        nekoNativeViewportRef.current = false;
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
        logDebug("overlay_cleared", {
          backend: "cdp-frame",
          phase: "frame",
        });
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
        applyRemoteKeyboardFocus(parsed.value, {
          keyboardBlurTimeoutRef,
          logDebug,
          presentationKeyboardFocusedRef,
          presentationKeyboardHoldUntilRef,
          setRemoteInputSensitive,
          surfaceAdapterRef: nekoSurfaceAdapterRef,
        });
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
    [connectorName, logDebug, onStatus, setCanonicalViewportInfo]
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
    logDebug("stream_session_loaded", {
      reason: "initial",
      hasInputUrl: Boolean(initial.input_url),
      hasViewportUrl: Boolean(initial.viewport_url),
      hasViewerUrl: Boolean(initial.viewer_url),
    });

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
      logDebug("stream_session_mint_start", {
        reason: "reattach",
        viewport,
      });
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
      logDebug("stream_session_minted", {
        reason: "reattach",
        hasInputUrl: Boolean(minted.input_url),
        hasViewportUrl: Boolean(minted.viewport_url),
        hasViewerUrl: Boolean(minted.viewer_url),
      });
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
     * On give-up, recover the attach HTTP status the `EventSource` hid by
     * issuing one ordinary `GET` against the same token-scoped viewer URL. The
     * non-2xx attach checks return a normal JSON error response *before* the SSE
     * hijack, so a plain fetch reads the real status and the `error.code` body.
     * Re-attach is idempotent server-side (the token is reconnect-safe, not
     * consumed-on-first-GET), so this probe does not break a still-valid
     * session; we abort the body immediately after reading the head so we never
     * hold an SSE stream open.
     *
     * Then classify, refine the operator message, and fire a best-effort
     * `run.stream_reach_failed` beacon. A beacon or probe failure never changes
     * the already-shown give-up message beyond the local classification — this
     * diagnostic explains the failure class, it never claims recovery.
     */
    async function diagnoseGiveUp(url: string | null): Promise<void> {
      const probe = await probeStreamReach(url);
      if (cancelled || !mountedRef.current) {
        return;
      }
      const { reason, troubleMessage } = classifyStreamReachFailure(probe);
      logDebug("stream_reach_failed", { reason, httpStatus: probe.probeStatus });
      onStatus({ display: "trouble", cause: "network", troubleMessage });
      try {
        await reportStreamReachFailureAction({ httpStatus: probe.probeStatus, interactionId, reason, runId });
      } catch {
        // Best-effort beacon: the operator message is already set from the local
        // classification, so a failed report must not change the UI.
      }
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
        logDebug("stream_startup_stuck_timeout", {
          maxAttempts: MAX_RECONNECT_ATTEMPTS,
          phase: "pre-attach",
          preAttachFailures,
          totalAttempts,
        });
        // Generic give-up first so the operator is never left on a stale
        // "Connecting…" state while the diagnostic probe runs. The probe then
        // refines this to a reason-specific message. `EventSource` hid the
        // attach HTTP status; this one extra GET recovers it.
        onStatus({
          display: "trouble",
          cause: "network",
          troubleMessage: "Couldn't reach the browser stream after several tries.",
        });
        diagnoseGiveUp(viewerUrl).catch(() => {
          // Best-effort diagnostic: the generic give-up message is already shown.
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
      logDebug("stream_attach_start", {
        attempt: totalAttempts + 1,
        hasViewerUrl: Boolean(viewerUrl),
        phase: attached ? "reattach-after-attached" : "initial",
      });
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
  }, [attachStreamHandlers, interactionId, onStatus, runId, logDebug]);

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
      const viewport = readStageViewport(width, height);
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
      setCanonicalViewportInfo(viewportInfo);
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
    [logDebug, readStageViewport, scheduleViewportHoldFollowUp, setCanonicalViewportInfo]
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
      const viewport = readStageViewport(rect.width, rect.height);
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
    [logDebug, readStageViewport]
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
      const viewport = readStageViewport(rect.width, rect.height);
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
    [
      logDebug,
      readStageViewport,
      reducePresentationViewportControl,
      restoreStablePresentationViewport,
      scheduleViewportHoldFollowUp,
    ]
  );

  const handleNekoPresentationViewportReady = useCallback(
    (readyViewport: StreamViewportInfo, result: { reasons?: string[]; status: "degraded" | "settled" }) => {
      const currentViewport = nekoNativeViewportRef.current
        ? toNekoNativeViewportInfo(viewportInfoRef.current)
        : viewportInfoRef.current;
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
      surface: nekoSurfaceAdapterRef.current,
    }).catch((err) => {
      logDebug("neko.corner.copy", {
        error: err instanceof Error ? err.message : String(err),
        phase: "browser-copy-error",
        surface: clipboardPolicy.surface,
      });
      setClipboardSheetOpen(true);
    });
  }, [clipboardPolicy, logDebug, remoteClipboard]);

  const handleMobilePaste = useCallback(() => {
    logDebug("neko.corner.paste", { phase: "open-sheet", surface: clipboardPolicy.surface });
    setClipboardSheetOpen(true);
  }, [clipboardPolicy.surface, logDebug]);

  // Ending a response-required browser session is destructive — it tears down
  // the live session and abandons whatever login/manual step is mid-flight.
  // No-response assistance (for example ChatGPT browser login polling) may be
  // hidden without sending any connector response.
  const interactionPending = interactionRequiresResponse && SUPPORTED_KINDS.has(interactionKind);
  const handleCloseRequest = useCallback(() => {
    if (interactionPending) {
      logDebug("neko.corner.close", { phase: "close-guard-armed", interactionKind });
      setCloseConfirmArmed(true);
      return;
    }
    onClose();
  }, [interactionKind, interactionPending, logDebug, onClose]);

  const handleCloseConfirm = useCallback(() => {
    logDebug("neko.corner.close", { phase: "close-guard-confirmed", interactionKind });
    setCloseConfirmArmed(false);
    onClose();
  }, [interactionKind, logDebug, onClose]);

  const handleCloseCancel = useCallback(() => {
    logDebug("neko.corner.close", { phase: "close-guard-cancelled", interactionKind });
    setCloseConfirmArmed(false);
  }, [interactionKind, logDebug]);

  const nekoViewportInfo = useStableNekoNativeViewportInfo(!!nekoSession, viewportInfo);
  const nekoLocalSurfaceViewportInfo = useStableNekoNativeViewportInfo(!!nekoSession, localSurfaceViewportInfo);
  const nekoPresentationViewportInfo = useStableNekoNativeViewportInfo(!!nekoSession, presentationViewportInfo);

  return (
    <div className="relative flex h-full w-full flex-col bg-black" data-pdpp-stream-debug={debugEnabled}>
      {nekoSession ? (
        <NekoSurface
          adapterRef={nekoSurfaceAdapterRef}
          debugEnabled={debugEnabled}
          localSurfaceViewportInfo={nekoLocalSurfaceViewportInfo}
          logDebug={logDebug}
          onPresentationViewportReady={handleNekoPresentationViewportReady}
          presentationViewportInfo={nekoPresentationViewportInfo}
          session={nekoSession}
          status={status}
          surfaceRef={setStreamSurfaceNode}
          viewportInfo={nekoViewportInfo}
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
        onClose={handleCloseRequest}
        onCopy={nekoSession && clipboardPolicy.showMobileCopyButton ? handleMobileCopy : undefined}
        onKeyboard={
          nekoSession && clipboardPolicy.showKeyboardButton
            ? () => {
                // Step 5b: route through the adapter so
                // MobileTextInputController binds and our IME pipeline
                // takes over (rather than n.eko's bundled fallback).
                // adapter.focusTextInput() preserves n.eko remote focus
                // state and focuses the controller-bound textarea.
                const adapter = nekoSurfaceAdapterRef.current;
                logDebug("neko.corner.keyboard.tapped", {
                  adapterPresent: !!adapter,
                  adapterMounted: adapter?.getLifecycleState() === "mounted",
                  adapterState: adapter?.getLifecycleState() ?? null,
                });
                if (adapter && adapter.getLifecycleState() === "mounted") {
                  adapter.focusTextInput();
                }
                logDebug("neko.corner.keyboard", {
                  adapterMounted: adapter?.getLifecycleState() === "mounted",
                  controllerTextareaFocused:
                    document.activeElement ===
                    containerRef.current?.querySelector<HTMLTextAreaElement>('[data-pdpp-soft-keyboard="neko"]'),
                  snapshot: readSurfaceDebugSnapshot(containerRef.current),
                });
              }
            : undefined
        }
        onPaste={nekoSession && clipboardPolicy.showMobilePasteButton ? handleMobilePaste : undefined}
        status={status}
      />
      {closeConfirmArmed ? (
        <CloseConfirmBubble connectorName={connectorName} onCancel={handleCloseCancel} onConfirm={handleCloseConfirm} />
      ) : null}
      <StreamInteractionDock
        interactionId={interactionId}
        interactionKind={interactionKind}
        interactionRequiresResponse={interactionRequiresResponse}
        message={interactionMessage}
        runId={runId}
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
          getSurface={() => nekoSurfaceAdapterRef.current}
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
  let playgroundEvents: Record<string, unknown>[] | null = null;
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

async function drainRemotePlaygroundEvents({
  cancelled,
  logDebug,
  seenRegistry,
  statusPath,
}: {
  cancelled: () => boolean;
  logDebug: StreamDebugLogger;
  seenRegistry: PlaygroundSeenRegistry;
  statusPath: string;
}): Promise<boolean> {
  if (cancelled()) {
    return false;
  }
  const status = await fetchNekoStatusBestEffort(statusPath);
  if (cancelled()) {
    return false;
  }
  emitRemotePlaygroundEvents(status.playgroundEvents, seenRegistry, logDebug);
  return !cancelled();
}

function emitRemotePlaygroundEvents(
  entries: Record<string, unknown>[] | null,
  seenRegistry: PlaygroundSeenRegistry,
  logDebug: StreamDebugLogger
): void {
  if (!entries || entries.length === 0) {
    return;
  }
  for (const entry of entries) {
    if (claimPlaygroundEvent(seenRegistry, entry) === "duplicate") {
      continue;
    }
    const type = typeof entry.type === "string" ? entry.type : "unknown";
    logDebug(`playground.${type}`, {
      ...entry,
      source: "remote-debug-drain",
    });
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
  const payload = (await fetchNekoClientConfigResponse(clientConfigPath)) as NekoClientConfigResponse;
  return normalizeNekoClientConfig(payload);
}

// ─── The direct n.eko WebRTC surface ──────────────────────────────────────────

function NekoSurface({
  adapterRef,
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
  adapterRef: { current: NekoSurfaceAdapter | null };
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
  const firstMediaSampleLoggedRef = useRef(false);
  // Shared by the settle poll and the debug-only drain so whichever
  // path sees a remote playground event first claims it.
  const playgroundSeenRef = useRef<PlaygroundSeenRegistry>(createPlaygroundSeenRegistry());
  const mediaSettleStateRef = useRef(createNekoMediaSettleState());
  const mediaSettleTargetRef = useRef<NekoMediaSettleTarget | null>(null);
  const presentationViewportInfoRef = useRef(presentationViewportInfo);
  const [clientConfig, setClientConfig] = useState<NekoClientConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [configLoadRetryEpoch, setConfigLoadRetryEpoch] = useState(0);
  const [mediaRefreshEpoch, setMediaRefreshEpoch] = useState(0);
  const [mediaDisplayable, setMediaDisplayable] = useState(false);
  const mediaDisplayableRef = useRef(false);
  const [mediaReady, setMediaReady] = useState(false);
  useSurfaceDebugTelemetry({ containerRef, debugEnabled, logDebug, surface: "neko", viewportInfo });
  useVisualQualityDebugTelemetry({ containerRef, debugEnabled, logDebug, surface: "neko", viewportInfo });

  useEffect(() => {
    presentationViewportInfoRef.current = presentationViewportInfo;
  }, [presentationViewportInfo]);

  useEffect(() => {
    const handleMediaLayout = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail : null;
      logDebug("neko.media.layout_event", {
        detail,
      });
      setMediaRefreshEpoch((epoch) => epoch + 1);
    };
    window.addEventListener(NEKO_MEDIA_LAYOUT_EVENT, handleMediaLayout);
    return () => {
      window.removeEventListener(NEKO_MEDIA_LAYOUT_EVENT, handleMediaLayout);
    };
  }, [logDebug]);

  // Step 3 of the RemoteSurface migration: NekoSurface depends only on
  // RemoteSurface. The adapter wraps neko-client.ts via the file-local
  // NekoClientApi shim; pointer dispatch on the wire goes through
  // NekoPointerController (inside the adapter).
  // Step 5b: the adapter ref is owned by StreamStage so the corner
  // keyboard handler can call adapter.focusTextInput() — aliased here.
  const nekoSurfaceAdapterRef = adapterRef;
  // Mobile soft-keyboard hidden textarea. MobileTextInputController
  // (inside NekoSurfaceAdapter) binds to it lazily on first
  // focusTextInput. The textarea is visually-hidden + focusable so the
  // OS soft keyboard opens when we .focus() it; the controller
  // translates IME composition into sendText / sendKeysym calls.
  const softKeyboardTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const retryEpoch = configLoadRetryEpoch;
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
        logDebug("neko_client_config_loaded", {
          hasLogin: Boolean(config.login),
          hasServerPath: Boolean(config.serverPath),
          hasStatusPath: Boolean(config.statusPath),
          retryEpoch,
          serverPathLength: config.serverPath.length,
          statusPath: config.statusPath,
        });
        const adapter = new NekoSurfaceAdapter({
          client: createNekoClientApi({
            getTextarea: () => softKeyboardTextareaRef.current,
          }),
          config: { kind: "neko", ...(config as unknown as Record<string, unknown>) },
          logger: (level, msg, meta) => {
            logDebug(msg, { level, ...(meta ?? {}) });
          },
        });
        nekoSurfaceAdapterRef.current = adapter;
        await adapter.mount(nekoMountNode);
        logDebug("adapter_mounted", {
          lifecycleState: adapter.getLifecycleState(),
          surface: "neko",
        });
        if (cancelled) {
          await adapter.unmount();
          nekoSurfaceAdapterRef.current = null;
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
      const adapter = nekoSurfaceAdapterRef.current;
      nekoSurfaceAdapterRef.current = null;
      if (adapter) {
        adapter.unmount().catch(() => {
          /* best-effort teardown */
        });
      }
    };
  }, [configLoadRetryEpoch, logDebug, session.clientConfigPath, nekoSurfaceAdapterRef]);

  // Capture-phase pointer dispatch into the adapter. This is the wire
  // boundary the expert prescribed: pointer events become RemotePointerEvent
  // at the dashboard edge and the adapter (via NekoPointerController)
  // handles tap-to-click + drag semantics. Hover-only mouse moves
  // (pointerType=mouse && buttons===0) are gated out to avoid flooding
  // the wire on desktop trackpad usage. Touch moves are always forwarded.
  useEffect(() => {
    const mountNode = containerRef.current;
    if (!mountNode) {
      return;
    }
    const isCoarsePointer = () =>
      typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
    const markRemoteInputFocusedAfterMousePointerUp = (source: "pointerup" | "document-mouseup") => {
      window.setTimeout(() => {
        const adapter = nekoSurfaceAdapterRef.current;
        if (!adapter || adapter.getLifecycleState() !== "mounted") {
          logDebug("neko.keyboard_focus.mouse_pointer_up.skip", {
            source,
            state: adapter?.getLifecycleState() ?? null,
          });
          return;
        }
        adapter.setRemoteInputFocused(true);
        logDebug("neko.keyboard_focus.mouse_pointer_up", {
          snapshot: readSurfaceDebugSnapshot(containerRef.current),
          source,
        });
      }, 0);
    };
    const remoteTypeFor = (type: string): "pointerdown" | "pointermove" | "pointerup" | "pointercancel" | null => {
      switch (type) {
        case "pointerdown":
          return "pointerdown";
        case "pointermove":
          return "pointermove";
        case "pointerup":
          return "pointerup";
        case "pointercancel":
          return "pointercancel";
        default:
          return null;
      }
    };
    const handler = (event: PointerEvent) => {
      const type = remoteTypeFor(event.type);
      if (!type) {
        return;
      }
      // Hover-move gate (step 2 open question #2): suppress mouse moves
      // with no button held to prevent hover floods.
      if (type === "pointermove" && event.pointerType === "mouse" && event.buttons === 0) {
        return;
      }
      const adapter = nekoSurfaceAdapterRef.current;
      if (!adapter || adapter.getLifecycleState() !== "mounted") {
        return;
      }
      const pointerType: "mouse" | "touch" | "pen" =
        event.pointerType === "touch" || event.pointerType === "pen" ? event.pointerType : "mouse";
      adapter
        .sendPointer({
          button: event.button,
          pointerId: event.pointerId,
          pointerType,
          pressure: event.pressure,
          type,
          // mapPointerToRemote expects viewport-absolute coordinates
          // (getNekoControlPos in neko-client.ts:1423 reads clientX/Y).
          x: event.clientX,
          y: event.clientY,
        })
        .then(() => {
          if (type === "pointerup" && pointerType === "mouse" && event.button === 0) {
            markRemoteInputFocusedAfterMousePointerUp("pointerup");
          }
        })
        .catch(() => {
          /* swallow; adapter logs */
        });
    };
    const mouseupFallback = (event: MouseEvent) => {
      if (isCoarsePointer() || event.button !== 0) {
        return;
      }
      const target = event.target;
      if (!(target instanceof Node && mountNode.contains(target))) {
        return;
      }
      markRemoteInputFocusedAfterMousePointerUp("document-mouseup");
    };
    const opts: AddEventListenerOptions = { capture: true, passive: true };
    mountNode.addEventListener("pointerdown", handler as EventListener, opts);
    mountNode.addEventListener("pointermove", handler as EventListener, opts);
    mountNode.addEventListener("pointerup", handler as EventListener, opts);
    mountNode.addEventListener("pointercancel", handler as EventListener, opts);
    document.addEventListener("mouseup", mouseupFallback, opts);
    return () => {
      mountNode.removeEventListener("pointerdown", handler as EventListener, opts);
      mountNode.removeEventListener("pointermove", handler as EventListener, opts);
      mountNode.removeEventListener("pointerup", handler as EventListener, opts);
      mountNode.removeEventListener("pointercancel", handler as EventListener, opts);
      document.removeEventListener("mouseup", mouseupFallback, opts);
    };
  }, [logDebug, nekoSurfaceAdapterRef.current]);

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
        if (claimPlaygroundEvent(playgroundSeenRef.current, entry) === "duplicate") {
          continue;
        }
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
      mediaSettleTargetRef.current = null;
      mediaSettleStateRef.current = createNekoMediaSettleState();
      firstMediaSampleLoggedRef.current = false;
      mediaDisplayableRef.current = false;
      setMediaDisplayable(false);
      setMediaReady(false);
      return;
    }

    const target = nekoMediaSettleTarget(clientConfig, viewportInfo);
    const targetChanged = !nekoMediaSettleTargetsMatch(mediaSettleTargetRef.current, target);
    if (targetChanged) {
      mediaSettleTargetRef.current = target;
      mediaSettleStateRef.current = createNekoMediaSettleState();
      firstMediaSampleLoggedRef.current = false;
      setMediaReady(false);
    } else {
      logDebug("neko.media.settle.refresh", {
        mediaRefreshEpoch,
        reason: "same-target",
        target,
        viewport: viewportInfo,
      });
    }
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
        if (!firstMediaSampleLoggedRef.current) {
          firstMediaSampleLoggedRef.current = true;
          logDebug("first_media_sample", {
            pollCount,
            sample,
            target,
            viewport: viewportInfo,
          });
        }
        const result = assessNekoMediaSettle({
          maxSettlingSamples: STREAM_VIEWER_POLICY.nekoMediaSettleMaxPolls,
          sample,
          state: mediaSettleStateRef.current,
        });
        mediaSettleStateRef.current = result.state;
        const displayable = nekoMediaSettleSampleHasDisplayableFrame(sample);
        if (displayable && !mediaDisplayableRef.current) {
          mediaDisplayableRef.current = true;
          setMediaDisplayable(true);
          logDebug("neko.media.displayable", {
            pollCount,
            sample,
            status: result.status,
            viewport: viewportInfo,
          });
        }
        logDebug("neko.media.settle.sample", {
          pollCount,
          reasons: result.reasons,
          sample,
          status: result.status,
        });
        if (result.status === "settled") {
          mediaDisplayableRef.current = true;
          setMediaDisplayable(true);
          setMediaReady(true);
          onPresentationViewportReady(viewportInfo, { status: "settled" });
          return;
        }
        if (result.status === "degraded") {
          mediaDisplayableRef.current = displayable;
          setMediaDisplayable(displayable);
          setMediaReady(displayable);
          logDebug("neko.media.degraded_displayable", {
            displayable,
            reasons: result.reasons,
            sample,
            viewport: viewportInfo,
          });
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
  }, [clientConfig, logDebug, mediaRefreshEpoch, onPresentationViewportReady, viewportInfo]);

  // Debug-only drain of remote `playground.*` events after layout
  // polling stops. This is observation-only: it never applies layout.
  useEffect(() => {
    if (!debugEnabled) {
      return;
    }
    if (!clientConfig?.statusPath) {
      return;
    }
    const statusPath = clientConfig.statusPath;
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    const drainOnce = async () => {
      const shouldContinue = await drainRemotePlaygroundEvents({
        cancelled: () => cancelled,
        logDebug,
        seenRegistry: playgroundSeenRef.current,
        statusPath,
      });
      if (shouldContinue) {
        pollTimer = setTimeout(drainOnce, STREAM_VIEWER_POLICY.nekoDebugDrainPollMs);
      }
    };

    pollTimer = setTimeout(drainOnce, STREAM_VIEWER_POLICY.nekoDebugDrainPollMs);
    return () => {
      cancelled = true;
      if (pollTimer) {
        clearTimeout(pollTimer);
      }
    };
  }, [clientConfig?.statusPath, debugEnabled, logDebug]);

  const presentationMatchesRequestedViewport =
    !!presentationViewportInfo && !!viewportInfo && streamViewportInfosMatch(presentationViewportInfo, viewportInfo);
  const localSurfaceCanDisplay =
    presentationMatchesRequestedViewport &&
    localSurfaceCanDisplayPresentation(localSurfaceViewportInfo, presentationViewportInfo);
  const presentationReadyForDisplay = mediaReady && presentationMatchesRequestedViewport && localSurfaceCanDisplay;
  const showLoadingOverlay = !(error || presentationReadyForDisplay || mediaDisplayable);

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
              <button
                className="mt-4 rounded-md border border-border bg-background px-3 py-1.5 font-medium text-foreground text-xs hover:bg-muted"
                onClick={() => {
                  setError(null);
                  setMediaReady(false);
                  setMediaDisplayable(false);
                  setConfigLoadRetryEpoch((epoch) => epoch + 1);
                }}
                type="button"
              >
                Retry secure browser
              </button>
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
        {/* Hidden soft-keyboard textarea — MobileTextInputController binds */}
        {/* its compositionstart/end + input + keydown listeners here. The   */}
        {/* corner Keyboard button (and any future tap-to-focus) calls       */}
        {/* `focusTextInput()` on the RemoteSurface adapter; the adapter     */}
        {/* delegates focus through the n.eko client shim and binds the      */}
        {/* controller. Visually-hidden but                                  */}
        {/* focusable + aria-hidden so AT users don't see a phantom field.   */}
        <textarea
          aria-hidden="true"
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          className="absolute h-px w-px overflow-hidden opacity-0"
          data-pdpp-soft-keyboard="neko"
          inputMode="text"
          ref={softKeyboardTextareaRef}
          spellCheck={false}
          style={{ left: "-9999px", top: "-9999px" }}
          tabIndex={-1}
        />
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
  const softKeyboardInputRef = useRef<HTMLInputElement | null>(null);
  const adapterRef = useRef<CdpSurfaceAdapter | null>(null);
  const viewportInfoRef = useRef(viewportInfo);
  const clipboardPolicyRef = useRef(clipboardPolicy);
  viewportInfoRef.current = viewportInfo;
  clipboardPolicyRef.current = clipboardPolicy;

  useSurfaceDebugTelemetry({ containerRef, debugEnabled, logDebug, surface: "cdp-frame", viewportInfo });
  useVisualQualityDebugTelemetry({ containerRef, debugEnabled, logDebug, surface: "cdp-frame", viewportInfo });

  const sendCdpInput = useCallback(
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

  useEffect(() => {
    const node = containerRef.current;
    if (!node) {
      return;
    }
    const adapter = new CdpSurfaceAdapter({
      client: {
        sendInput: sendCdpInput,
        getViewportInfo: () => viewportInfoRef.current,
        getFrameElement: () => imgRef.current,
        getClipboardPolicy: () => clipboardPolicyRef.current,
        getSoftKeyboardElement: () => softKeyboardInputRef.current,
        onInputDebug: (event, payload) => {
          logDebug(event, {
            ...payload,
            snapshot:
              event === "surface.cdp-frame.soft_keyboard.focus"
                ? readSurfaceDebugSnapshot(containerRef.current)
                : undefined,
          });
        },
      },
      config: { kind: "cdp" },
    });
    adapterRef.current = adapter;
    adapter.mount(node).catch((err) => {
      logDebug("surface.cdp-frame.adapter_mount_error", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    return () => {
      adapterRef.current = null;
      adapter.unmount().catch((err) => {
        logDebug("surface.cdp-frame.adapter_unmount_error", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    };
  }, [containerRef, logDebug, sendCdpInput]);

  return (
    <div className="flex flex-1 items-center justify-center overflow-hidden">
      <div
        aria-label="Connector browser stream"
        className="pdpp-stream-frame relative focus-within:ring-2 focus-within:ring-primary/40 focus-within:ring-inset"
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

async function sendSheetTextToBrowser({
  localText,
  logDebug,
  policy,
  setLocalText,
  setPasteState,
  surface,
}: {
  localText: string;
  logDebug: StreamDebugLogger;
  policy: ClipboardPolicyDecision;
  setLocalText: (text: string) => void;
  setPasteState: (state: ClipboardPasteState) => void;
  surface: NekoSurfaceAdapter | null;
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
  const surfaceState = surface?.getLifecycleState() ?? null;
  let pasted = false;
  if (surface && surfaceState === "mounted") {
    pasted = await surface.pasteText(localText);
  }
  logDebug(
    "clipboard.local_to_remote",
    clipboardDebugMetadata(localText, {
      method: "control.paste",
      phase: "send-result",
      policy: policy.directionPolicy,
      sent: pasted,
      surface: policy.surface,
      surfaceState,
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

async function requestBrowserCopyFromSheet({
  logDebug,
  policy,
  setCopyState,
  surface,
}: {
  logDebug: StreamDebugLogger;
  policy: ClipboardPolicyDecision;
  setCopyState: (state: ClipboardCopyState) => void;
  surface: NekoSurfaceAdapter | null;
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
  const surfaceState = surface?.getLifecycleState() ?? null;
  let dispatched = false;
  if (surface && surfaceState === "mounted") {
    dispatched = await surface.copyRemoteSelection();
  }
  logDebug("clipboard.remote_to_local", {
    method: "control.copy",
    phase: "browser-copy-requested",
    policy: policy.directionPolicy,
    sent: dispatched,
    surface: policy.surface,
    surfaceState,
  });
  if (!dispatched) {
    setCopyState("failed");
  }
}

function ClipboardSheet({
  capabilities,
  connectorName,
  getSurface,
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
  getSurface: () => NekoSurfaceAdapter | null;
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
  const sendToBrowser = () => {
    sendSheetTextToBrowser({
      localText,
      logDebug,
      policy,
      setLocalText,
      setPasteState,
      surface: getSurface(),
    }).catch((err) => {
      setPasteState("failed");
      logDebug("clipboard.local_to_remote", {
        error: err instanceof Error ? err.message : String(err),
        method: "control.paste",
        phase: "send-error",
        policy: policy.directionPolicy,
        surface: policy.surface,
      });
    });
  };
  const copyToDevice = () => copySheetTextToDevice({ logDebug, policy, remoteClipboard, setCopyState });
  const requestBrowserCopy = () => {
    requestBrowserCopyFromSheet({
      logDebug,
      policy,
      setCopyState,
      surface: getSurface(),
    }).catch((err) => {
      setCopyState("failed");
      logDebug("clipboard.remote_to_local", {
        error: err instanceof Error ? err.message : String(err),
        method: "control.copy",
        phase: "browser-copy-error",
        policy: policy.directionPolicy,
        surface: policy.surface,
      });
    });
  };

  const localStatus = localClipboardStatus(pasteState, capabilities.needsManualReadFallback);
  const copyStatus = remoteClipboardStatus(copyState, remoteClipboard);

  return (
    <IcDialog modal onOpenChange={onOpenChange} open={open}>
      <IcDialogPortal>
        <IcDialogBackdrop className="bg-black/30" data-pdpp-stream-ui />
        <IcDialogPopup
          aria-label={`${connectorName} browser clipboard`}
          className="pdpp-stream-clipboard-sheet fixed inset-x-3 top-auto bottom-3 m-0 flex max-h-[min(82vh,42rem)] max-w-none translate-x-0 translate-y-0 flex-col gap-4 overflow-hidden rounded-2xl border border-border/80 bg-background p-0 shadow-2xl data-[ending-style]:translate-y-full data-[starting-style]:translate-y-full data-[ending-style]:scale-100 data-[starting-style]:scale-100 sm:right-5 sm:left-auto sm:w-[28rem]"
          data-pdpp-stream-ui
        >
          <div className="flex items-start justify-between gap-3 border-border/70 border-b px-4 py-3">
            <div>
              <IcDialogTitle className="text-base">Clipboard</IcDialogTitle>
              <IcDialogDescription className="mt-1 text-sm">
                Move text between this device and the streamed browser with an explicit tap.
              </IcDialogDescription>
            </div>
            <IcButton
              aria-label="Close clipboard"
              onClick={() => onOpenChange(false)}
              size="sm"
              type="button"
              variant="ghost"
            >
              ×
            </IcButton>
          </div>
          <div className="flex flex-1 flex-col gap-5 overflow-y-auto overscroll-contain px-4 pb-4">
            <section className="grid gap-3">
              <div className="space-y-1">
                <h3 className="pdpp-eyebrow">This device to browser</h3>
                <p className="pdpp-caption text-muted-foreground">{localStatus}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <IcButton
                  disabled={!(canPasteLocalToRemote && policy.canReadLocalClipboard)}
                  onClick={pasteFromDevice}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Paste from device
                </IcButton>
                <IcButton disabled={!canSendLocalText} onClick={sendToBrowser} size="sm" type="button">
                  Send to browser
                </IcButton>
                {remoteInputSensitive ? (
                  <IcButton
                    onClick={() => setRevealLocalText((shown) => !shown)}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    {revealLocalText ? "Hide text" : "Show text"}
                  </IcButton>
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
                <IcButton
                  disabled={!canRequestRemoteCopy}
                  onClick={requestBrowserCopy}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Copy browser selection
                </IcButton>
                <IcButton
                  disabled={!(remoteClipboard && policy.canWriteLocalClipboard)}
                  onClick={copyToDevice}
                  size="sm"
                  type="button"
                >
                  Copy to device
                </IcButton>
                <IcButton
                  disabled={!remoteClipboard}
                  onClick={onClearRemoteClipboard}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Clear
                </IcButton>
              </div>
              <textarea
                aria-label="Text copied from browser"
                className="min-h-20 resize-y rounded-lg border border-border/80 bg-muted/30 p-3 text-foreground text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                readOnly
                value={remoteClipboard?.text ?? ""}
              />
            </section>
          </div>
        </IcDialogPopup>
      </IcDialogPortal>
    </IcDialog>
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
            aria-label={`Open paste controls for ${connectorName} browser`}
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
          // Disambiguate the stream-killer from the dock's non-destructive
          // "Hide instructions" collapse: an owner mid-auth read the corner X
          // as "dismiss this notice" and lost their session. Say plainly that
          // this ends the live browser session, in both the tooltip and the
          // assistive label.
          aria-label={`End ${connectorName} browser session`}
          className="pdpp-stream-control-button"
          onClick={onClose}
          title={`End ${connectorName} browser session`}
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
            <title>End browser session</title>
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

// ─── Close-confirmation bubble (mid-interaction guard) ───────────────────────

/**
 * Inline confirmation shown when the operator presses the corner X while a
 * manual_action/otp interaction is pending. The corner X is the only
 * stream-killer on this surface; an owner mid-auth previously read it as
 * "dismiss this notice" and lost the session. Rather than a native
 * `window.confirm` (banned by the lint rules and obtrusive on mobile), arming
 * shows this bubble with two explicit choices: end the session (destructive)
 * or keep working. Hiding the step instructions is a separate, non-destructive
 * control on the dock — this copy points back at it so the two never blur.
 */
function CloseConfirmBubble({
  connectorName,
  onCancel,
  onConfirm,
}: {
  connectorName: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      aria-label="Confirm ending the browser session"
      className="pdpp-stream-toast-zone"
      data-pdpp-stream-ui
      data-slot="close-confirm"
      role="alertdialog"
    >
      <div className="pdpp-stream-toast-bubble flex w-full flex-col gap-2 text-left">
        <p className="pdpp-caption font-medium text-foreground">End the {connectorName} browser session now?</p>
        <p className="pdpp-caption text-muted-foreground">
          The step in progress will be abandoned. To get the panel out of the way without ending the session, use “Hide
          instructions” instead.
        </p>
        <div className="flex flex-wrap gap-2">
          <IcButton onClick={onConfirm} size="sm" type="button" variant="destructive">
            End browser session
          </IcButton>
          <IcButton onClick={onCancel} size="sm" type="button" variant="ghost">
            Keep working
          </IcButton>
        </div>
      </div>
    </div>
  );
}

// ─── Interaction response dock ───────────────────────────────────────────────

function StreamInteractionDock({
  interactionId,
  interactionKind,
  interactionRequiresResponse,
  message,
  runId,
}: {
  interactionId: string;
  interactionKind: string;
  interactionRequiresResponse: boolean;
  message: string;
  runId: string;
}) {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (!(interactionRequiresResponse && (interactionKind === "otp" || interactionKind === "manual_action"))) {
    return null;
  }

  function submitInteraction(data?: Record<string, string>) {
    const formData = new FormData();
    formData.set("run_id", runId);
    formData.set("interaction_id", interactionId);
    formData.set("status", "success");
    for (const [key, value] of Object.entries(data ?? {})) {
      formData.set(key, value);
    }

    setError(null);
    startTransition(async () => {
      const next = await submitRunInteractionAction(INITIAL_INTERACTION_ACTION_STATE, formData);
      if (next.error) {
        setError(next.error);
        return;
      }
      router.refresh();
    });
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (interactionKind === "otp") {
      const trimmed = code.trim();
      if (!trimmed) {
        setError('Enter the code, or use "I entered it in the browser" after completing 2FA there.');
        return;
      }
      submitInteraction({ code: trimmed });
      return;
    }
    submitInteraction();
  }

  let submitLabel = "Continue collection";
  if (interactionKind === "otp") {
    submitLabel = "Submit code";
  }
  if (isPending) {
    submitLabel = "Continuing...";
  }

  if (collapsed) {
    return (
      <div className="pdpp-stream-toast-zone" data-pdpp-stream-ui data-slot="interaction">
        <IcButton
          aria-expanded="false"
          className="pdpp-stream-toast-bubble"
          onClick={() => setCollapsed(false)}
          size="sm"
          type="button"
          variant="ghost"
        >
          Show continue controls
        </IcButton>
      </div>
    );
  }

  return (
    <div className="pdpp-stream-toast-zone" data-pdpp-stream-ui data-slot="interaction">
      <form
        aria-label="Complete this connector step"
        autoComplete="off"
        className="pdpp-stream-toast-bubble flex w-full flex-col gap-2 text-left"
        onSubmit={handleSubmit}
      >
        <div className="flex items-start justify-between gap-3">
          <p className="pdpp-caption font-medium text-foreground">{message}</p>
          <IcButton
            aria-expanded="true"
            aria-label="Hide connector step instructions"
            className="shrink-0"
            onClick={() => setCollapsed(true)}
            size="sm"
            type="button"
            variant="ghost"
          >
            Hide instructions
          </IcButton>
        </div>
        {interactionKind === "otp" ? (
          <IcInput
            autoComplete="one-time-code"
            inputMode="numeric"
            onChange={(event) => setCode(event.currentTarget.value)}
            pattern="\\d{6}"
            placeholder="6-digit code"
            value={code}
          />
        ) : null}
        {interactionKind === "manual_action" ? (
          <p className="pdpp-caption text-muted-foreground">
            When the browser page is logged in or the requested action is complete, press Continue collection. Hiding
            this panel only moves it out of the way; it does not resume the run.
          </p>
        ) : null}
        {error ? (
          <p className="pdpp-caption text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <IcButton disabled={isPending} size="sm" type="submit">
            {submitLabel}
          </IcButton>
          {interactionKind === "otp" ? (
            <IcButton disabled={isPending} onClick={() => submitInteraction()} size="sm" type="button" variant="ghost">
              I entered it in the browser
            </IcButton>
          ) : null}
        </div>
      </form>
    </div>
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
 * satisfied. Quiet and declarative; never promises browser-controlled tab
 * closing because browsers block scripted tab closing for normal navigations.
 */
export function ResolvedSurface({ connector, runId }: { connector: ConnectorContext | null; runId: string }) {
  const subject = connector?.displayName ?? "The connector";

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
          <p className="pdpp-body text-foreground">
            The browser step is complete. You can close this tab with your browser controls, or open the run timeline.
          </p>
          <Link
            className={buttonVariants({ variant: "default", size: "lg", className: "h-12 w-full justify-center" })}
            href={`/syncs/${encodeURIComponent(runId)}`}
          >
            Open run timeline
          </Link>
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
            <IcButton className="h-12 w-full" size="lg" type="button">
              Open run timeline
            </IcButton>
          </Link>
        </section>
      </div>
    </main>
  );
}
