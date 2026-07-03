import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const HERE = new URL(".", import.meta.url).pathname;
const APP_ROOT = join(HERE, "..", "..", "..", "..");
const SERVICE_WORKER_KNOWN_TYPES_PATTERN = /PDPP_KNOWN_PUSH_TYPES\.has\(payload\.type\)/;
const SERVICE_WORKER_ASSISTANCE_TYPE_ALLOWED_PATTERN = /pdpp\.assistance_requested/;
const SERVICE_WORKER_ESCALATION_TYPE_ALLOWED_PATTERN = /pdpp\.escalation/;
const SERVICE_WORKER_PENDING_TYPE_ALLOWED_PATTERN = /pdpp\.pending_interaction/;
const SERVICE_WORKER_TEST_TYPE_ALLOWED_PATTERN = /pdpp\.test_notification/;
const SERVICE_WORKER_SKIP_WAITING_PATTERN = /self\.skipWaiting\(\)/;
const SERVICE_WORKER_CLIENTS_CLAIM_PATTERN = /self\.clients\.claim\(\)/;
// The SW allows the overview root plus clean owner-section prefixes at segment
// boundaries. The removed `/dashboard` prefix must not be allow-listed.
const SERVICE_WORKER_DASHBOARD_URL_ALLOWLIST_PATTERN =
  /url === "\/"[\s\S]*PDPP_ALLOWED_URL_PREFIXES\.some\(\(prefix\) => url === prefix \|\| url\.startsWith\(prefix \+ "\/"\)\)/;
