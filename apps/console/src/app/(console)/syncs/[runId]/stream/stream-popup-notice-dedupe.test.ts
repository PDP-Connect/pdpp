// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { claimPopupNotice, createPopupNoticeSeenRegistry } from "./stream-popup-notice-dedupe.ts";

const VIEWER_FILE = fileURLToPath(new URL("./stream-viewer.tsx", import.meta.url));
const ACTIVE_BROWSER_SESSION_RE = /const browserSessionId = browserSessionIdRef\.current/;
const CLAIM_POPUP_NOTICE_RE = /claimPopupNotice\(popupNoticeSeenRegistryRef\.current/;
const RESET_POPUP_NOTICE_REGISTRY_RE = /popupNoticeSeenRegistryRef\.current = createPopupNoticeSeenRegistry\(\)/;

test("the same target in the same browser session is claimed once", () => {
  const registry = createPopupNoticeSeenRegistry();
  const identity = { browserSessionId: "browser-1", targetId: "popup-1" };

  assert.equal(claimPopupNotice(registry, identity), "claimed");
  assert.equal(claimPopupNotice(registry, identity), "duplicate");
});

test("distinct child targets remain independently claimable", () => {
  const registry = createPopupNoticeSeenRegistry();

  assert.equal(claimPopupNotice(registry, { browserSessionId: "browser-1", targetId: "popup-1" }), "claimed");
  assert.equal(claimPopupNotice(registry, { browserSessionId: "browser-1", targetId: "popup-2" }), "claimed");
});

test("missing session identity is never treated as proof of a duplicate", () => {
  const registry = createPopupNoticeSeenRegistry();
  const identity = { browserSessionId: null, targetId: "popup-1" };

  assert.equal(claimPopupNotice(registry, identity), "unkeyable");
  assert.equal(claimPopupNotice(registry, identity), "unkeyable");
});

test("a target ID from a new browser session is a new claim", () => {
  const registry = createPopupNoticeSeenRegistry();

  assert.equal(claimPopupNotice(registry, { browserSessionId: "browser-1", targetId: "popup-1" }), "claimed");
  assert.equal(claimPopupNotice(registry, { browserSessionId: "browser-2", targetId: "popup-1" }), "claimed");
});

test("the viewer scopes claims to the active browser session and resets on replacement", async () => {
  const source = await readFile(VIEWER_FILE, "utf8");

  assert.match(source, ACTIVE_BROWSER_SESSION_RE);
  assert.match(source, CLAIM_POPUP_NOTICE_RE);
  assert.match(source, RESET_POPUP_NOTICE_REGISTRY_RE);
});
