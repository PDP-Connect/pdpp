"use client";

import { useEffect, useState } from "react";
import type { WebPushConfig, WebPushSubscriptionSummary } from "../lib/ref-client.ts";
import { Section } from "./primitives.tsx";

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
}

function detectSupport(config: WebPushConfig) {
  if (!window.isSecureContext) {
    return "Web Push needs HTTPS or localhost.";
  }
  if (!("serviceWorker" in navigator)) {
    return "This browser does not support service workers.";
  }
  if (!("PushManager" in window)) {
    return "This browser does not support the Push API.";
  }
  if (!("Notification" in window)) {
    return "This browser does not support browser notifications.";
  }
  if (!(config.enabled && config.public_key)) {
    return config.unavailable_reason || "Server VAPID keys are not configured.";
  }
  if (Notification.permission === "denied") {
    return "Notifications are denied. Change browser or OS notification settings to opt in.";
  }
  return null;
}

export function WebPushSettings({
  config,
  subscriptions,
}: {
  config: WebPushConfig;
  subscriptions: WebPushSubscriptionSummary[];
}) {
  const [status, setStatus] = useState("Checking this browser...");
  const [busy, setBusy] = useState(false);
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [testStatus, setTestStatus] = useState<string | null>(null);

  useEffect(() => {
    const reason = detectSupport(config);
    setUnavailable(reason);
    setStatus(reason ? "Unavailable in this browser" : `Permission: ${Notification.permission}`);
    if (reason) {
      return;
    }
    let cancelled = false;
    navigator.serviceWorker
      .getRegistration("/")
      .then(async (registration) => {
        const existing = await registration?.pushManager.getSubscription();
        if (!(cancelled || existing == null)) {
          setEndpoint(existing.endpoint);
          setStatus("Web Push is enabled for this browser.");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setStatus("Could not inspect this browser's Web Push subscription.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [config]);

  async function enable() {
    if (!config.public_key) {
      return;
    }
    setBusy(true);
    try {
      const registration = await navigator.serviceWorker.register("/pdpp-dashboard-sw.js");
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setStatus(
          permission === "denied"
            ? "Permission denied. Enable notifications in browser settings."
            : "Permission was not granted."
        );
        return;
      }
      const subscription =
        (await registration.pushManager.getSubscription()) ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(config.public_key),
        }));
      const response = await fetch("/_ref/web-push/subscriptions", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          subscription: subscription.toJSON(),
          platform: navigator.platform || null,
          device_label: "Dashboard browser",
        }),
      });
      if (!response.ok) {
        throw new Error(`Subscription failed (${response.status})`);
      }
      setEndpoint(subscription.endpoint);
      setStatus("Web Push is enabled for this browser.");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Failed to enable Web Push.");
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    setBusy(true);
    setTestStatus("Sending test notification...");
    try {
      const response = await fetch("/_ref/web-push/test", {
        method: "POST",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        throw new Error(`Test notification failed (${response.status})`);
      }
      const body = (await response.json()) as {
        attempted?: number;
        sent?: number;
        unavailable?: boolean;
      };
      if (body.unavailable) {
        setTestStatus("Web Push is unavailable on the server.");
      } else if ((body.sent ?? 0) > 0) {
        setTestStatus(`Test notification sent to ${body.sent} subscription${body.sent === 1 ? "" : "s"}.`);
      } else if ((body.attempted ?? 0) === 0) {
        setTestStatus("No active subscriptions for this owner. Enable Web Push first.");
      } else {
        setTestStatus("Push provider did not accept the test notification. Re-enable Web Push for this browser.");
      }
    } catch (err) {
      setTestStatus(err instanceof Error ? err.message : "Failed to send test notification.");
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    try {
      const registration = await navigator.serviceWorker.getRegistration("/");
      const subscription = await registration?.pushManager.getSubscription();
      const targetEndpoint = subscription?.endpoint ?? endpoint;
      if (subscription) {
        await subscription.unsubscribe();
      }
      if (targetEndpoint) {
        const response = await fetch("/_ref/web-push/subscriptions", {
          method: "DELETE",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ endpoint: targetEndpoint }),
        });
        if (!response.ok) {
          throw new Error(`Unsubscribe failed (${response.status})`);
        }
      }
      setEndpoint(null);
      setStatus("Web Push is disabled for this browser.");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Failed to disable Web Push.");
    } finally {
      setBusy(false);
    }
  }

  const caveat =
    "iOS and some mobile browsers require installing this dashboard as a PWA and enabling OS notifications. Delivery is best-effort; ntfy/current and in-dashboard pending interactions stay available.";

  return (
    <Section
      description="Optional browser-native alerts for pending connector interactions."
      title="Browser notifications"
    >
      <div className="rounded-lg border border-border/80 bg-card/60 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="pdpp-body font-medium">{status}</p>
            <p className="pdpp-caption mt-1 text-muted-foreground">{unavailable || caveat}</p>
          </div>
          <div className="flex gap-2">
            <button
              className="rounded-md bg-foreground px-3 py-1.5 text-background text-sm disabled:opacity-50"
              disabled={busy || Boolean(unavailable)}
              onClick={enable}
              type="button"
            >
              Enable
            </button>
            <button
              className="rounded-md border border-border px-3 py-1.5 text-sm disabled:opacity-50"
              disabled={busy || !endpoint}
              onClick={disable}
              type="button"
            >
              Disable
            </button>
            <button
              className="rounded-md border border-border px-3 py-1.5 text-sm disabled:opacity-50"
              disabled={busy || !endpoint || Boolean(unavailable)}
              onClick={sendTest}
              type="button"
            >
              Send test
            </button>
          </div>
        </div>
        {testStatus ? <p className="pdpp-caption mt-3 text-muted-foreground">{testStatus}</p> : null}
        {subscriptions.length > 0 ? (
          <p className="pdpp-caption mt-3 text-muted-foreground">
            {subscriptions.length} saved browser subscription{subscriptions.length === 1 ? "" : "s"}. Last status:{" "}
            {subscriptions[0]?.last_failure_reason || subscriptions[0]?.last_success_at || "not used yet"}.
          </p>
        ) : null}
      </div>
    </Section>
  );
}
