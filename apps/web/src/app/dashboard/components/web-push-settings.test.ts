import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const HERE = new URL(".", import.meta.url).pathname;
const APP_ROOT = join(HERE, "..", "..", "..", "..");
const SERVICE_WORKER_KNOWN_TYPES_PATTERN = /PDPP_KNOWN_PUSH_TYPES\.has\(payload\.type\)/;
const SERVICE_WORKER_ASSISTANCE_TYPE_ALLOWED_PATTERN = /pdpp\.assistance_requested/;
const SERVICE_WORKER_PENDING_TYPE_ALLOWED_PATTERN = /pdpp\.pending_interaction/;
const SERVICE_WORKER_TEST_TYPE_ALLOWED_PATTERN = /pdpp\.test_notification/;
const SERVICE_WORKER_DASHBOARD_URL_ALLOWLIST_PATTERN = /url === "\/dashboard" \|\| url\.startsWith\("\/dashboard\/"\)/;
const SERVICE_WORKER_DASHBOARD_URL_HELPER_USE_PATTERN = /pdppIsAllowedDashboardUrl\(rawUrl\)/;
const SERVICE_WORKER_DASHBOARD_PREFIX_TRAVERSAL_PATTERN = /rawUrl\.startsWith\("\/dashboard"\)/;
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
const DIAGNOSTICS_TOGGLE_SHOW_PATTERN = /Show diagnostics/;
const DIAGNOSTICS_TOGGLE_HIDE_PATTERN = /Hide diagnostics/;
const DIAGNOSTICS_ARIA_LABEL_PATTERN = /aria-label="Web Push diagnostics"/;
const DIAGNOSTICS_PWA_INSTALL_PATTERN = /installing the PWA alone does not subscribe/;
const DIAGNOSTICS_PER_DEVICE_ENABLE_PATTERN = /Each device must tap Enable here once/;
const DIAGNOSTICS_TEST_PUSH_PATTERN = /fetch\("\/_ref\/web-push\/test"/;
const DIAGNOSTICS_TEST_PUSH_METHOD_PATTERN = /method:\s*"POST"/;
const DIAGNOSTICS_SEND_TEST_BUTTON_PATTERN = />\s*Send test\s*</;
const DIAGNOSTICS_SEND_DISABLED_PATTERN = /disabled=\{busy \|\| !endpoint \|\| Boolean\(unavailable\)\}/;
const DIAGNOSTICS_NO_SUBSCRIPTIONS_PATTERN = /No active subscriptions for this owner/;
const SSR_SAFE_WINDOW_HELPER_DEF_PATTERN = /function hasWindowFeature\(/;
const SSR_SAFE_NAVIGATOR_HELPER_DEF_PATTERN = /function hasNavigatorFeature\(/;
const SSR_SAFE_WINDOW_HELPER_GUARD_PATTERN = /typeof window !== "undefined"/;
const SSR_SAFE_NAVIGATOR_HELPER_GUARD_PATTERN = /typeof navigator !== "undefined"/;
const SSR_SAFE_DIAGNOSTIC_PUSHMANAGER_PATTERN = /hasWindowFeature\("PushManager"\)/;
const SSR_SAFE_DIAGNOSTIC_NOTIFICATION_PATTERN = /hasWindowFeature\("Notification"\)/;
const SSR_SAFE_DIAGNOSTIC_SERVICE_WORKER_PATTERN = /hasNavigatorFeature\("serviceWorker"\)/;

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
  assert.match(src, SERVICE_WORKER_KNOWN_TYPES_PATTERN);
  assert.match(src, SERVICE_WORKER_ASSISTANCE_TYPE_ALLOWED_PATTERN);
  assert.match(src, SERVICE_WORKER_PENDING_TYPE_ALLOWED_PATTERN);
  assert.match(src, SERVICE_WORKER_TEST_TYPE_ALLOWED_PATTERN);
  assert.match(src, SERVICE_WORKER_DASHBOARD_URL_ALLOWLIST_PATTERN);
  assert.match(src, SERVICE_WORKER_DASHBOARD_URL_HELPER_USE_PATTERN);
  // Reject the looser prefix check that would also accept e.g. "/dashboardevil".
  assert.doesNotMatch(src, SERVICE_WORKER_DASHBOARD_PREFIX_TRAVERSAL_PATTERN);
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

test("dashboard test notification button posts to /_ref/web-push/test and gates on subscription", async () => {
  const src = await readFile(join(HERE, "web-push-settings.tsx"), "utf8");
  assert.match(src, DIAGNOSTICS_TEST_PUSH_PATTERN);
  assert.match(src, DIAGNOSTICS_TEST_PUSH_METHOD_PATTERN);
  assert.match(src, DIAGNOSTICS_SEND_TEST_BUTTON_PATTERN);
  assert.match(src, DIAGNOSTICS_SEND_DISABLED_PATTERN);
  assert.match(src, DIAGNOSTICS_NO_SUBSCRIPTIONS_PATTERN);
});

test("dashboard exposes diagnostic checklist covering every web push precondition", async () => {
  const src = await readFile(join(HERE, "web-push-settings.tsx"), "utf8");
  assert.match(src, DIAGNOSTICS_TOGGLE_SHOW_PATTERN);
  assert.match(src, DIAGNOSTICS_TOGGLE_HIDE_PATTERN);
  assert.match(src, DIAGNOSTICS_ARIA_LABEL_PATTERN);
  for (const label of [
    "Secure context (HTTPS/localhost)",
    "Service Worker API available",
    "Push API (PushManager) available",
    "Notification API available",
    "Server VAPID keys configured",
    "Service worker registered",
    "Notification permission granted",
    "Browser push subscription active",
    "Server-tracked subscriptions for this owner",
    "Last delivery health",
  ]) {
    assert.ok(src.includes(label), `diagnostics missing label: ${label}`);
  }
  assert.match(src, DIAGNOSTICS_PWA_INSTALL_PATTERN);
  assert.match(src, DIAGNOSTICS_PER_DEVICE_ENABLE_PATTERN);
});

test("diagnostics feature probes are SSR-safe and called via typed helpers", async () => {
  const src = await readFile(join(HERE, "web-push-settings.tsx"), "utf8");
  // The render-time diagnostic builder must never touch window/navigator
  // directly — buildDiagnostics() runs during render and Next can pre-render
  // a client component on the server, where window/navigator are undefined.
  assert.match(src, SSR_SAFE_WINDOW_HELPER_DEF_PATTERN);
  assert.match(src, SSR_SAFE_NAVIGATOR_HELPER_DEF_PATTERN);
  assert.match(src, SSR_SAFE_WINDOW_HELPER_GUARD_PATTERN);
  assert.match(src, SSR_SAFE_NAVIGATOR_HELPER_GUARD_PATTERN);
  assert.match(src, SSR_SAFE_DIAGNOSTIC_PUSHMANAGER_PATTERN);
  assert.match(src, SSR_SAFE_DIAGNOSTIC_NOTIFICATION_PATTERN);
  assert.match(src, SSR_SAFE_DIAGNOSTIC_SERVICE_WORKER_PATTERN);
});
