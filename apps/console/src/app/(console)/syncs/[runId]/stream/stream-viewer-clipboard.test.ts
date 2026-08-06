// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const STREAM_VIEWER_FILE = `${HERE}stream-viewer.tsx`;
const SHOW_CLIPBOARD_SHEET_RE = /showClipboardSheet/;
const CLIPBOARD_SHEET_RE = /<ClipboardSheet/;
const SHOW_MOBILE_COPY_RE = /showMobileCopyButton/;
const SHOW_MOBILE_PASTE_RE = /showMobilePasteButton/;
const COPY_BROWSER_SELECTION_RE = /Copy browser selection/;
const MOBILE_SSE_BUFFER_RE = /currentClipboardPolicy\.surface === "mobile-sheet"[\s\S]*setRemoteClipboard/;
const BUFFERED_PHASE_RE = /phase: "buffered"/;
const BUFFERED_TOAST_NOTICE_RE =
  /CLIPBOARD_NOTICE_TIMEOUT_MS[\s\S]*clipboardNoticeOpen[\s\S]*<ClipboardNoticeToast \/>/;
const BUFFERED_TOAST_TEXT_RE = /Copy ready\./;
const CLICKABLE_TOAST_RE = /<button|onClick|Copy to this device/;
const POLICY_WRITE_GUARD_RE = /!currentClipboardPolicy\.canWriteLocalClipboard[\s\S]*reason: "write-unavailable"/;
const WRITE_TEXT_RE = /navigator\.clipboard\.writeText\(text\)/;
const NATIVE_PASTE_POLICY_GUARD_RE =
  /getClipboardPolicy: \(\) => \{[\s\S]*canForwardNativePasteEvent: policy\.canForwardNativePasteEvent/;
const PASSWORD_INPUT_RE = /inputType === "password"/;
const MASKED_LOCAL_INPUT_RE = /remoteInputSensitive && !revealLocalText/;
const MASKED_ATTRIBUTE_RE = /data-masked=\{localInputMasked \? "true" : "false"\}/;
const SESSION_CLIPBOARD_CLEANUP_RE =
  /setClipboardSheetOpen\(false\);[\s\S]*setRemoteClipboard\(null\);[\s\S]*setRemoteInputSensitive\(false\);/;
const POLICY_CLIPBOARD_SHEET_CLOSE_RE =
  /if \(!clipboardPolicy\.showClipboardSheet\) \{[\s\S]*setClipboardSheetOpen\(false\);[\s\S]*\}/;
const POLICY_CLIPBOARD_SHEET_RENDER_RE =
  /\(nekoSession \|\| mountedCdpSurface\) && clipboardPolicy\.showClipboardSheet \? \([\s\S]*<ClipboardSheet/;
const CORNER_PASTE_OPENS_SHEET_RE =
  /const handleMobilePaste = useCallback\(\(\) => \{[\s\S]*phase: "open-sheet"[\s\S]*setClipboardSheetOpen\(true\)/;
const CORNER_PASTE_ARIA_RE = /aria-label=\{`Open paste controls for \$\{connectorName\} browser`\}/;
const CORNER_PASTE_DIRECT_READ_RE =
  /const handleMobilePaste = useCallback\(\(\) => \{[\s\S]*pasteLocalClipboardIntoNeko/;
const VIEWER_DIRECT_NEKO_CLIPBOARD_CALL_RE = /\b(?:pasteTextIntoNeko|copyRemoteSelectionFromNeko)\(/;
const VIEWER_CLIPBOARD_MECHANISM_SPLIT_RE =
  /if \(surface && surfaceState === "mounted"\) \{[\s\S]*pasted = await surface\.pasteText\(localText\)[\s\S]*if \(session && surfaceState === "mounted"\) \{[\s\S]*dispatched = await session\.copyRemoteSelection\(\)/;
const CDP_NATIVE_PASTE_VIA_ADAPTER_RE =
  /new CdpClientSurface\(\{[\s\S]*cdp: createPdppCdpTransport\(sendCdpInput\)[\s\S]*getClipboardPolicy: \(\) => \{[\s\S]*canForwardNativePasteEvent:[\s\S]*canReadRemoteSelection:/;
const CDP_COPY_SINK_RE =
  /clipboardSink: \{[\s\S]*writeText\(text\) \{[\s\S]*writeCdpClipboardToDevice\([\s\S]*onWriteFailure: onRemoteClipboardRef\.current[\s\S]*writeText: clipboard\?\.writeText/;
const CDP_COPY_USES_ADAPTER_RE = /session: mountedSurfaceForBackend\(\s*\n\s*readyBackend,[\s\S]*mountedCdpSurface/;
const VIEWER_DIRECT_CDP_PASTE_POST_RE = /postInput\(\{ type: "paste", text \}\)/;
const PASTE_FAILS_CLOSED_MISSING_URL_RE =
  /const isPaste = payload\.type === "paste";[\s\S]{0,200}if \(!url\) \{[\s\S]*if \(isPaste\) \{[\s\S]*throw new Error\("Cannot send paste input: no active stream input URL"\);/;
const PASTE_FAILS_CLOSED_NON_OK_RE =
  /if \(isPaste && !response\.ok\) \{[\s\S]*throw new Error\(`Paste input rejected by server: \$\{response\.status\}`\);/;
const PASTE_FAILS_CLOSED_CATCH_RETHROW_RE = /\} catch \(err\) \{[\s\S]{0,300}if \(isPaste\) \{[\s\S]*throw err;/;
const NON_PASTE_STAYS_NON_FATAL_RE = /a single dropped non-paste input is non-fatal/;
const SEND_SHEET_TEXT_CATCHES_PASTE_REJECTION_RE =
  /try \{[\s\S]{0,40}pasted = await surface\.pasteText\(localText\);[\s\S]{0,40}\} catch \(err\) \{[\s\S]*pasteError = err;/;

test("mobile clipboard uses explicit copy and paste buttons with sheet fallback", async () => {
  const src = await readFile(STREAM_VIEWER_FILE, "utf8");
  assert.match(src, SHOW_CLIPBOARD_SHEET_RE);
  assert.match(src, CLIPBOARD_SHEET_RE);
  assert.match(src, SHOW_MOBILE_COPY_RE);
  assert.match(src, SHOW_MOBILE_PASTE_RE);
  assert.match(src, COPY_BROWSER_SELECTION_RE);
});

test("remote clipboard SSE buffers mobile text before device clipboard write", async () => {
  const src = await readFile(STREAM_VIEWER_FILE, "utf8");
  assert.match(src, MOBILE_SSE_BUFFER_RE);
  assert.match(src, BUFFERED_PHASE_RE);
  assert.match(src, BUFFERED_TOAST_NOTICE_RE);
  assert.match(src, BUFFERED_TOAST_TEXT_RE);
  const toastBody = src.slice(src.indexOf("function ClipboardNoticeToast()"), src.indexOf("type ClipboardCopyState"));
  assert.doesNotMatch(toastBody, CLICKABLE_TOAST_RE);
  assert.match(src, POLICY_WRITE_GUARD_RE);
  assert.match(src, WRITE_TEXT_RE);
});

test("native paste forwarding is gated by clipboard policy before reading event data", async () => {
  const src = await readFile(STREAM_VIEWER_FILE, "utf8");
  assert.match(src, NATIVE_PASTE_POLICY_GUARD_RE);
});

test("password-like remote focus masks local paste preview by default", async () => {
  const src = await readFile(STREAM_VIEWER_FILE, "utf8");
  assert.match(src, PASSWORD_INPUT_RE);
  assert.match(src, MASKED_LOCAL_INPUT_RE);
  assert.match(src, MASKED_ATTRIBUTE_RE);
});

test("session reset clears clipboard sheet state and buffered clipboard text", async () => {
  const src = await readFile(STREAM_VIEWER_FILE, "utf8");
  assert.match(src, SESSION_CLIPBOARD_CLEANUP_RE);
});

test("clipboard sheet closes and unmounts when policy leaves mobile-sheet mode", async () => {
  const src = await readFile(STREAM_VIEWER_FILE, "utf8");
  assert.match(src, POLICY_CLIPBOARD_SHEET_CLOSE_RE);
  assert.match(src, POLICY_CLIPBOARD_SHEET_RENDER_RE);
});

test("mobile paste corner control opens the explicit sheet instead of silently direct-pasting", async () => {
  const src = await readFile(STREAM_VIEWER_FILE, "utf8");
  assert.match(src, CORNER_PASTE_OPENS_SHEET_RE);
  assert.match(src, CORNER_PASTE_ARIA_RE);
  assert.doesNotMatch(src, CORNER_PASTE_DIRECT_READ_RE);
});

test("selection copy routes through the viewer session while typed sheet paste stays on the adapter", async () => {
  const src = await readFile(STREAM_VIEWER_FILE, "utf8");
  assert.match(src, VIEWER_CLIPBOARD_MECHANISM_SPLIT_RE);
  assert.doesNotMatch(src, VIEWER_DIRECT_NEKO_CLIPBOARD_CALL_RE);
});

test("native CDP paste forwarding is package-backed", async () => {
  const src = await readFile(STREAM_VIEWER_FILE, "utf8");
  assert.match(src, CDP_NATIVE_PASTE_VIA_ADAPTER_RE);
  assert.match(src, CDP_COPY_SINK_RE);
  assert.match(src, CDP_COPY_USES_ADAPTER_RE);
  assert.doesNotMatch(src, VIEWER_DIRECT_CDP_PASTE_POST_RE);
});

test("sendCdpInput fails closed for paste-typed payloads on missing URL, fetch rejection, and non-2xx — but not for other input types", async () => {
  const src = await readFile(STREAM_VIEWER_FILE, "utf8");
  assert.match(src, PASTE_FAILS_CLOSED_MISSING_URL_RE);
  assert.match(src, PASTE_FAILS_CLOSED_NON_OK_RE);
  assert.match(src, PASTE_FAILS_CLOSED_CATCH_RETHROW_RE);
  assert.match(src, NON_PASTE_STAYS_NON_FATAL_RE);
});

test("sendSheetTextToBrowser treats a CdpClientSurface.pasteText() rejection as pasted=false, not an unhandled rejection", async () => {
  const src = await readFile(STREAM_VIEWER_FILE, "utf8");
  assert.match(src, SEND_SHEET_TEXT_CATCHES_PASTE_REJECTION_RE);
});
