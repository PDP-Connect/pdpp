// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { assessClipboardCapabilities, decideClipboardPolicy } from "@opendatalabs/remote-surface/client";
import { classifyReadyBackend, decideCdpMobileControls } from "./stream-cdp-mobile-controls.ts";

function policy(directionPolicy: "disabled" | "local-to-remote" | "remote-to-local" | "bidirectional-text") {
  return decideClipboardPolicy({
    capabilities: assessClipboardCapabilities({
      browserFamily: "chromium",
      isSecureContext: true,
      pointerCoarse: true,
      readTextAvailable: true,
      topLevel: true,
      writeTextAvailable: true,
    }),
    directionPolicy,
    hasStreamSession: true,
    helperMode: "balanced",
    sessionBackend: "cdp",
  });
}

test("direct-CDP controls retain explicit clipboard direction policy", () => {
  assert.deepEqual(
    decideCdpMobileControls({
      backend: "cdp",
      clipboardPolicy: policy("bidirectional-text"),
      pointerCoarse: true,
    }),
    { showCopy: true, showKeyboard: true, showPaste: true }
  );
  assert.deepEqual(
    decideCdpMobileControls({
      backend: "cdp",
      clipboardPolicy: policy("remote-to-local"),
      pointerCoarse: true,
    }),
    { showCopy: true, showKeyboard: true, showPaste: false }
  );
  assert.deepEqual(
    decideCdpMobileControls({
      backend: "cdp",
      clipboardPolicy: policy("local-to-remote"),
      pointerCoarse: true,
    }),
    { showCopy: false, showKeyboard: true, showPaste: true }
  );
});

test("backend classification fails closed before the server lifecycle signal", () => {
  assert.equal(classifyReadyBackend("cdp"), "cdp");
  assert.equal(classifyReadyBackend("neko"), "neko");
  assert.equal(classifyReadyBackend(""), "unknown");
  assert.equal(classifyReadyBackend("future-backend"), "unknown");
});
