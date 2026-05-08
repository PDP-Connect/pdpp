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
const OPTIMISTIC_KEYBOARD_FOCUS_RE =
  /local-gesture-optimistic|coarse-pointer-optimistic|neko\.keyboard_focus\.optimistic_rollback/;
const INTERACTIVE_WIDGET_OVERLAY_RE = /interactiveWidget:\s*"overlays-content"/;
const INTERACTIVE_WIDGET_RESIZES_VISUAL_RE = /interactiveWidget:\s*"resizes-visual"/;
const STREAM_DIALOG_SVH_RE = /\.pdpp-stream-dialog[\s\S]*100svh/;
const STREAM_DIALOG_LVH_RE = /\.pdpp-stream-dialog[\s\S]*100lvh/;
const STREAM_DIALOG_DVH_RE = /\.pdpp-stream-dialog[\s\S]*100dvh/;

test("mobile keyboard opens as an overlay only after remote editable focus is confirmed", async () => {
  const [viewerSrc, nekoClientSrc] = await Promise.all([
    readFile(STREAM_VIEWER_FILE, "utf8"),
    readFile(NEKO_CLIENT_FILE, "utf8"),
  ]);
  assert.match(viewerSrc, VIRTUAL_KEYBOARD_OVERLAY_RE);
  assert.match(viewerSrc, VIRTUAL_KEYBOARD_RESTORE_RE);
  assert.match(viewerSrc, KEYBOARD_RESIZE_SUPPRESS_RE);
  assert.match(viewerSrc, PRESENTATION_KEYBOARD_HOLD_RE);
  assert.match(nekoClientSrc, LOCAL_GESTURE_REMOTE_FOCUS_RE);
  assert.doesNotMatch(nekoClientSrc, OPTIMISTIC_KEYBOARD_FOCUS_RE);
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
