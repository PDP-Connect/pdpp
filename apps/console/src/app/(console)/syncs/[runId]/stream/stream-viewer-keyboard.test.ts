import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const NEKO_CLIENT_FILE = `${HERE}neko-client.ts`;
const STREAM_VIEWER_FILE = `${HERE}stream-viewer.tsx`;
const STREAM_PAGE_FILE = `${HERE}page.tsx`;
const STREAM_PLAYGROUND_PAGE_FILE = `${HERE}../../../stream-playground/page.tsx`;
const GLOBAL_CSS_FILE = `${HERE}../../../../globals.css`;
const VIRTUAL_KEYBOARD_OVERLAY_RE =
  /virtualKeyboard[\s\S]*"overlaysContent" in virtualKeyboard[\s\S]*virtualKeyboard\.overlaysContent = true/;
const VIRTUAL_KEYBOARD_RESTORE_RE = /virtualKeyboard\.overlaysContent = previousOverlaysContent/;
const KEYBOARD_RESIZE_SUPPRESS_RE = /keyboardResizeSuppress[\s\S]*reason: "keyboard-resize"/;
const PRESENTATION_KEYBOARD_HOLD_RE = /shouldHoldPresentationViewportForKeyboard[\s\S]*viewport\.presentation\.hold/;
const LOCAL_GESTURE_REMOTE_FOCUS_RE =
  /focusNekoKeyboardFromLocalGesture[\s\S]*remoteInputFocused[\s\S]*focusOverlayTextarea\("local-gesture"\)/;
const NEKO_SURFACE_LOCAL_GESTURE_TRIGGER_RE =
  /onPointerDownCapture=\{handleLocalStreamGesture\}|neko\.keyboard_focus\.local_gesture/;
const OPTIMISTIC_KEYBOARD_FOCUS_RE =
  /local-gesture-optimistic|coarse-pointer-optimistic|neko\.keyboard_focus\.optimistic_rollback/;
