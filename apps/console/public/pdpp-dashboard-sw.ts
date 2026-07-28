// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

interface DashboardPayload {
  type: string;
  [key: string]: unknown;
}

interface DashboardClient {
  focus: () => Promise<unknown>;
  navigate: (url: string) => Promise<unknown>;
  url: string;
}

interface DashboardClients {
  claim: () => Promise<unknown>;
  matchAll: (options: { includeUncontrolled: boolean; type: "window" }) => Promise<DashboardClient[]>;
  openWindow: (url: string) => Promise<unknown>;
}

interface DashboardRegistration {
  showNotification: (
    title: string,
    options: { body: string; data: { url: string }; renotify: boolean; tag: string }
  ) => Promise<void>;
}

interface DashboardPushEvent extends Event {
  data: { json: () => unknown } | null;
  waitUntil: (promise: Promise<unknown>) => void;
}

interface DashboardLifecycleEvent extends Event {
  waitUntil: (promise: Promise<unknown>) => void;
}

interface DashboardNotificationClickEvent extends Event {
  notification: { close: () => void; data: unknown };
  waitUntil: (promise: Promise<unknown>) => void;
}

interface Window {
  clients: DashboardClients;
  registration: DashboardRegistration;
  skipWaiting: () => void;
}

const dashboardWindow: Window = self;

const PDPP_KNOWN_PUSH_TYPES = new Set([
  "pdpp.assistance_requested",
  "pdpp.escalation",
  "pdpp.pending_interaction",
  "pdpp.test_notification",
]);
// Clean owner-route topology (redesign-owner-console-product-experience §10.B):
// the console owner control plane serves clean top-level nouns off root. The
// test notification lands on the overview; run notifications land on Syncs.
const PDPP_TEST_NOTIFICATION_URL = "/";
const PDPP_RUNS_URL = "/syncs";
// Clean owner-route prefixes the SW will click through to.
const PDPP_ALLOWED_URL_PREFIXES = [
  "/sources",
  "/syncs",
  "/audit",
  "/explore",
  "/grants",
  "/connect",
  "/notifications",
  "/schedules",
  "/deployment",
  "/device-exporters",
  "/event-subscriptions",
  "/search",
  "/stream-playground",
];

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  if (!isDashboardLifecycleEvent(event)) {
    return;
  }
  event.waitUntil(self.clients.claim());
});

function isDashboardLifecycleEvent(event: Event): event is DashboardLifecycleEvent {
  return "waitUntil" in event && typeof event.waitUntil === "function";
}

function isDashboardPushEvent(event: Event): event is DashboardPushEvent {
  return "data" in event && "waitUntil" in event && typeof event.waitUntil === "function";
}

function isDashboardNotificationClickEvent(event: Event): event is DashboardNotificationClickEvent {
  return "notification" in event && "waitUntil" in event && typeof event.waitUntil === "function";
}

function pdppDefaultFallbackUrl(type: string): string {
  return type === "pdpp.test_notification" ? PDPP_TEST_NOTIFICATION_URL : PDPP_RUNS_URL;
}

function pdppDefaultTag(payload: DashboardPayload): string {
  if (payload.type === "pdpp.test_notification") {
    const suffix = typeof payload.timestamp === "string" ? payload.timestamp : Date.now();
    return `pdpp-test-notification-${suffix}`;
  }
  // Escalation tag is per-connector + reason so deduplication collapses
  // repeated pushes for the same human-required state into one notification.
  // The scheduler already emits at most one escalation per streak, but the
  // service-worker tag provides a second dedup layer at the OS level.
  if (payload.type === "pdpp.escalation") {
    const connName = typeof payload.connector_display_name === "string" ? payload.connector_display_name : "connector";
    const reason = typeof payload.escalation_reason === "string" ? payload.escalation_reason : "escalation";
    return `pdpp-escalation-${connName}-${reason}`;
  }
  if (typeof payload.assistance_request_id === "string") {
    return `pdpp-${payload.assistance_request_id}`;
  }
  if (typeof payload.interaction_id === "string") {
    return `pdpp-${payload.interaction_id}`;
  }
  return "pdpp-pending-interaction";
}

function pdppDefaultTitle(type: string): string {
  return type === "pdpp.test_notification" ? "PDPP test notification" : "PDPP action needed";
}

function pdppDefaultBody(type: string): string {
  return type === "pdpp.test_notification"
    ? "This PDPP browser can receive Web Push alerts."
    : "A connector run needs owner attention.";
}

function pdppIsAllowedDashboardUrl(url: string): boolean {
  // The overview root and any clean owner section.
  if (url === "/") {
    return true;
  }
  return PDPP_ALLOWED_URL_PREFIXES.some((prefix) => url === prefix || url.startsWith(`${prefix}/`));
}

self.addEventListener("push", (event) => {
  if (!isDashboardPushEvent(event)) {
    return;
  }
  event.waitUntil(
    (async () => {
      let payload: DashboardPayload = { type: "" };
      try {
        const parsed: unknown = event.data ? event.data.json() : {};
        if (typeof parsed === "object" && parsed !== null) {
          payload = parsed as DashboardPayload;
        }
      } catch {
        payload = { type: "" };
      }
      if (!PDPP_KNOWN_PUSH_TYPES.has(payload.type)) {
        return;
      }
      const fallbackUrl = pdppDefaultFallbackUrl(payload.type);
      const rawUrl = typeof payload.url === "string" ? payload.url : fallbackUrl;
      const targetUrl = pdppIsAllowedDashboardUrl(rawUrl) ? rawUrl : fallbackUrl;
      const title = typeof payload.title === "string" ? payload.title : pdppDefaultTitle(payload.type);
      const body = typeof payload.body === "string" ? payload.body : pdppDefaultBody(payload.type);
      const isTestNotification = payload.type === "pdpp.test_notification";
      await self.registration.showNotification(title, {
        body,
        data: { url: targetUrl },
        renotify: isTestNotification,
        tag: pdppDefaultTag(payload),
      });
    })()
  );
});

self.addEventListener("notificationclick", (event) => {
  if (!isDashboardNotificationClickEvent(event)) {
    return;
  }
  event.notification.close();
  event.waitUntil(
    (async () => {
      const notificationData = event.notification.data;
      const rawUrl =
        typeof notificationData === "object" &&
        notificationData !== null &&
        "url" in notificationData &&
        typeof notificationData.url === "string"
          ? notificationData.url
          : PDPP_RUNS_URL;
      const targetUrl = pdppIsAllowedDashboardUrl(rawUrl) ? rawUrl : PDPP_RUNS_URL;
      const url = new URL(targetUrl, dashboardWindow.location.origin).href;
      const clientList = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
      for (const client of clientList) {
        if ("focus" in client && new URL(client.url).origin === dashboardWindow.location.origin) {
          // biome-ignore lint/performance/noAwaitInLoops: Preserves an established runtime, ordering, async, accessibility, or source-shape contract; covered by package verification.
          await client.focus();
          if ("navigate" in client) {
            await client.navigate(url);
          }
          return;
        }
      }
      await self.clients.openWindow(url);
    })()
  );
});
