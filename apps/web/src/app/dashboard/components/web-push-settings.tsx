"use client";

import { useCallback, useEffect, useState } from "react";
import type { WebPushConfig, WebPushSubscriptionSummary } from "../lib/ref-client.ts";
import { Section } from "./primitives.tsx";

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
}

// Each row in the diagnostic checklist. A precondition for a working push.
// `ok: null` means "indeterminate" — surfaced as a neutral marker so the
// owner can tell the difference between "we checked and it's fine" and
// "we couldn't tell from this surface".
type DiagnosticState = "ok" | "warn" | "fail" | "unknown";
interface DiagnosticRow {
  detail: string;
  label: string;
  state: DiagnosticState;
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

function diagnosticMarker(state: DiagnosticState) {
  if (state === "ok") {
    return "✓";
  }
  if (state === "warn") {
    return "⚠";
  }
  if (state === "fail") {
    return "✕";
  }
  return "·";
}

function diagnosticToneClass(state: DiagnosticState) {
  if (state === "ok") {
    return "text-emerald-700 dark:text-emerald-400";
  }
  if (state === "warn") {
    return "text-amber-700 dark:text-amber-400";
  }
  if (state === "fail") {
    return "text-red-700 dark:text-red-400";
  }
  return "text-muted-foreground";
}

function secureContextRow(): DiagnosticRow {
  if (typeof window === "undefined") {
    return { label: "Secure context (HTTPS/localhost)", state: "unknown", detail: "Server-rendered" };
  }
  if (window.isSecureContext) {
    return { label: "Secure context (HTTPS/localhost)", state: "ok", detail: window.location.origin };
  }
  return {
    label: "Secure context (HTTPS/localhost)",
    state: "fail",
    detail: "Page is not served over a secure origin.",
  };
}

function featureRow(label: string, present: boolean, presentDetail: string, missingDetail: string): DiagnosticRow {
  return present ? { label, state: "ok", detail: presentDetail } : { label, state: "fail", detail: missingDetail };
}

function vapidRow(config: WebPushConfig): DiagnosticRow {
  if (config.enabled && config.public_key) {
    return {
      label: "Server VAPID keys configured",
      state: "ok",
      detail: "/_ref/web-push/config reports enabled",
    };
  }
  return {
    label: "Server VAPID keys configured",
    state: "fail",
    detail: config.unavailable_reason || "Server VAPID keys are not configured.",
  };
}

function swRow(swState: "registered" | "absent" | "unknown" | "unsupported"): DiagnosticRow {
  const label = "Service worker registered";
  if (swState === "registered") {
    return { label, state: "ok", detail: "/pdpp-dashboard-sw.js controls /" };
  }
  if (swState === "absent") {
    return { label, state: "warn", detail: "Not registered yet — tap Enable." };
  }
  if (swState === "unsupported") {
    return { label, state: "fail", detail: "Browser lacks serviceWorker." };
  }
  return { label, state: "unknown", detail: "Could not inspect registration." };
}

function permissionRow(permission: NotificationPermission | "unknown"): DiagnosticRow {
  const label = "Notification permission granted";
  if (permission === "granted") {
    return { label, state: "ok", detail: 'Notification.permission === "granted"' };
  }
  if (permission === "denied") {
    return {
      label,
      state: "fail",
      detail: 'Notification.permission === "denied" — change browser/OS notification settings to opt in.',
    };
  }
  if (permission === "default") {
    return { label, state: "warn", detail: "Permission has not been requested on this device — tap Enable." };
  }
  return { label, state: "unknown", detail: "Notification API not available." };
}

function browserSubscriptionRow(endpoint: string | null, matchesThisBrowser: boolean): DiagnosticRow {
  const label = "Browser push subscription active";
  if (!endpoint) {
    return {
      label,
      state: "warn",
      detail:
        "No active subscription on this device — tap Enable to create one (installing the PWA alone does not subscribe).",
    };
  }
  if (matchesThisBrowser) {
    return { label, state: "ok", detail: "Browser endpoint is registered for this owner on the server." };
  }
  return {
    label,
    state: "warn",
    detail: "Browser has a subscription but the server does not list it for this owner — tap Enable to re-register.",
  };
}

function deliveryHealthRow(lastSubscription: WebPushSubscriptionSummary | undefined): DiagnosticRow {
  const label = "Last delivery health";
  if (lastSubscription?.last_failure_reason) {
    return {
      label,
      state: "warn",
      detail: `Most recent failure: ${lastSubscription.last_failure_reason} (${lastSubscription.last_failure_at ?? "unknown time"}). Tap Enable on the affected device to re-subscribe.`,
    };
  }
  if (lastSubscription?.last_success_at) {
    return { label, state: "ok", detail: `Last success: ${lastSubscription.last_success_at}.` };
  }
  return { label, state: "unknown", detail: "No delivery attempt recorded yet." };
}

function buildDiagnostics({
  config,
  swState,
  permission,
  endpoint,
  matchesThisBrowser,
  subscriptions,
  lastSubscription,
}: {
  config: WebPushConfig;
  swState: "registered" | "absent" | "unknown" | "unsupported";
  permission: NotificationPermission | "unknown";
  endpoint: string | null;
  matchesThisBrowser: boolean;
  subscriptions: WebPushSubscriptionSummary[];
  lastSubscription: WebPushSubscriptionSummary | undefined;
}): DiagnosticRow[] {
  return [
    secureContextRow(),
    featureRow(
      "Service Worker API available",
      "serviceWorker" in navigator,
      "navigator.serviceWorker present",
      "Browser does not expose serviceWorker."
    ),
    featureRow(
      "Push API (PushManager) available",
      "PushManager" in window,
      "window.PushManager present",
      "Browser does not expose PushManager."
    ),
    featureRow(
      "Notification API available",
      "Notification" in window,
      "window.Notification present",
      "Browser does not expose Notification."
    ),
    vapidRow(config),
    swRow(swState),
    permissionRow(permission),
    browserSubscriptionRow(endpoint, matchesThisBrowser),
    {
      label: "Server-tracked subscriptions for this owner",
      state: subscriptions.length > 0 ? "ok" : "warn",
      detail:
        subscriptions.length > 0
          ? `${subscriptions.length} saved across all of this owner's devices.`
          : "Server has no saved subscriptions yet for this owner.",
    },
    deliveryHealthRow(lastSubscription),
  ];
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
  const [permission, setPermission] = useState<NotificationPermission | "unknown">("unknown");
  const [swState, setSwState] = useState<"registered" | "absent" | "unknown" | "unsupported">("unknown");
  const [showDetails, setShowDetails] = useState(false);

  const refreshSubscriptionState = useCallback(async () => {
    if (!("serviceWorker" in navigator)) {
      setSwState("unsupported");
      return;
    }
    try {
      const registration = await navigator.serviceWorker.getRegistration("/");
      setSwState(registration ? "registered" : "absent");
      const existing = await registration?.pushManager.getSubscription();
      setEndpoint(existing?.endpoint ?? null);
    } catch {
      setSwState("unknown");
    }
  }, []);

  useEffect(() => {
    const reason = detectSupport(config);
    setUnavailable(reason);
    if ("Notification" in window) {
      setPermission(Notification.permission);
    }
    setStatus(reason ? "Unavailable in this browser" : `Permission: ${Notification.permission}`);
    if (reason) {
      return;
    }
    let cancelled = false;
    navigator.serviceWorker
      .getRegistration("/")
      .then(async (registration) => {
        if (cancelled) {
          return;
        }
        setSwState(registration ? "registered" : "absent");
        const existing = await registration?.pushManager.getSubscription();
        if (cancelled) {
          return;
        }
        if (existing) {
          setEndpoint(existing.endpoint);
          setStatus("Web Push is enabled for this browser.");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSwState("unknown");
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
      setSwState("registered");
      const result = await Notification.requestPermission();
      setPermission(result);
      if (result !== "granted") {
        setStatus(
          result === "denied"
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

  // Per-device install reminder. Each browser/PWA install needs its own
  // pushManager.subscribe() — installing the PWA does not create a push
  // subscription on its own.
  const caveat =
    "iOS and some mobile browsers require installing this dashboard as a PWA and enabling OS notifications. Each device must tap Enable here once; ntfy/current and in-dashboard pending interactions stay available.";

  const lastSubscription = subscriptions[0];
  const matchesThisBrowser = endpoint ? subscriptions.some((s) => s.endpoint === endpoint && !s.revoked_at) : false;

  const diagnostics = buildDiagnostics({
    config,
    swState,
    permission,
    endpoint,
    matchesThisBrowser,
    subscriptions,
    lastSubscription,
  });

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
            {lastSubscription?.last_failure_reason || lastSubscription?.last_success_at || "not used yet"}.
          </p>
        ) : null}

        <div className="mt-4 border-border/60 border-t pt-3">
          <button
            aria-controls="web-push-diagnostics"
            aria-expanded={showDetails}
            className="pdpp-caption text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            onClick={async () => {
              const next = !showDetails;
              setShowDetails(next);
              if (next) {
                await refreshSubscriptionState();
              }
            }}
            type="button"
          >
            {showDetails ? "Hide diagnostics" : "Show diagnostics"}
          </button>
          {showDetails ? (
            <ul aria-label="Web Push diagnostics" className="mt-3 space-y-1.5" id="web-push-diagnostics">
              {diagnostics.map((row) => (
                <li className="pdpp-caption flex items-start gap-2" key={row.label}>
                  <span
                    aria-hidden="true"
                    className={`inline-block w-4 shrink-0 font-mono ${diagnosticToneClass(row.state)}`}
                  >
                    {diagnosticMarker(row.state)}
                  </span>
                  <span className="min-w-0">
                    <span className="font-medium text-foreground">{row.label}</span>
                    <span className="ml-2 text-muted-foreground">{row.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </Section>
  );
}
