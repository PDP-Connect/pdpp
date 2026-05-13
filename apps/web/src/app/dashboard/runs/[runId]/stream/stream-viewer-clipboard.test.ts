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
  /!currentClipboardPolicy\.canForwardNativePasteEvent[\s\S]*reason: "policy-denied"[\s\S]*event\.clipboardData\?\.getData\("text"\)/;
const PASSWORD_INPUT_RE = /inputType === "password"/;
const MASKED_LOCAL_INPUT_RE = /remoteInputSensitive && !revealLocalText/;
const MASKED_ATTRIBUTE_RE = /data-masked=\{localInputMasked \? "true" : "false"\}/;
const SESSION_CLIPBOARD_CLEANUP_RE =
  /setClipboardSheetOpen\(false\);[\s\S]*setRemoteClipboard\(null\);[\s\S]*setRemoteInputSensitive\(false\);/;
const POLICY_CLIPBOARD_SHEET_CLOSE_RE =
  /if \(!clipboardPolicy\.showClipboardSheet\) \{[\s\S]*setClipboardSheetOpen\(false\);[\s\S]*\}/;
const POLICY_CLIPBOARD_SHEET_RENDER_RE =
  /nekoSession && clipboardPolicy\.showClipboardSheet \? \([\s\S]*<ClipboardSheet/;
const CORNER_PASTE_OPENS_SHEET_RE =
  /const handleMobilePaste = useCallback\(\(\) => \{[\s\S]*phase: "open-sheet"[\s\S]*setClipboardSheetOpen\(true\)/;
const CORNER_PASTE_ARIA_RE = /aria-label=\{`Open paste controls for \$\{connectorName\} browser`\}/;
const CORNER_PASTE_DIRECT_READ_RE =
  /const handleMobilePaste = useCallback\(\(\) => \{[\s\S]*pasteLocalClipboardIntoNeko/;
const VIEWER_DIRECT_NEKO_CLIPBOARD_CALL_RE = /\b(?:pasteTextIntoNeko|copyRemoteSelectionFromNeko)\(/;
const VIEWER_CLIPBOARD_VIA_ADAPTER_RE =
  /if \(surface && surfaceState === "mounted"\) \{[\s\S]*pasted = await surface\.pasteText\(localText\)[\s\S]*if \(surface && surfaceState === "mounted"\) \{[\s\S]*dispatched = await surface\.copyRemoteSelection\(\)/;

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

test("explicit n.eko clipboard commands route through the RemoteSurface adapter", async () => {
  const src = await readFile(STREAM_VIEWER_FILE, "utf8");
  assert.match(src, VIEWER_CLIPBOARD_VIA_ADAPTER_RE);
  assert.doesNotMatch(src, VIEWER_DIRECT_NEKO_CLIPBOARD_CALL_RE);
});
