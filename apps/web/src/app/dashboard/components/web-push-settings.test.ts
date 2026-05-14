import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const HERE = new URL(".", import.meta.url).pathname;
const APP_ROOT = join(HERE, "..", "..", "..", "..");

test("WebPushSettings renders unsupported, denied-permission, insecure-context, VAPID, and iOS/PWA caveat states", async () => {
  const src = await readFile(join(HERE, "web-push-settings.tsx"), "utf8");
  for (const expected of [
    "window.isSecureContext",
    "serviceWorker",
    "PushManager",
    "Notification",
    "Notification.permission === \"denied\"",
    "Server VAPID keys are not configured",
    "iOS and some mobile browsers require installing this dashboard as a PWA",
    "ntfy/current and in-dashboard pending interactions stay available",
  ]) {
    assert.match(src, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("dashboard service worker fails closed and click-through targets dashboard-relative URLs", async () => {
  const src = await readFile(join(APP_ROOT, "public", "pdpp-dashboard-sw.js"), "utf8");
  assert.match(src, /payload\.type !== "pdpp\.pending_interaction"/);
  assert.match(src, /rawUrl\.startsWith\("\/dashboard\/"\)/);
  assert.match(src, /clients\.matchAll/);
  assert.match(src, /clients\.openWindow\(url\)/);
  assert.doesNotMatch(src, /password|cookie|token|otp|answer/i);
});

