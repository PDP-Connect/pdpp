import assert from "node:assert/strict";
import test from "node:test";
import {
  parseBackendReadyMessage,
  parseClipboardMessage,
  parseFrameMessage,
  parseKeyboardFocusMessage,
  parsePopupClosedMessage,
  parsePopupOpenedMessage,
  parseStreamErrorMessage,
  parseUrlChangedMessage,
} from "@opendatalabs/remote-surface/protocol";
import { parseAttachedMessage } from "./stream-viewer-protocol.ts";

test("parseAttachedMessage validates scope and viewport shape", () => {
  assert.deepEqual(
    parseAttachedMessage(
      JSON.stringify({
        browser_session_id: "browser-1",
        interaction_id: "interaction-1",
        run_id: "run-1",
        viewport: { width: 390.9, height: 844.2 },
      })
    ),
    {
      ok: true,
      value: {
        browser_session_id: "browser-1",
        interaction_id: "interaction-1",
        run_id: "run-1",
        viewport: { width: 390, height: 844 },
      },
    }
  );

  assert.deepEqual(parseAttachedMessage("{"), { error: "payload_invalid_json", ok: false });
  for (const viewport of [
    { width: 0, height: 844 },
    { width: 0.9, height: 844 },
  ]) {
    assert.deepEqual(
      parseAttachedMessage(
        JSON.stringify({
          browser_session_id: "browser-1",
          interaction_id: "interaction-1",
          run_id: "run-1",
          viewport,
        })
      ),
      { error: "viewport_invalid_dimensions", ok: false }
    );
  }
});

test("parseFrameMessage validates non-empty frame payload and sanitizes metadata", () => {
  assert.deepEqual(
    parseFrameMessage(
      JSON.stringify({
        data_base64: "abc",
        metadata: { device_width: 800, device_height: 600, ignored: true },
        session_id: 7,
      })
    ),
    {
      ok: true,
      value: {
        data_base64: "abc",
        metadata: { device_width: 800, device_height: 600 },
        session_id: 7,
      },
    }
  );

  assert.deepEqual(parseFrameMessage(JSON.stringify({ data_base64: "" })), {
    error: "data_base64_missing",
    ok: false,
  });
});

test("parseBackendReadyMessage keeps backend extensible while validating paths", () => {
  assert.deepEqual(
    parseBackendReadyMessage(
      JSON.stringify({
        backend: "neko",
        browser_owner_mode: "neko-owned",
        client_config_path: "/neko/session",
        iframe_path: null,
        stealth_mode: "balanced",
      })
    ),
    {
      ok: true,
      value: {
        backend: "neko",
        browser_owner_mode: "neko-owned",
        client_config_path: "/neko/session",
        iframe_path: null,
        stealth_mode: "balanced",
      },
    }
  );

  assert.deepEqual(parseBackendReadyMessage(JSON.stringify({ backend: "" })), {
    error: "backend_missing",
    ok: false,
  });
});

test("parse small SSE payload variants", () => {
  assert.deepEqual(parseUrlChangedMessage(JSON.stringify({ url: "https://example.test/a", title: "Example" })), {
    ok: true,
    value: { url: "https://example.test/a", title: "Example" },
  });
  assert.deepEqual(parsePopupOpenedMessage(JSON.stringify({ targetId: "target-1", url: "about:blank" })), {
    ok: true,
    value: { targetId: "target-1", url: "about:blank" },
  });
  assert.deepEqual(parsePopupClosedMessage(JSON.stringify({ targetId: "target-1" })), {
    ok: true,
    value: { targetId: "target-1" },
  });
  assert.deepEqual(parseClipboardMessage(JSON.stringify({ text: "copied" })), {
    ok: true,
    value: { text: "copied" },
  });
  assert.deepEqual(parseClipboardMessage(JSON.stringify({})), {
    error: "text_missing",
    ok: false,
  });
  assert.deepEqual(
    parseKeyboardFocusMessage(JSON.stringify({ element: { inputType: "password", tagName: "INPUT" }, focused: true })),
    {
      ok: true,
      value: { element: { inputType: "password", tagName: "INPUT" }, focused: true },
    }
  );
  assert.deepEqual(parseKeyboardFocusMessage(JSON.stringify({ element: { id: "secret" }, focused: true })), {
    ok: true,
    value: { element: { inputType: undefined, tagName: undefined }, focused: true },
  });
  assert.deepEqual(parseKeyboardFocusMessage(JSON.stringify({ focused: false })), {
    ok: true,
    value: { element: undefined, focused: false },
  });
  assert.deepEqual(parseStreamErrorMessage(JSON.stringify({ code: "x", message: "Broken" })), {
    ok: true,
    value: { code: "x", message: "Broken" },
  });
});
