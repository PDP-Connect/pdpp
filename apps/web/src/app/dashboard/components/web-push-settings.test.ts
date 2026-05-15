import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const HERE = new URL(".", import.meta.url).pathname;
const APP_ROOT = join(HERE, "..", "..", "..", "..");
const SERVICE_WORKER_PAYLOAD_TYPE_PATTERN = /payload\.type !== "pdpp\.pending_interaction"/;
const SERVICE_WORKER_DASHBOARD_URL_PATTERN = /rawUrl\.startsWith\("\/dashboard\/"\)/;
const SERVICE_WORKER_MATCH_CLIENTS_PATTERN = /clients\.matchAll/;
const SERVICE_WORKER_OPEN_WINDOW_PATTERN = /clients\.openWindow\(url\)/;
const SENSITIVE_WORD_PATTERN = /password|cookie|token|otp|answer/i;
const MANIFEST_START_URL_PATTERN = /start_url:\s*"\/dashboard"/;
const MANIFEST_STANDALONE_DISPLAY_PATTERN = /display:\s*"standalone"/;
const MANIFEST_SCOPE_PATTERN = /scope:\s*"\/"/;
const MANIFEST_BACKGROUND_PATTERN = /background_color:\s*"#[0-9a-f]{6}"/i;
const MANIFEST_THEME_PATTERN = /theme_color:\s*"#[0-9a-f]{6}"/i;
const MANIFEST_APPLE_ICON_PATTERN = /\/apple-icon\.png/;
const MANIFEST_APPLE_ICON_SIZE_PATTERN = /sizes:\s*"180x180"/;
const MANIFEST_MASKABLE_PATTERN = /purpose:\s*"maskable"/;
const MANIFEST_ICON_PATTERN = /\/icon\.svg/;
const MANIFEST_ANY_SIZE_PATTERN = /sizes:\s*"any"/;
const APP_ROUTER_MANIFEST_PATTERN = /export default function manifest\(\)/;
const SERVICE_WORKER_REGISTER_PATTERN = /navigator\.serviceWorker\.register\("\/pdpp-dashboard-sw\.js"\)/;
const SERVICE_WORKER_LOOKUP_PATTERN = /navigator\.serviceWorker\.getRegistration\("\/"\)/;
const PUSH_SUBSCRIBE_PATTERN = /registration\.pushManager\.subscribe/;
const PUSH_EXISTING_SUBSCRIPTION_PATTERN = /registration\.pushManager\.getSubscription\(\)/;
const WEB_PUSH_POST_PATTERN = /fetch\("\/_ref\/web-push\/subscriptions"/;
const WEB_PUSH_DELETE_PATTERN = /method:\s*"DELETE"/;
const FIRST_SAVED_ENDPOINT_PATTERN = /subscriptions\[0\]\?\.endpoint/;

test("WebPushSettings renders unsupported, denied-permission, insecure-context, VAPID, and iOS/PWA caveat states", async () => {
  const src = await readFile(join(HERE, "web-push-settings.tsx"), "utf8");
  for (const expected of [
    "window.isSecureContext",
    "serviceWorker",
    "PushManager",
    "Notification",
    'Notification.permission === "denied"',
    "Server VAPID keys are not configured",
    "iOS and some mobile browsers require installing this dashboard as a PWA",
    "ntfy/current and in-dashboard pending interactions stay available",
  ]) {
    assert.match(src, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("dashboard service worker fails closed and click-through targets dashboard-relative URLs", async () => {
  const src = await readFile(join(APP_ROOT, "public", "pdpp-dashboard-sw.js"), "utf8");
  assert.match(src, SERVICE_WORKER_PAYLOAD_TYPE_PATTERN);
  assert.match(src, SERVICE_WORKER_DASHBOARD_URL_PATTERN);
  assert.match(src, SERVICE_WORKER_MATCH_CLIENTS_PATTERN);
  assert.match(src, SERVICE_WORKER_OPEN_WINDOW_PATTERN);
  assert.doesNotMatch(src, SENSITIVE_WORD_PATTERN);
});

test("dashboard exposes installable PWA manifest for mobile Web Push setup", async () => {
  const src = await readFile(join(APP_ROOT, "src", "app", "manifest.ts"), "utf8");
  assert.match(src, MANIFEST_START_URL_PATTERN);
  assert.match(src, MANIFEST_STANDALONE_DISPLAY_PATTERN);
  assert.match(src, MANIFEST_SCOPE_PATTERN);
  assert.match(src, MANIFEST_BACKGROUND_PATTERN);
  assert.match(src, MANIFEST_THEME_PATTERN);
  assert.match(src, MANIFEST_APPLE_ICON_PATTERN);
  assert.match(src, MANIFEST_APPLE_ICON_SIZE_PATTERN);
  assert.match(src, MANIFEST_MASKABLE_PATTERN);
  assert.match(src, MANIFEST_ICON_PATTERN);
  assert.match(src, MANIFEST_ANY_SIZE_PATTERN);
});

test("dashboard PWA install metadata uses one App Router manifest source", async () => {
  const src = await readFile(join(APP_ROOT, "src", "app", "manifest.ts"), "utf8");
  assert.match(src, APP_ROUTER_MANIFEST_PATTERN);
  await assert.rejects(readFile(join(APP_ROOT, "public", "manifest.json"), "utf8"));
});

test("dashboard notification setup registers, posts, reuses, and deletes browser subscriptions", async () => {
  const src = await readFile(join(HERE, "web-push-settings.tsx"), "utf8");
  assert.match(src, SERVICE_WORKER_REGISTER_PATTERN);
  assert.match(src, SERVICE_WORKER_LOOKUP_PATTERN);
  assert.match(src, PUSH_EXISTING_SUBSCRIPTION_PATTERN);
  assert.match(src, PUSH_SUBSCRIBE_PATTERN);
  assert.match(src, WEB_PUSH_POST_PATTERN);
  assert.match(src, WEB_PUSH_DELETE_PATTERN);
  assert.doesNotMatch(src, FIRST_SAVED_ENDPOINT_PATTERN);
});
