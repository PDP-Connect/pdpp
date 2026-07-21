import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type {
  NekoRemoteSurfaceSession,
  NekoSurfaceAdapter,
  RemoteSurfaceViewerHandle,
} from "@opendatalabs/remote-surface/client";
import { getMountedNekoViewerSession } from "./stream-viewer-session-readiness.ts";

const VIEWER_FILE = fileURLToPath(new URL("./stream-viewer.tsx", import.meta.url));
const SESSION_FOCUS_RE = /function focusNekoKeyboardProxy[\s\S]*session\.focusKeyboard\(\)/;
const TRUSTED_TAP_SESSION_FOCUS_RE =
  /focusNekoKeyboardProxy\(viewerRef\.current, nekoSurfaceAdapterRef\.current, mountNode\)/;
const AWAIT_RE = /\bawait\b/;
const Neko_SESSION_PARAMETER_RE = /session: NekoRemoteSurfaceSession \| null/;
const SESSION_COPY_RE = /await session\.copyRemoteSelection\(\)/;
const TYPED_SHEET_PASTE_RE = /await surface\.pasteText\(localText\)/;
const TYPED_SHEET_ADAPTER_RE = /sendSheetTextToBrowser\([\s\S]*surface: getSurface\(\)/;
const VIEWPORT_DIAGNOSTIC_RE = /const handleViewerDiagnostic = useCallback/;
const VIEWPORT_DIAGNOSTIC_WIRING_RE = /onDiagnostic: handleViewerDiagnostic/;
const VIEWPORT_ERROR_STATE_RE = /viewerRef\.current\?\.getViewportState\(\) === "error"/;
const VIEWPORT_ERROR_AFFORDANCE_RE = /setError\("The secure browser viewport could not be applied\."\)/;
const INLINE_ERROR_PANEL_RE = /The n\.eko WebRTC stream did not attach\./;
const INLINE_ERROR_RETRY_RE = /Retry secure browser/;
const PRESENTATION_ATTACHMENT_GATE_RE =
  /if \(!presentationAttachmentReadyRef\.current\) \{[\s\S]{0,450}viewport\.skip\.awaiting-presentation-attachment/;
const PRESENTATION_ATTACHMENT_AFTER_SSE_RE =
  /onAttached: \(\) => \{[\s\S]{0,350}presentationAttachmentReadyRef\.current = true;[\s\S]{0,350}requestViewportMeasureRef\.current\?\.\("stream-attached"\)/;
const SAME_ORIGIN_VIEWPORT_CREDENTIALS_RE = /viewport\.post\.start[\s\S]{0,1400}credentials: "same-origin"/;
const SAME_ORIGIN_INPUT_CREDENTIALS_RE = /const sendCdpInput = useCallback[\s\S]{0,2000}credentials: "same-origin"/;
const SAME_ORIGIN_COPY_CREDENTIALS_RE = /neko\.clipboard_remote_to_local[\s\S]{0,1800}credentials: "same-origin"/;
const ATTACHED_BROWSER_SESSION_BOUNDARY_RE =
  /beginPresentationSession\([\s\S]*?browserSessionId: browserSessionIdRef\.current[\s\S]*?payload\.browser_session_id[\s\S]*?if \(presentationSession\.reset\) \{[\s\S]*?resetPresentationForBrowserSession\(\)/;
const NEKO_BROWSER_SESSION_KEY_RE = /<NekoSurface[\s\S]*?key=\{nekoSession\.browserSessionId\}/;

function readViewerSource(): Promise<string> {
  return readFile(VIEWER_FILE, "utf8");
}

test("trusted-touch keyboard focus reaches the viewer session synchronously", async () => {
  const src = await readViewerSource();
  const tapStart = src.indexOf("const handleMobileKeyboardPointer =");
  const tapEnd = src.indexOf("const remoteTypeFor =", tapStart);
  const trustedTap = src.slice(tapStart, tapEnd);

  assert.notEqual(tapStart, -1, "the production trusted-touch handler is present");
  assert.notEqual(tapEnd, -1, "the trusted-touch handler has a bounded source block");
  assert.match(src, SESSION_FOCUS_RE);
  assert.match(trustedTap, TRUSTED_TAP_SESSION_FOCUS_RE);
  assert.doesNotMatch(trustedTap, AWAIT_RE, "a trusted tap must not cross an async boundary before focus");
});

test("mounted browser-selection copy uses the session while typed sheet paste stays console-owned", async () => {
  const src = await readViewerSource();
  const copyStart = src.indexOf("async function requestBrowserCopyFromSheet");
  const copyEnd = src.indexOf("function ClipboardSheet", copyStart);
  const copyPath = src.slice(copyStart, copyEnd);
  const pasteStart = src.indexOf("async function sendSheetTextToBrowser");
  const pasteEnd = src.indexOf("async function copySheetTextToDevice", pasteStart);
  const typedPastePath = src.slice(pasteStart, pasteEnd);

  assert.match(copyPath, Neko_SESSION_PARAMETER_RE);
  assert.match(copyPath, SESSION_COPY_RE);
  assert.match(typedPastePath, TYPED_SHEET_PASTE_RE);
  assert.match(src, TYPED_SHEET_ADAPTER_RE);

  let adapterState: ReturnType<NekoSurfaceAdapter["getLifecycleState"]> = "idle";
  let copyCalls = 0;
  let focusCalls = 0;
  const session = {
    copyRemoteSelection: () => {
      copyCalls += 1;
      return Promise.resolve(true);
    },
    focusKeyboard: () => {
      focusCalls += 1;
    },
    getViewportState: () => "ready",
  } as unknown as NekoRemoteSurfaceSession;
  const viewer = {
    getLifecycleState: () => "mounted",
    getSession: () => session,
  } as RemoteSurfaceViewerHandle;
  const adapter = {
    getLifecycleState: () => adapterState,
  } as Pick<NekoSurfaceAdapter, "getLifecycleState">;

  assert.equal(getMountedNekoViewerSession(viewer, adapter), null);
  assert.doesNotThrow(() => getMountedNekoViewerSession(viewer, adapter)?.focusKeyboard());
  assert.equal(await (getMountedNekoViewerSession(viewer, adapter)?.copyRemoteSelection() ?? false), false);
  assert.equal(focusCalls, 0);
  assert.equal(copyCalls, 0);

  adapterState = "mounted";
  const readySession = getMountedNekoViewerSession(viewer, adapter);
  assert.equal(readySession, session);
  readySession.focusKeyboard();
  assert.equal(await readySession.copyRemoteSelection(), true);
  assert.equal(focusCalls, 1);
  assert.equal(copyCalls, 1);
});

test("viewer viewport errors render the existing retryable inline stream error", async () => {
  const src = await readViewerSource();
  const diagnosticStart = src.indexOf("const handleViewerDiagnostic = useCallback");
  const diagnosticEnd = src.indexOf("useSurfaceDebugTelemetry", diagnosticStart);
  const diagnosticHandler = src.slice(diagnosticStart, diagnosticEnd);

  assert.match(diagnosticHandler, VIEWPORT_DIAGNOSTIC_RE);
  assert.match(src, VIEWPORT_DIAGNOSTIC_WIRING_RE);
  assert.match(diagnosticHandler, VIEWPORT_ERROR_STATE_RE);
  assert.match(diagnosticHandler, VIEWPORT_ERROR_AFFORDANCE_RE);
  assert.match(src, INLINE_ERROR_PANEL_RE);
  assert.match(src, INLINE_ERROR_RETRY_RE);
});

test("viewport changes wait for the SSE controller attachment and send its same-origin cookie", async () => {
  const src = await readViewerSource();

  // The route keeps its controller-only check. The viewer must therefore not
  // issue the initial ResizeObserver write until the SSE response has set the
  // HttpOnly controller attachment cookie, then it remeasures once.
  assert.match(src, PRESENTATION_ATTACHMENT_GATE_RE);
  assert.match(src, PRESENTATION_ATTACHMENT_AFTER_SSE_RE);
  assert.match(src, SAME_ORIGIN_VIEWPORT_CREDENTIALS_RE);
  assert.match(src, SAME_ORIGIN_INPUT_CREDENTIALS_RE);
  assert.match(src, SAME_ORIGIN_COPY_CREDENTIALS_RE);
});

test("browser-session replacement clears presentation state and remounts n.eko, while same-session reconnects do not", async () => {
  const src = await readViewerSource();

  // The pure reducer covers equal versus different IDs. These assertions bind
  // that decision to the actual SSE attachment and React remount path.
  assert.match(src, ATTACHED_BROWSER_SESSION_BOUNDARY_RE);
  assert.match(src, NEKO_BROWSER_SESSION_KEY_RE);
});
