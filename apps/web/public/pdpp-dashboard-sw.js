self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let payload = {};
      try {
        payload = event.data ? event.data.json() : {};
      } catch {
        payload = {};
      }
      if (payload.type !== "pdpp.pending_interaction") return;
      const rawUrl = typeof payload.url === "string" ? payload.url : "/dashboard/runs";
      const targetUrl = rawUrl.startsWith("/dashboard/") ? rawUrl : "/dashboard/runs";
      const title = typeof payload.title === "string" ? payload.title : "PDPP action needed";
      const body = typeof payload.body === "string" ? payload.body : "A connector run needs owner attention.";
      await self.registration.showNotification(title, {
        body,
        tag: typeof payload.interaction_id === "string" ? `pdpp-${payload.interaction_id}` : "pdpp-pending-interaction",
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
      const targetUrl = rawUrl.startsWith("/dashboard/") ? rawUrl : "/dashboard/runs";
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

