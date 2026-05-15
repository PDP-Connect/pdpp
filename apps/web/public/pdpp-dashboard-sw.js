const PDPP_KNOWN_PUSH_TYPES = new Set(["pdpp.pending_interaction", "pdpp.test_notification"]);
const PDPP_TEST_NOTIFICATION_URL = "/dashboard";

function pdppDefaultFallbackUrl(type) {
  return type === "pdpp.test_notification" ? PDPP_TEST_NOTIFICATION_URL : "/dashboard/runs";
}

function pdppDefaultTag(payload) {
  if (payload.type === "pdpp.test_notification") return "pdpp-test-notification";
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
      const targetUrl = rawUrl.startsWith("/dashboard") ? rawUrl : fallbackUrl;
      const title = typeof payload.title === "string" ? payload.title : pdppDefaultTitle(payload.type);
      const body = typeof payload.body === "string" ? payload.body : pdppDefaultBody(payload.type);
      await self.registration.showNotification(title, {
        body,
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
        : "/dashboard/runs";
      const targetUrl = rawUrl.startsWith("/dashboard") ? rawUrl : "/dashboard/runs";
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