const INTERACTIVE_WIDGET_OVERLAY_RE = /interactiveWidget:\s*"overlays-content"/;
const INTERACTIVE_WIDGET_RESIZES_VISUAL_RE = /interactiveWidget:\s*"resizes-visual"/;
const STREAM_DIALOG_SVH_RE = /\.pdpp-stream-dialog[\s\S]*100svh/;
const STREAM_DIALOG_LVH_RE = /\.pdpp-stream-dialog[\s\S]*100lvh/;
const STREAM_DIALOG_DVH_RE = /\.pdpp-stream-dialog[\s\S]*100dvh/;
const NEKO_CONTAINER_RECT_OPTION_RE =
  /setNekoViewportLayout\([^)]*?\{\s*containerRect[\s\S]*?readContainerRect\(containerRef\.current\)/;
const NEKO_PRESENTATION_CONTAINER_RECT_OPTION_RE = /setNekoPresentationViewportLayout\([^)]*?\{\s*containerRect/;
const NEKO_LAYOUT_DEFERRED_RE = /firstNekoLayoutAppliedRef\.current[\s\S]*?neko\.layout\.deferred/;
const NEKO_LAYOUT_FALLBACK_REASON_RE = /reason:\s*"no-status-path-configured"/;
const NEKO_LAYOUT_MISSING_STATUS_PATH_REASON_RE = /reason:\s*"missing-status-path"/;
const NEKO_RESIZE_INITIAL_DROPPED_RE = /scheduleSource\("resize\.initial"\)/;
const NEKO_CONTAINER_RECT_OVERRIDE_RE = /applyContainerRectOverride\([\s\S]*?containerRect/;
const NEKO_VIEWPORT_LAYOUT_OPTIONS_TYPE_RE = /NekoSetViewportLayoutOptions[\s\S]*?containerRect\??:/;
const NEKO_PRESENTATION_PENDING_RE = /viewport\.presentation\.pending/;
const NEKO_PRESENTATION_REMOTE_READY_RE =
  /result\.status === "settled"[\s\S]*?onPresentationViewportReady\(viewportInfo,\s*\{\s*status: "settled"\s*\}/;
const NEKO_PRESENTATION_DEGRADED_SKIP_RE = /result\.status !== "settled"[\s\S]*reason: "media-degraded"/;
const NEKO_PRESENTATION_DEGRADED_PROMOTE_RE =
  /result\.status === "degraded"[\s\S]*?onPresentationViewportReady\(viewportInfo,\s*\{\s*reasons: result\.reasons,\s*status: "degraded"\s*\}/;
const NEKO_PRESENTATION_IMMEDIATE_POST_PROMOTION_RE =
  /setViewportInfo\(viewportInfo\);\s*applyStablePresentationViewport\(viewportInfo\)/;
const NEKO_PRESENTATION_EARLY_MEDIA_READY_RE = /sample\.media[\s\S]{0,180}setMediaReady\(true\)/;
const NEKO_LAYOUT_DEFERRED_PRESENTATION_RE = /neko\.layout\.deferred_presentation/;
const NEKO_LOADING_OVERLAY_STABLE_PRESENTATION_RE =
  /localSurfaceCanDisplayPresentation[\s\S]*localSurfaceCanDisplay[\s\S]*const presentationReadyForDisplay = mediaReady && presentationMatchesRequestedViewport && localSurfaceCanDisplay[\s\S]*const showLoadingOverlay = !\([\s\S]*presentationReadyForDisplay \|\| mediaDisplayable/;
const NEKO_DEGRADED_MEDIA_DISPLAYABLE_RE =
  /result\.status === "degraded"[\s\S]*setMediaDisplayable\(displayable\)[\s\S]*neko\.media\.degraded_displayable/;
const NEKO_SETTLING_MEDIA_DISPLAYABLE_RE =
  /const displayable = nekoMediaSettleSampleHasDisplayableFrame\(sample\)[\s\S]*if \(displayable && !mediaDisplayableRef\.current\) \{[\s\S]*setMediaDisplayable\(true\)[\s\S]*neko\.media\.displayable[\s\S]*if \(result\.status === "settled"\)/;
const NEKO_STABLE_PRESENTATION_CONTAINER_RECT_RE =
  /stablePresentationContainerRect\(actualContainerRect,\s*presentationViewportInfo\)/;
const NEKO_LOADING_OVERLAY_CLASS_RE = /className="absolute inset-0 z-20/;
const NEKO_LOADING_OVERLAY_DATA_ATTR_RE = /data-pdpp-stream-loading/;
const NEKO_VISUAL_QUALITY_IGNORES_OCCLUDED_MEDIA_RE =
  /node\.matches\("\[data-pdpp-stream-loading\]"\)[\s\S]*const issues = occluded \? \[\] : classifyVisualQualityIssues\(media\)/;
const NEKO_MEDIA_SETTLE_LONG_STARTUP_WINDOW_RE = /nekoMediaSettleMaxPolls:\s*40/;
const NEKO_MEDIA_LAYOUT_EVENT_EXPORT_RE = /export const NEKO_MEDIA_LAYOUT_EVENT = "pdpp:neko-media-layout"/;
const NEKO_MEDIA_LAYOUT_EVENT_DISPATCH_RE =
  /window\.dispatchEvent\(new CustomEvent\(NEKO_MEDIA_LAYOUT_EVENT,[\s\S]*?detail[\s\S]*?\)\)/;
const NEKO_MEDIA_LAYOUT_EVENT_LISTENER_RE = /window\.addEventListener\(NEKO_MEDIA_LAYOUT_EVENT,\s*handleMediaLayout\)/;
const NEKO_MEDIA_REFRESH_EPOCH_DEP_RE =
  /mediaRefreshEpoch[\s\S]*?setMediaRefreshEpoch[\s\S]*?\[clientConfig, logDebug, mediaRefreshEpoch, onPresentationViewportReady, viewportInfo\]/;
const NEKO_MEDIA_SETTLE_TARGET_MATCH_RE =
  /nekoMediaSettleTarget,[\s\S]*nekoMediaSettleTargetsMatch,[\s\S]*from "@opendatalabs\/remote-surface\/client"/;
const NEKO_MEDIA_REFRESH_DOES_NOT_RESET_READY_RE =
  /const targetChanged = !nekoMediaSettleTargetsMatch\(mediaSettleTargetRef\.current, target\)[\s\S]*if \(targetChanged\) \{[\s\S]*setMediaReady\(false\);[\s\S]*\} else \{[\s\S]*neko\.media\.settle\.refresh/;
const NEKO_TARGET_CHANGE_PRESERVES_DISPLAYABLE_RE =
  /if \(targetChanged\) \{[\s\S]*firstMediaSampleLoggedRef\.current = false;[\s\S]*setMediaReady\(false\);[\s\S]*\} else \{/;
const NEKO_TARGET_CHANGE_RESETS_DISPLAYABLE_RE =
  /if \(targetChanged\) \{[\s\S]*setMediaDisplayable\(false\)[\s\S]*setMediaReady\(false\);[\s\S]*\} else \{/;
const NEKO_WEBRTC_RECONNECT_CONFIG_RE =
  /NEKO_WEBRTC_RECONNECT_CONFIG[\s\S]*max_reconnects:\s*12[\s\S]*timeout_ms:\s*6000/;
const NEKO_WEBRTC_RECONNECT_CONFIG_APPLIED_RE = /setReconnectorConfig\?\.\("webrtc",\s*NEKO_WEBRTC_RECONNECT_CONFIG\)/;
const NEKO_NATIVE_VIEWPORT_INFO_RE = /toNekoNativeViewportInfo,[\s\S]*from "@opendatalabs\/remote-surface\/client"/;
const NEKO_SURFACE_NATIVE_VIEWPORT_INFO_RE =
  /const nekoViewportInfo = useStableNekoNativeViewportInfo\(\s*!!nekoSession,\s*viewportInfo\s*\)[\s\S]*viewportInfo=\{nekoViewportInfo\}/;
const NEKO_STABLE_NATIVE_VIEWPORT_INFO_RE =
  /function useStableNekoNativeViewportInfo[\s\S]*toNekoNativeViewportInfo\(viewport\)[\s\S]*streamViewportInfosMatch\(stableViewportRef\.current,\s*nextViewport\)/;
const NEKO_PRESENTATION_READY_NATIVE_COMPARE_RE =
  /const currentViewport = nekoNativeViewportRef\.current[\s\S]*toNekoNativeViewportInfo\(viewportInfoRef\.current\)/;
const NEKO_CANONICAL_VIEWPORT_INFO_RE =
  /const setCanonicalViewportInfo = useCallback[\s\S]*viewportInfoRef\.current = nextViewport[\s\S]*setViewportInfo\(nextViewport\)/;
const NEKO_ATTACH_CANONICAL_VIEWPORT_RE =
  /if \(payload\.viewport\) \{[\s\S]*setCanonicalViewportInfo\(payload\.viewport\)/;
const NEKO_BACKEND_READY_NATIVE_CANONICAL_RE =
  /payload\.backend === "neko"[\s\S]*toNekoNativeViewportInfo\(viewportInfoRef\.current\)[\s\S]*neko\.viewport\.native_canonical/;
const NEKO_POST_CANONICAL_VIEWPORT_RE =
  /const viewportInfo = viewportInfoFromPayload\(viewport\);\s*setCanonicalViewportInfo\(viewportInfo\)/;
const NEKO_LOCAL_SURFACE_VIEWPORT_RE =
  /recordLocalSurfaceViewport[\s\S]*viewport\.surface\.local[\s\S]*localSurfaceViewportInfo=\{nekoLocalSurfaceViewportInfo\}/;
const NEKO_POINTER_CAPTURE_HANDLER_RE = /onPointerDownCapture=\{handleLocalStreamGesture\}/;
const NEKO_LOCAL_STREAM_HANDLER_RE = /handleLocalStreamGesture/;
const NEKO_LOCAL_GESTURE_FOCUS_CALL_RE = /focusNekoKeyboardFromLocalGesture\(/;
const NEKO_LOCAL_GESTURE_EXPORT_RE = /export function focusNekoKeyboardFromLocalGesture/;
const NEKO_MOUSE_POINTER_UP_TEXT_FOCUS_RE =
  /type === "pointerup" && pointerType === "mouse" && event\.button === 0[\s\S]*markRemoteInputFocusedAfterMousePointerUp\("pointerup"\)/;
const NEKO_MOUSE_POINTER_UP_REMOTE_FOCUS_ONLY_RE =
  /const markRemoteInputFocusedAfterMousePointerUp[\s\S]*adapter\.setRemoteInputFocused\(true\)[\s\S]*neko\.keyboard_focus\.mouse_pointer_up/;
const NEKO_MOUSE_POINTER_UP_ADAPTER_TEXT_FOCUS_RE =
  /const markRemoteInputFocusedAfterMousePointerUp[\s\S]*adapter\.focusTextInput\(\)[\s\S]*neko\.keyboard_focus\.mouse_pointer_up/;
const NEKO_DOCUMENT_MOUSEUP_FALLBACK_RE =
  /document\.addEventListener\("mouseup",\s*mouseupFallback[\s\S]*document\.removeEventListener\("mouseup",\s*mouseupFallback/;
const NEKO_DOCUMENT_MOUSEUP_CONSTRAINTS_RE =
  /const mouseupFallback = \(event: MouseEvent\)[\s\S]*isCoarsePointer\(\)[\s\S]*event\.button !== 0[\s\S]*mountNode\.contains\(target\)[\s\S]*markRemoteInputFocusedAfterMousePointerUp\("document-mouseup"\)/;
const VIEWER_DIRECT_NEKO_KEYBOARD_CALL_RE = /\b(?:setNekoRemoteInputFocused|focusNekoKeyboard|blurNekoKeyboard)\(/;
const VIEWER_REMOTE_INPUT_FOCUS_VIA_ADAPTER_RE =
  /adapter\.setRemoteInputFocused\(true\)[\s\S]*adapter\.focusTextInput\(\)[\s\S]*adapter\.setRemoteInputFocused\(false\)[\s\S]*adapter\.blurTextInput\(\)/;
const CDP_SURFACE_ADAPTER_IMPORT_RE =
  /CdpClientSurface,[\s\S]*NekoSurfaceAdapter,[\s\S]*from "@opendatalabs\/remote-surface\/client"/;
const CDP_SURFACE_ADAPTER_WIRING_RE =
  /new CdpClientSurface\(\{[\s\S]*cdp: createPdppCdpTransport\(sendCdpInput\)[\s\S]*mediaSink:[\s\S]*getViewportInfo: \(\) => viewportInfoRef\.current[\s\S]*getFrameElement: \(\) => imgRef\.current[\s\S]*getSoftKeyboardElement: \(\) => softKeyboardInputRef\.current/;
const VIEWER_DIRECT_CDP_KEYBOARD_POST_RE = /postInput\(\{[\s\S]*type: "keyboard"/;
const VIEWER_REACT_CDP_KEYBOARD_HANDLER_RE = /onKeyDown=\{\(e\) => handleKey\(e, "keydown"\)\}|function handleKey\(/;
const STREAM_SURFACE_RESOLUTION_POLL_PROP_RE = /pollForResolution\?: boolean/;
const STREAM_SURFACE_RESOLUTION_POLL_GATE_RE =
  /if \(!pollForResolution\) \{\s*return;\s*\}[\s\S]*setInterval\(\(\) => router\.refresh\(\), RESOLUTION_POLL_MS\)/;
const STREAM_PLAYGROUND_RESOLUTION_POLL_DISABLED_RE = /<StreamSurface[\s\S]*pollForResolution=\{false\}/;
const SETTLING_DISPLAYABLE_BLOCK_RE = /if \(displayable && !mediaDisplayableRef\.current\) \{[\s\S]*?\n {8}\}/;
const SET_MEDIA_READY_TRUE_RE = /setMediaReady\(true\)/;
const ON_PRESENTATION_VIEWPORT_READY_RE = /onPresentationViewportReady\(/;
const PLAYGROUND_SEEN_REF_RE =
  /const playgroundSeenRef = useRef<PlaygroundSeenRegistry>\(createPlaygroundSeenRegistry\(\)\);/;
const PLAYGROUND_DEDUPE_IMPORT_RE = /from "\.\/playground-event-dedupe\.ts"/;
const EMIT_PLAYGROUND_EVENTS_CLAIMS_RE =
  /function emitPlaygroundEvents[\s\S]+?claimPlaygroundEvent\(playgroundSeenRef\.current,/;
const DEBUG_DRAIN_GATE_RE = /if \(!debugEnabled\) return;[\s\S]+?fetchNekoStatusBestEffort/;
const DEBUG_DRAIN_DUPLICATE_RE = /claimPlaygroundEvent\(playgroundSeenRef\.current,[\s\S]+?===\s*"duplicate"/;
const DEBUG_DRAIN_CADENCE_RE = /nekoDebugDrainPollMs:\s*250,/;
const DEBUG_DRAIN_TIMEOUT_RE = /setTimeout\(drainOnce, STREAM_VIEWER_POLICY\.nekoDebugDrainPollMs\)/;
const DEBUG_DRAIN_WRONG_CADENCE_RE = /setTimeout\(drainOnce, STREAM_VIEWER_POLICY\.nekoStatusPollMs\)/;
const DEBUG_DRAIN_BLOCK_RE = /Debug-only drain[\s\S]+?\}, \[clientConfig\?\.statusPath, debugEnabled, logDebug\]\);/;
const APPLY_SCREEN_CALL_RE = /applyScreen\(/;
const APPLY_FALLBACK_CALL_RE = /applyFallback\(/;
const FIRST_NEKO_LAYOUT_APPLIED_REF_RE = /firstNekoLayoutAppliedRef/;
const REMOTE_STATUS_POLL_SOURCE_RE = /source:\s*"remote-status-poll"/;
const REMOTE_DEBUG_DRAIN_SOURCE_RE = /source:\s*"remote-debug-drain"/;
const NEKO_NATIVE_VIEWPORT_OPTIONS_RE =
  /const NEKO_NATIVE_VIEWPORT_OPTIONS[\s\S]*deviceScaleFactor:\s*1[\s\S]*highDprCapture:\s*false/;
const READ_STAGE_VIEWPORT_OPTIONS_RE =
  /const readStageViewport = useCallback[\s\S]*nekoNativeViewportRef\.current \? NEKO_NATIVE_VIEWPORT_OPTIONS : \{\}/;
const NEKO_BACKEND_READY_REMEASURE_RE =
  /payload\.backend === "neko"[\s\S]*nekoNativeViewportRef\.current = true[\s\S]*requestViewportMeasureRef\.current\?\.\("neko-backend-ready"\)/;
const READ_STAGE_VIEWPORT_POST_RE = /const viewport = readStageViewport\(width, height\)/;
const READ_STAGE_VIEWPORT_RECT_RE = /const viewport = readStageViewport\(rect\.width, rect\.height\)/;

test("mobile keyboard opens as an overlay only after remote editable focus is confirmed", async () => {
  const [viewerSrc, nekoClientSrc] = await Promise.all([
    readFile(STREAM_VIEWER_FILE, "utf8"),
    readFile(NEKO_CLIENT_FILE, "utf8"),
  ]);
  assert.match(viewerSrc, VIRTUAL_KEYBOARD_OVERLAY_RE);
  assert.match(viewerSrc, VIRTUAL_KEYBOARD_RESTORE_RE);
  assert.match(viewerSrc, KEYBOARD_RESIZE_SUPPRESS_RE);
  assert.match(viewerSrc, PRESENTATION_KEYBOARD_HOLD_RE);
  assert.doesNotMatch(viewerSrc, NEKO_SURFACE_LOCAL_GESTURE_TRIGGER_RE);
  assert.match(nekoClientSrc, LOCAL_GESTURE_REMOTE_FOCUS_RE);
  assert.doesNotMatch(nekoClientSrc, OPTIMISTIC_KEYBOARD_FOCUS_RE);
});

test("touch tap on the n.eko surface no longer opens the soft keyboard optimistically", async () => {
  const [viewerSrc, nekoClientSrc] = await Promise.all([
    readFile(STREAM_VIEWER_FILE, "utf8"),
    readFile(NEKO_CLIENT_FILE, "utf8"),
  ]);
  // Touch must not use local-gesture optimistic focus; otherwise every mobile
  // tap opens the OS keyboard. Fine-pointer mouse clicks may mark remote focus
  // for telemetry/state, but must not focus PDPP's hidden textarea because that
  // steals hardware keyboard focus from n.eko's native overlay path.
  assert.doesNotMatch(viewerSrc, NEKO_POINTER_CAPTURE_HANDLER_RE);
  assert.doesNotMatch(viewerSrc, NEKO_LOCAL_STREAM_HANDLER_RE);
  assert.doesNotMatch(viewerSrc, NEKO_LOCAL_GESTURE_FOCUS_CALL_RE);
  assert.match(viewerSrc, NEKO_MOUSE_POINTER_UP_TEXT_FOCUS_RE);
  assert.match(viewerSrc, NEKO_MOUSE_POINTER_UP_REMOTE_FOCUS_ONLY_RE);
  assert.doesNotMatch(viewerSrc, NEKO_MOUSE_POINTER_UP_ADAPTER_TEXT_FOCUS_RE);
  assert.match(viewerSrc, NEKO_DOCUMENT_MOUSEUP_FALLBACK_RE);
  assert.match(viewerSrc, NEKO_DOCUMENT_MOUSEUP_CONSTRAINTS_RE);
  // The exported helper still exists so the test guarding remote-focus path
  // stays meaningful, but no surface invokes it.
  assert.match(nekoClientSrc, NEKO_LOCAL_GESTURE_EXPORT_RE);
});

test("remote editable focus updates n.eko keyboard state through the RemoteSurface adapter", async () => {
  const viewerSrc = await readFile(STREAM_VIEWER_FILE, "utf8");
  assert.match(viewerSrc, VIEWER_REMOTE_INPUT_FOCUS_VIA_ADAPTER_RE);
  assert.doesNotMatch(viewerSrc, VIEWER_DIRECT_NEKO_KEYBOARD_CALL_RE);
});

test("legacy CDP keyboard and mobile soft-keyboard path is package-backed", async () => {
  const viewerSrc = await readFile(STREAM_VIEWER_FILE, "utf8");
  assert.match(viewerSrc, CDP_SURFACE_ADAPTER_IMPORT_RE);
  assert.match(viewerSrc, CDP_SURFACE_ADAPTER_WIRING_RE);
  assert.doesNotMatch(viewerSrc, VIEWER_DIRECT_CDP_KEYBOARD_POST_RE);
  assert.doesNotMatch(viewerSrc, VIEWER_REACT_CDP_KEYBOARD_HANDLER_RE);
});

test("setNekoViewportLayout receives the live container rect, not the window viewport", async () => {
  const [viewerSrc, nekoClientSrc] = await Promise.all([
    readFile(STREAM_VIEWER_FILE, "utf8"),
    readFile(NEKO_CLIENT_FILE, "utf8"),
  ]);

  // Stage-2 dialog rect must flow through `containerRect` into the layout
  // setter. The container's getBoundingClientRect is the source of truth so
  // the dialog popup size — not document/window dimensions — drives n.eko's
  // selected screen mode.
  assert.match(viewerSrc, NEKO_CONTAINER_RECT_OPTION_RE);
  assert.match(viewerSrc, NEKO_PRESENTATION_CONTAINER_RECT_OPTION_RE);

  // First layout call is gated on the status path being known, so the
  // initial mount no longer falls back to a synthesized window viewport
  // (which previously emitted neko.layout.fallback reason=missing-status-path
  // and selected the wrong screen mode).
  assert.match(viewerSrc, NEKO_LAYOUT_DEFERRED_RE);
  assert.match(viewerSrc, NEKO_LAYOUT_FALLBACK_REASON_RE);
  assert.doesNotMatch(viewerSrc, NEKO_LAYOUT_MISSING_STATUS_PATH_REASON_RE);

  // The duplicate `resize.initial` POST source is gone; ResizeObserver's
  // synchronous initial fire is the single source for the first viewport
  // measurement.
  assert.doesNotMatch(viewerSrc, NEKO_RESIZE_INITIAL_DROPPED_RE);

  // n.eko-side: setNekoViewportLayout accepts the explicit containerRect
  // option and overrides viewportWidth/Height with the live measured rect
  // when provided.
  assert.match(nekoClientSrc, NEKO_VIEWPORT_LAYOUT_OPTIONS_TYPE_RE);
  assert.match(nekoClientSrc, NEKO_CONTAINER_RECT_OVERRIDE_RE);
});

test("n.eko presentation waits for settled media before promoting a resized viewport", async () => {
  const viewerSrc = await readFile(STREAM_VIEWER_FILE, "utf8");

  // A viewport POST may resize the remote browser, but the visible/pointer-
  // mapped presentation must not advance until the WebRTC media reports the
  // new frame is settled. Otherwise stale portrait/landscape media is stretched
  // into the new local box and produces the tiny-content / cursor-offset class
  // of regressions seen in telemetry.
  assert.match(viewerSrc, NEKO_PRESENTATION_PENDING_RE);
  assert.match(viewerSrc, NEKO_PRESENTATION_REMOTE_READY_RE);
  assert.match(viewerSrc, NEKO_PRESENTATION_DEGRADED_SKIP_RE);
  assert.match(viewerSrc, NEKO_LAYOUT_DEFERRED_PRESENTATION_RE);
  assert.match(viewerSrc, NEKO_LOCAL_SURFACE_VIEWPORT_RE);
  assert.match(viewerSrc, NEKO_LOADING_OVERLAY_STABLE_PRESENTATION_RE);
  assert.match(viewerSrc, NEKO_STABLE_PRESENTATION_CONTAINER_RECT_RE);
  assert.match(viewerSrc, NEKO_LOADING_OVERLAY_CLASS_RE);
  assert.match(viewerSrc, NEKO_LOADING_OVERLAY_DATA_ATTR_RE);
  assert.match(viewerSrc, NEKO_DEGRADED_MEDIA_DISPLAYABLE_RE);
  assert.match(viewerSrc, NEKO_SETTLING_MEDIA_DISPLAYABLE_RE);
  assert.match(viewerSrc, NEKO_VISUAL_QUALITY_IGNORES_OCCLUDED_MEDIA_RE);
  assert.doesNotMatch(viewerSrc, NEKO_PRESENTATION_IMMEDIATE_POST_PROMOTION_RE);
  assert.doesNotMatch(viewerSrc, NEKO_PRESENTATION_DEGRADED_PROMOTE_RE);
  assert.doesNotMatch(viewerSrc, NEKO_PRESENTATION_EARLY_MEDIA_READY_RE);
  const displayableBlock = viewerSrc.match(SETTLING_DISPLAYABLE_BLOCK_RE)?.[0] ?? "";
  assert.ok(displayableBlock.length > 0, "settling displayable block is identifiable");
  assert.doesNotMatch(displayableBlock, SET_MEDIA_READY_TRUE_RE);
  assert.doesNotMatch(displayableBlock, ON_PRESENTATION_VIEWPORT_READY_RE);
});

test("n.eko WebRTC startup can recover after slow media attach or ICE retry", async () => {
  const [viewerSrc, nekoClientSrc] = await Promise.all([
    readFile(STREAM_VIEWER_FILE, "utf8"),
    readFile(NEKO_CLIENT_FILE, "utf8"),
  ]);

  // Successful Android starts in telemetry commonly attach video after ~3.5s.
  // The settle window must exceed that, otherwise the matte can remain stuck
  // even after n.eko's WebRTC retry eventually paints a video frame.
  assert.match(viewerSrc, NEKO_MEDIA_SETTLE_LONG_STARTUP_WINDOW_RE);
  assert.match(nekoClientSrc, NEKO_MEDIA_LAYOUT_EVENT_EXPORT_RE);
  assert.match(nekoClientSrc, NEKO_MEDIA_LAYOUT_EVENT_DISPATCH_RE);
  assert.match(viewerSrc, NEKO_MEDIA_LAYOUT_EVENT_LISTENER_RE);
  assert.match(viewerSrc, NEKO_MEDIA_REFRESH_EPOCH_DEP_RE);
  assert.match(viewerSrc, NEKO_MEDIA_SETTLE_TARGET_MATCH_RE);
  assert.match(viewerSrc, NEKO_MEDIA_REFRESH_DOES_NOT_RESET_READY_RE);
  assert.match(viewerSrc, NEKO_TARGET_CHANGE_PRESERVES_DISPLAYABLE_RE);
  assert.doesNotMatch(viewerSrc, NEKO_TARGET_CHANGE_RESETS_DISPLAYABLE_RE);

  // n.eko's default WebRTC reconnect timeout is 1.5s. In this deployment the
  // client may need TURN/LAN candidate negotiation, so PDPP applies a less
  // aggressive reconnect policy through n.eko's public API instead of
  // replacing n.eko's own reconnection machinery.
  assert.match(nekoClientSrc, NEKO_WEBRTC_RECONNECT_CONFIG_RE);
  assert.match(nekoClientSrc, NEKO_WEBRTC_RECONNECT_CONFIG_APPLIED_RE);
  assert.match(viewerSrc, NEKO_NATIVE_VIEWPORT_INFO_RE);
  assert.match(viewerSrc, NEKO_STABLE_NATIVE_VIEWPORT_INFO_RE);
  assert.match(viewerSrc, NEKO_SURFACE_NATIVE_VIEWPORT_INFO_RE);
  assert.match(viewerSrc, NEKO_PRESENTATION_READY_NATIVE_COMPARE_RE);
  assert.match(viewerSrc, NEKO_CANONICAL_VIEWPORT_INFO_RE);
  assert.match(viewerSrc, NEKO_ATTACH_CANONICAL_VIEWPORT_RE);
  assert.match(viewerSrc, NEKO_BACKEND_READY_NATIVE_CANONICAL_RE);
  assert.match(viewerSrc, NEKO_POST_CANONICAL_VIEWPORT_RE);
});

test("stream viewer drains remote playground.* events when stream_debug=1, with page-scoped dedupe against the layout poll", async () => {
  // Closes the user-reported gap: "I tapped four beacons, then the
  // layout changed and they vanished." Beacons 1-4 fired during the
  // layout poll and were drained; subsequent taps fired into the
  // remote ring buffer with nobody reading. The fix is a debug-only
  // continuous drain that polls statusPath after the layout settles,
  // gated on `?stream_debug=1`, deduped via a shared pageId+seq
  // registry.
  const viewerSrc = await readFile(STREAM_VIEWER_FILE, "utf8");
  // The dedupe registry must live at NekoSurface scope (not inside a
  // useEffect), so both the layout-poll path and the debug-drain
  // path can reach it. The actual dedupe semantics live in a pure
  // helper module so they're testable without React state.
  assert.match(
    viewerSrc,
    PLAYGROUND_SEEN_REF_RE,
    "playgroundSeenRef declared at component scope using the pure helper module"
  );
  assert.match(viewerSrc, PLAYGROUND_DEDUPE_IMPORT_RE, "stream-viewer imports the dedupe helper from its own module");
  // Both poll paths must claim events through the same helper. The
  // helper must compose seq with pageId so a remote page reload
  // (seq restart at 1) does not collide with already-seen keys.
  assert.match(viewerSrc, EMIT_PLAYGROUND_EVENTS_CLAIMS_RE, "layout poll claims events through claimPlaygroundEvent");
  // The debug-drain useEffect must exist, gate on debugEnabled, reuse
  // fetchNekoStatusBestEffort, and use claimPlaygroundEvent for dedupe.
  assert.match(
    viewerSrc,
    DEBUG_DRAIN_GATE_RE,
    "debug drain gated on debugEnabled and reuses fetchNekoStatusBestEffort"
  );
  assert.match(viewerSrc, DEBUG_DRAIN_DUPLICATE_RE, "debug drain rejects duplicates via claimPlaygroundEvent");
  // The debug drain must NOT poll at the layout-poll cadence (50 ms);
  // a tighter cadence would perturb UX even though it's debug-only.
  // 250 ms is fast enough that a human-perceived tap reaches the
  // operator's JSONL well under a second.
  assert.match(
    viewerSrc,
    DEBUG_DRAIN_CADENCE_RE,
    "debug drain has a dedicated 250ms cadence (not the 50ms layout-poll cadence)"
  );
  assert.match(viewerSrc, DEBUG_DRAIN_TIMEOUT_RE, "debug drain useEffect uses nekoDebugDrainPollMs");
  assert.doesNotMatch(
    viewerSrc,
    DEBUG_DRAIN_WRONG_CADENCE_RE,
    "debug drain useEffect must NOT reuse the 50ms layout-poll cadence"
  );
  // The debug-drain path must NOT call applyScreen / applyFallback /
  // mark firstNekoLayoutAppliedRef — it is observation-only.
  const drainBlock = viewerSrc.match(DEBUG_DRAIN_BLOCK_RE)?.[0] ?? "";
  assert.ok(drainBlock.length > 0, "debug-drain useEffect block is identifiable");
  assert.doesNotMatch(drainBlock, APPLY_SCREEN_CALL_RE, "debug drain must not call applyScreen");
  assert.doesNotMatch(drainBlock, APPLY_FALLBACK_CALL_RE, "debug drain must not call applyFallback");
  assert.doesNotMatch(drainBlock, FIRST_NEKO_LAYOUT_APPLIED_REF_RE, "debug drain must not mark first-layout flag");
  // Source field on emitted events must distinguish the two paths so
  // the operator can tell which poll surfaced a given event.
  assert.match(viewerSrc, REMOTE_STATUS_POLL_SOURCE_RE, "layout poll tags events as remote-status-poll");
  assert.match(viewerSrc, REMOTE_DEBUG_DRAIN_SOURCE_RE, "debug drain tags events as remote-debug-drain");
});

test("n.eko follow-up viewport posts use native one-to-one coordinates", async () => {
  const viewerSrc = await readFile(STREAM_VIEWER_FILE, "utf8");

  assert.match(
    viewerSrc,
    NEKO_NATIVE_VIEWPORT_OPTIONS_RE,
    "n.eko viewport options force a CSS-pixel native coordinate space"
  );
  assert.match(
    viewerSrc,
    READ_STAGE_VIEWPORT_OPTIONS_RE,
    "stage viewport reads switch to n.eko native options after backend_ready"
  );
  assert.match(
    viewerSrc,
    NEKO_BACKEND_READY_REMEASURE_RE,
    "n.eko backend_ready immediately remeasures/reposts using native viewport options"
  );
  assert.match(viewerSrc, READ_STAGE_VIEWPORT_POST_RE, "viewport POST path uses readStageViewport");
  assert.match(viewerSrc, READ_STAGE_VIEWPORT_RECT_RE, "resize/presentation paths use readStageViewport");
});

test("stream pages ask the browser to overlay the keyboard instead of resizing the viewport", async () => {
  const [streamPage, playgroundPage, globalCss] = await Promise.all([
    readFile(STREAM_PAGE_FILE, "utf8"),
    readFile(STREAM_PLAYGROUND_PAGE_FILE, "utf8"),
    readFile(GLOBAL_CSS_FILE, "utf8"),
  ]);

  for (const src of [streamPage, playgroundPage]) {
    assert.match(src, INTERACTIVE_WIDGET_OVERLAY_RE);
    assert.doesNotMatch(src, INTERACTIVE_WIDGET_RESIZES_VISUAL_RE);
  }
  assert.match(globalCss, STREAM_DIALOG_SVH_RE);
  assert.doesNotMatch(globalCss, STREAM_DIALOG_LVH_RE);
  assert.doesNotMatch(globalCss, STREAM_DIALOG_DVH_RE);
});

test("stream playground disables real-run resolution polling during active n.eko sessions", async () => {
  const [viewerSrc, playgroundPage] = await Promise.all([
    readFile(STREAM_VIEWER_FILE, "utf8"),
    readFile(STREAM_PLAYGROUND_PAGE_FILE, "utf8"),
  ]);

  assert.match(viewerSrc, STREAM_SURFACE_RESOLUTION_POLL_PROP_RE);
  assert.match(viewerSrc, STREAM_SURFACE_RESOLUTION_POLL_GATE_RE);
  assert.match(playgroundPage, STREAM_PLAYGROUND_RESOLUTION_POLL_DISABLED_RE);
});