const SERVICE_WORKER_ALLOWLIST_HAS_SOURCES = /"\/sources"/;
const SERVICE_WORKER_ALLOWLIST_HAS_SYNCS = /"\/syncs"/;
const SERVICE_WORKER_ALLOWLIST_HAS_LEGACY_DASHBOARD = /"\/dashboard"/;
const SERVICE_WORKER_DASHBOARD_URL_HELPER_USE_PATTERN = /pdppIsAllowedDashboardUrl\(rawUrl\)/;
const SERVICE_WORKER_DASHBOARD_PREFIX_TRAVERSAL_PATTERN = /rawUrl\.startsWith\("\/"\)/;
const SERVICE_WORKER_UNIQUE_TEST_TAG_PATTERN = /pdpp-test-notification-\$\{suffix\}/;
const SERVICE_WORKER_TEST_RENOTIFY_PATTERN = /renotify:\s*isTestNotification/;
const SERVICE_WORKER_MATCH_CLIENTS_PATTERN = /clients\.matchAll/;
const SERVICE_WORKER_OPEN_WINDOW_PATTERN = /clients\.openWindow\(url\)/;
const SENSITIVE_WORD_PATTERN = /password|cookie|token|otp|answer/i;
const SERVICE_WORKER_REGISTER_PATTERN = /navigator\.serviceWorker\.register\("\/pdpp-dashboard-sw\.js"\)/;
const SERVICE_WORKER_LOOKUP_PATTERN = /navigator\.serviceWorker\.getRegistration\("\/"\)/;
const SERVICE_WORKER_UPDATE_PATTERN = /registration\?\.update\(\)/;
const PUSH_SUBSCRIBE_PATTERN = /registration\.pushManager\.subscribe/;
const PUSH_EXISTING_SUBSCRIPTION_PATTERN = /registration\.pushManager\.getSubscription\(\)/;
const WEB_PUSH_POST_PATTERN = /fetch\("\/_ref\/web-push\/subscriptions"/;
const WEB_PUSH_DELETE_PATTERN = /method:\s*"DELETE"/;
const FIRST_SAVED_ENDPOINT_PATTERN = /subscriptions\[0\]\?\.endpoint/;
const DIAGNOSTICS_TOGGLE_SHOW_PATTERN = /Show diagnostics/;
const DIAGNOSTICS_TOGGLE_HIDE_PATTERN = /Hide diagnostics/;
const DIAGNOSTICS_ARIA_LABEL_PATTERN = /aria-label="Web Push diagnostics"/;
const DIAGNOSTICS_PWA_INSTALL_PATTERN = /installing the PWA alone does not subscribe/;
const DIAGNOSTICS_PER_DEVICE_ENABLE_PATTERN = /Each phone, tablet, and browser profile must be enabled separately/;
const DIAGNOSTICS_SETUP_STEP_DEVICE_PATTERN = /Open the right device/;
const DIAGNOSTICS_SETUP_STEP_PERMISSION_PATTERN = /Allow notifications/;
const DIAGNOSTICS_SETUP_STEP_SUBSCRIBE_PATTERN = /Subscribe this device/;
const DIAGNOSTICS_SETUP_STEP_TEST_PATTERN = /Send a test/;
const DIAGNOSTICS_INSTALL_DISTINCT_FROM_SUBSCRIBE_PATTERN = /A PWA install is not enough/;
const DIAGNOSTICS_DEVICE_SUBSCRIBED_PATTERN = /This device is subscribed/;
const DIAGNOSTICS_SERVER_UNRECOGNIZED_PATTERN = /server does not recognize it/;
const DIAGNOSTICS_DEVICE_DISPLAY_CONFIRMATION_PATTERN = /Only the device can confirm whether it displayed/;
const DIAGNOSTICS_ENABLE_DEVICE_BUTTON_PATTERN = />\s*Enable this device\s*</;
const DIAGNOSTICS_DISABLE_DEVICE_BUTTON_PATTERN = />\s*Disable this device\s*</;
const DIAGNOSTICS_TEST_PUSH_PATTERN = /fetch\("\/_ref\/web-push\/test"/;
const DIAGNOSTICS_TEST_PUSH_METHOD_PATTERN = /method:\s*"POST"/;
const DIAGNOSTICS_SEND_TEST_BUTTON_PATTERN = />\s*Send test notification\s*</;
const DIAGNOSTICS_SEND_DISABLED_PATTERN = /disabled=\{busy \|\| !endpoint \|\| Boolean\(unavailable\)\}/;
const DIAGNOSTICS_NO_SUBSCRIPTIONS_PATTERN = /No active subscriptions for this owner/;
const WEB_PUSH_RESPONSE_ERROR_HELPER_PATTERN =
  /async function webPushResponseError\(response: Response, fallbackAction: string\)/;
const WEB_PUSH_RESPONSE_ERROR_MESSAGE_PATTERN = /body\.error\?\.message \|\| body\.message \|\| body\.error\?\.code/;
const WEB_PUSH_SUBSCRIBE_STRUCTURED_ERROR_PATTERN =
  /throw await webPushResponseError\(response, "Subscription failed"\)/;
const WEB_PUSH_TEST_STRUCTURED_ERROR_PATTERN =
  /throw await webPushResponseError\(response, "Test notification failed"\)/;
const WEB_PUSH_UNSUBSCRIBE_STRUCTURED_ERROR_PATTERN =
  /throw await webPushResponseError\(response, "Unsubscribe failed"\)/;
const SSR_SAFE_WINDOW_HELPER_DEF_PATTERN = /function hasWindowFeature\(/;
const SSR_SAFE_NAVIGATOR_HELPER_DEF_PATTERN = /function hasNavigatorFeature\(/;
const SSR_SAFE_WINDOW_HELPER_GUARD_PATTERN = /typeof window !== "undefined"/;
const SSR_SAFE_NAVIGATOR_HELPER_GUARD_PATTERN = /typeof navigator !== "undefined"/;
const SSR_SAFE_DIAGNOSTIC_PUSHMANAGER_PATTERN = /hasWindowFeature\("PushManager"\)/;
const SSR_SAFE_DIAGNOSTIC_NOTIFICATION_PATTERN = /hasWindowFeature\("Notification"\)/;
const SSR_SAFE_DIAGNOSTIC_SERVICE_WORKER_PATTERN = /hasNavigatorFeature\("serviceWorker"\)/;
const SVG_CSS_COLOR_FUNCTION_PATTERN = /oklch\(|lab\(|lch\(|color\(/i;
const SVG_BACKGROUND_PATTERN = /<rect[^>]+width="32"[^>]+height="32"[^>]+fill="#f8f6f0"/;
const SVG_BRAND_COPPER_PATTERN = /fill="#a05533"/;
const SVG_BRAND_BLUE_PATTERN = /fill="#2c73d9"/;
const ENABLE_CLEARS_TEST_STATUS_PATTERN = /async function enable\(\)[\s\S]*?setBusy\(true\);\s*setTestStatus\(null\);/;
const DISABLE_CLEARS_TEST_STATUS_PATTERN =
  /async function disable\(\)[\s\S]*?setBusy\(true\);\s*setTestStatus\(null\);/;
const WEB_PUSH_SUMMARY_LIVE_REGION_PATTERN =
  /<p aria-atomic="true" aria-live="polite" className="pdpp-body[^"]+" role="status">/;
const WEB_PUSH_DETAIL_LIVE_REGION_PATTERN =
  /<div aria-atomic="true" aria-live="polite" role="status">[\s\S]*?Last check: \{status\}[\s\S]*?\{testStatus \? <p/;

test("WebPushSettings renders unsupported, denied-permission, insecure-context, VAPID, and iOS/PWA caveat states", async () => {
  const src = await readFile(join(HERE, "web-push-settings.tsx"), "utf8");
  for (const expected of [
    "window.isSecureContext",
    "serviceWorker",
    "PushManager",
    "Notification",
    'Notification.permission === "denied"',
    "Server VAPID keys are not configured",
    "Mobile browsers may require opening the installed dashboard app before notifications can arrive",
    "Installing the PWA only adds the app icon",
  ]) {
    assert.match(src, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("dashboard service worker fails closed and click-through targets clean owner URLs", async () => {
  const src = await readFile(join(APP_ROOT, "public", "pdpp-dashboard-sw.js"), "utf8");
  assert.match(src, SERVICE_WORKER_KNOWN_TYPES_PATTERN);
  assert.match(src, SERVICE_WORKER_ASSISTANCE_TYPE_ALLOWED_PATTERN);
  assert.match(src, SERVICE_WORKER_ESCALATION_TYPE_ALLOWED_PATTERN);
  assert.match(src, SERVICE_WORKER_PENDING_TYPE_ALLOWED_PATTERN);
  assert.match(src, SERVICE_WORKER_TEST_TYPE_ALLOWED_PATTERN);
  assert.match(src, SERVICE_WORKER_SKIP_WAITING_PATTERN);
  assert.match(src, SERVICE_WORKER_CLIENTS_CLAIM_PATTERN);
  assert.match(src, SERVICE_WORKER_DASHBOARD_URL_ALLOWLIST_PATTERN);
  assert.match(src, SERVICE_WORKER_ALLOWLIST_HAS_SOURCES);
  assert.match(src, SERVICE_WORKER_ALLOWLIST_HAS_SYNCS);
  assert.doesNotMatch(src, SERVICE_WORKER_ALLOWLIST_HAS_LEGACY_DASHBOARD);
  assert.match(src, SERVICE_WORKER_DASHBOARD_URL_HELPER_USE_PATTERN);
  assert.match(src, SERVICE_WORKER_UNIQUE_TEST_TAG_PATTERN);
  assert.match(src, SERVICE_WORKER_TEST_RENOTIFY_PATTERN);
  // Reject the looser prefix check that would accept arbitrary rooted paths.
  assert.doesNotMatch(src, SERVICE_WORKER_DASHBOARD_PREFIX_TRAVERSAL_PATTERN);
  assert.match(src, SERVICE_WORKER_MATCH_CLIENTS_PATTERN);
  assert.match(src, SERVICE_WORKER_OPEN_WINDOW_PATTERN);
  assert.doesNotMatch(src, SENSITIVE_WORD_PATTERN);
});

test("dashboard launcher SVG icon uses Android-safe paint values", async () => {
  const src = await readFile(join(APP_ROOT, "src", "app", "icon.svg"), "utf8");
  assert.doesNotMatch(src, SVG_CSS_COLOR_FUNCTION_PATTERN);
  assert.match(src, SVG_BACKGROUND_PATTERN);
  assert.match(src, SVG_BRAND_COPPER_PATTERN);
  assert.match(src, SVG_BRAND_BLUE_PATTERN);
});

test("dashboard notification setup registers, posts, reuses, and deletes browser subscriptions", async () => {
  const src = await readFile(join(HERE, "web-push-settings.tsx"), "utf8");
  assert.match(src, SERVICE_WORKER_REGISTER_PATTERN);
  assert.match(src, SERVICE_WORKER_LOOKUP_PATTERN);
  assert.match(src, SERVICE_WORKER_UPDATE_PATTERN);
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
  assert.match(src, DIAGNOSTICS_ENABLE_DEVICE_BUTTON_PATTERN);
  assert.match(src, DIAGNOSTICS_DISABLE_DEVICE_BUTTON_PATTERN);
  assert.match(src, DIAGNOSTICS_SEND_TEST_BUTTON_PATTERN);
  assert.match(src, DIAGNOSTICS_SEND_DISABLED_PATTERN);
  assert.match(src, DIAGNOSTICS_NO_SUBSCRIPTIONS_PATTERN);
});

// After a successful send-test, the status line would otherwise read
// "Test notification sent..." even after the owner disabled this device or
// re-enabled it. Clearing testStatus on those transitions prevents that
// stale, misleading message from outliving the subscription it describes.
test("dashboard Web Push enable and disable clear any stale test-notification status", async () => {
  const src = await readFile(join(HERE, "web-push-settings.tsx"), "utf8");
  assert.match(src, ENABLE_CLEARS_TEST_STATUS_PATTERN);
  assert.match(src, DISABLE_CLEARS_TEST_STATUS_PATTERN);
});

test("dashboard Web Push status changes are announced as live status regions", async () => {
  const src = await readFile(join(HERE, "web-push-settings.tsx"), "utf8");
  assert.match(src, WEB_PUSH_SUMMARY_LIVE_REGION_PATTERN);
  assert.match(src, WEB_PUSH_DETAIL_LIVE_REGION_PATTERN);
});

test("dashboard Web Push actions surface structured endpoint error details", async () => {
  const src = await readFile(join(HERE, "web-push-settings.tsx"), "utf8");
  assert.match(src, WEB_PUSH_RESPONSE_ERROR_HELPER_PATTERN);
  assert.match(src, WEB_PUSH_RESPONSE_ERROR_MESSAGE_PATTERN);
  assert.match(src, WEB_PUSH_SUBSCRIBE_STRUCTURED_ERROR_PATTERN);
  assert.match(src, WEB_PUSH_TEST_STRUCTURED_ERROR_PATTERN);
  assert.match(src, WEB_PUSH_UNSUBSCRIBE_STRUCTURED_ERROR_PATTERN);
});

test("dashboard Web Push setup explains install, permission, subscription, and test as separate states", async () => {
  const src = await readFile(join(HERE, "web-push-settings.tsx"), "utf8");
  assert.match(src, DIAGNOSTICS_SETUP_STEP_DEVICE_PATTERN);
  assert.match(src, DIAGNOSTICS_SETUP_STEP_PERMISSION_PATTERN);
  assert.match(src, DIAGNOSTICS_SETUP_STEP_SUBSCRIBE_PATTERN);
  assert.match(src, DIAGNOSTICS_SETUP_STEP_TEST_PATTERN);
  assert.match(src, DIAGNOSTICS_INSTALL_DISTINCT_FROM_SUBSCRIBE_PATTERN);
  assert.match(src, DIAGNOSTICS_DEVICE_SUBSCRIBED_PATTERN);
  assert.match(src, DIAGNOSTICS_SERVER_UNRECOGNIZED_PATTERN);
  assert.match(src, DIAGNOSTICS_DEVICE_DISPLAY_CONFIRMATION_PATTERN);
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
