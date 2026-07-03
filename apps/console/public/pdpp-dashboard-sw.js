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
  event.waitUntil(self.clients.claim());
});

function pdppDefaultFallbackUrl(type) {
  return type === "pdpp.test_notification" ? PDPP_TEST_NOTIFICATION_URL : PDPP_RUNS_URL;
}

function pdppDefaultTag(payload) {
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
  if (typeof payload.assistance_request_id === "string") return `pdpp-${payload.assistance_request_id}`;
  if (typeof payload.interaction_id === "string") return `pdpp-${payload.interaction_id}`;
  return "pdpp-pending-interaction";
}

function pdppDefaultTitle(type) {
  return type === "pdpp.test_notification" ? "PDPP test notification" : "PDPP action needed";
}

function pdppDefaultBody(type) {
  return type === "pdpp.test_notification"
    ? "Your dashboard browser can receive Web Push alerts."
    : "A connector run needs owner attention.";
}

function pdppIsAllowedDashboardUrl(url) {
  // The overview root and any clean owner section.
  if (url === "/") return true;
  return PDPP_ALLOWED_URL_PREFIXES.some((prefix) => url === prefix || url.startsWith(prefix + "/"));
}

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let payload = {};
      try {
        payload = event.data ? event.data.json() : {};
      } catch {
        payload = {};
      }
      if (!PDPP_KNOWN_PUSH_TYPES.has(payload.type)) return;
      const fallbackUrl = pdppDefaultFallbackUrl(payload.type);
      const rawUrl = typeof payload.url === "string" ? payload.url : fallbackUrl;
      const targetUrl = pdppIsAllowedDashboardUrl(rawUrl) ? rawUrl : fallbackUrl;
      const title = typeof payload.title === "string" ? payload.title : pdppDefaultTitle(payload.type);
      const body = typeof payload.body === "string" ? payload.body : pdppDefaultBody(payload.type);
      const isTestNotification = payload.type === "pdpp.test_notification";
      await self.registration.showNotification(title, {
        body,
        renotify: isTestNotification,
        tag: pdppDefaultTag(payload),
        data: { url: targetUrl },
      });
    })()
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const rawUrl = event.notification.data && typeof event.notification.data.url === "string"
        ? event.notification.data.url
        : PDPP_RUNS_URL;
      const targetUrl = pdppIsAllowedDashboardUrl(rawUrl) ? rawUrl : PDPP_RUNS_URL;
      const url = new URL(targetUrl, self.location.origin).href;
      const clientList = await clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of clientList) {
        if ("focus" in client && new URL(client.url).origin === self.location.origin) {
          await client.focus();
          if ("navigate" in client) await client.navigate(url);
          return;
        }
      }
      await clients.openWindow(url);
    })()
  );
});
