"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { buttonVariants } from "@pdpp/brand-react";
import { Section } from "@pdpp/operator-ui/components/primitives";
import { useEffect, useReducer, useState } from "react";
import type { WebPushConfig, WebPushSubscriptionSummary } from "../lib/ref-client.ts";

type SwState = "registered" | "absent" | "unknown" | "unsupported";

// The runtime state for *this* browser/device: whether Web Push is usable, the
// notification permission, the service-worker registration, and the active push
// endpoint, plus the human-readable status line. These all change together as
// the async inspection settles and as the owner enables/disables this device,
// so they live in one reducer (atomic transitions, no cascading re-renders).
interface DeviceState {
  endpoint: string | null;
  permission: NotificationPermission | "unknown";
  status: string;
  swState: SwState;
  unavailable: string | null;
}

type DeviceAction =
  | {
      type: "supportDetected";
      permission: NotificationPermission | "unknown";
      status: string;
      unavailable: string | null;
    }
  | { type: "swState"; swState: SwState; status?: string }
  | { type: "subscribed"; endpoint: string; status: string }
  | { type: "disabled"; status: string }
  | { type: "endpoint"; endpoint: string | null }
  | { type: "permission"; permission: NotificationPermission | "unknown" }
  | { type: "status"; status: string };

function deviceReducer(state: DeviceState, action: DeviceAction): DeviceState {
  switch (action.type) {
    case "supportDetected":
      return { ...state, permission: action.permission, status: action.status, unavailable: action.unavailable };
    case "swState":
      return action.status === undefined
        ? { ...state, swState: action.swState }
        : { ...state, status: action.status, swState: action.swState };
    case "subscribed":
      return { ...state, endpoint: action.endpoint, status: action.status };
    case "disabled":
      return { ...state, endpoint: null, status: action.status };
    case "endpoint":
      return { ...state, endpoint: action.endpoint };
    case "permission":
      return { ...state, permission: action.permission };
    case "status":
      return { ...state, status: action.status };
    default:
      return state;
  }
}

const INITIAL_DEVICE_STATE: DeviceState = {
  endpoint: null,
  permission: "unknown",
  status: "Checking this browser…",
  swState: "unknown",
  unavailable: null,
};

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
}

// Each row in the diagnostic checklist. Unknown state means indeterminate,
// so the owner can distinguish "checked and fine" from "could not tell here".
type DiagnosticState = "ok" | "warn" | "fail" | "unknown";
interface DiagnosticRow {
  detail: string;
  label: string;
  state: DiagnosticState;
}

interface DeviceStatus {
  detail: string;
  title: string;
}

interface SetupStep {
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
    return "[ok]";
  }
  if (state === "warn") {
    return "[!]";
  }
  if (state === "fail") {
    return "[x]";
  }
  return "[?]";
}

function hasWindowFeature(feature: string) {
  return typeof window !== "undefined" && feature in window;
}

function hasNavigatorFeature(feature: string) {
  return typeof navigator !== "undefined" && feature in navigator;
}

async function webPushResponseError(response: Response, fallbackAction: string) {
  let detail: string | null = null;
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string }; message?: string };
    detail = body.error?.message || body.message || body.error?.code || null;
  } catch {
    detail = null;
  }
  return new Error(detail ? `${fallbackAction}: ${detail}` : `${fallbackAction} (${response.status})`);
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

function setupStepToneClass(state: DiagnosticState) {
  if (state === "ok") {
    return "border-[color:var(--success)]/30 bg-[color:var(--success-wash)] text-foreground";
  }
  if (state === "fail") {
    return "border-destructive/30 bg-destructive/5 text-foreground";
  }
  if (state === "warn") {
    return "border-[color:var(--warning)]/30 bg-[color:var(--warning-wash)] text-foreground";
  }
  return "border-border bg-muted/40 text-foreground";
}

function secureContextRow(): DiagnosticRow {
  if (typeof window === "undefined") {
    return { detail: "Server-rendered", label: "Secure context (HTTPS/localhost)", state: "unknown" };
  }
  if (window.isSecureContext) {
    return { detail: window.location.origin, label: "Secure context (HTTPS/localhost)", state: "ok" };
  }
  return {
    detail: "Page is not served over a secure origin.",
    label: "Secure context (HTTPS/localhost)",
    state: "fail",
  };
}

function featureRow(label: string, present: boolean, presentDetail: string, missingDetail: string): DiagnosticRow {
  return present ? { detail: presentDetail, label, state: "ok" } : { detail: missingDetail, label, state: "fail" };
}

function vapidRow(config: WebPushConfig): DiagnosticRow {
  if (config.enabled && config.public_key) {
    return {
      detail: "/_ref/web-push/config reports enabled",
      label: "Server VAPID keys configured",
      state: "ok",
    };
  }
  return {
    detail: config.unavailable_reason || "Server VAPID keys are not configured.",
    label: "Server VAPID keys configured",
    state: "fail",
  };
}

function swRow(swState: "registered" | "absent" | "unknown" | "unsupported"): DiagnosticRow {
  const label = "Service worker registered";
  if (swState === "registered") {
    return { detail: "The PDPP service worker controls /.", label, state: "ok" };
  }
  if (swState === "absent") {
    return { detail: "Not registered yet - use Enable this device.", label, state: "warn" };
  }
  if (swState === "unsupported") {
    return { detail: "Browser lacks serviceWorker.", label, state: "fail" };
  }
  return { detail: "Could not inspect registration.", label, state: "unknown" };
}

function permissionRow(permission: NotificationPermission | "unknown"): DiagnosticRow {
  const label = "Notification permission granted";
  if (permission === "granted") {
    return { detail: 'Notification.permission === "granted"', label, state: "ok" };
  }
  if (permission === "denied") {
    return {
      detail: 'Notification.permission === "denied" - change browser/OS notification settings to opt in.',
      label,
      state: "fail",
    };
  }
  if (permission === "default") {
    return {
      detail: "Permission has not been requested on this device - use Enable this device.",
      label,
      state: "warn",
    };
  }
  return { detail: "Notification API not available.", label, state: "unknown" };
}

function browserSubscriptionRow(endpoint: string | null, matchesThisBrowser: boolean): DiagnosticRow {
  const label = "Browser push subscription active";
  if (!endpoint) {
    return {
      detail:
        "No active subscription on this device - use Enable this device to create one (installing the PWA alone does not subscribe).",
      label,
      state: "warn",
    };
  }
  if (matchesThisBrowser) {
    return { detail: "Browser endpoint is registered for this owner on the server.", label, state: "ok" };
  }
  return {
    detail:
      "Browser has a subscription but the server does not list it for this owner - use Enable this device to re-register.",
    label,
    state: "warn",
  };
}

function deliveryHealthRow(lastSubscription: WebPushSubscriptionSummary | undefined): DiagnosticRow {
  const label = "Last delivery health";
  if (lastSubscription?.last_failure_reason) {
    return {
      detail: `Most recent failure: ${lastSubscription.last_failure_reason} (${lastSubscription.last_failure_at ?? "unknown time"}). Use Enable this device on the affected device to re-subscribe.`,
      label,
      state: "warn",
    };
  }
  if (lastSubscription?.last_success_at) {
    return { detail: `Last success: ${lastSubscription.last_success_at}.`, label, state: "ok" };
  }
  return { detail: "No delivery attempt recorded yet.", label, state: "unknown" };
}

function deviceStatus({
  unavailable,
  permission,
  endpoint,
  matchesThisBrowser,
  swState,
}: {
  unavailable: string | null;
  permission: NotificationPermission | "unknown";
  endpoint: string | null;
  matchesThisBrowser: boolean;
  swState: "registered" | "absent" | "unknown" | "unsupported";
}): DeviceStatus {
  if (unavailable) {
    return {
      detail: unavailable,
      title: "This browser cannot receive PDPP notifications.",
    };
  }
  if (permission === "unknown" && swState === "unknown") {
    return {
      detail: "Inspecting browser permission and subscription state.",
      title: "Checking this device…",
    };
  }
  if (permission === "denied") {
    return {
      detail: "Change browser or OS notification settings, then return here and enable this device.",
      title: "Notifications are blocked for this browser.",
    };
  }
  if (matchesThisBrowser) {
    return {
      detail: "Pending connector interactions can send browser notifications to this browser or installed app.",
      title: "This device is subscribed.",
    };
  }
  if (endpoint) {
    return {
      detail: "Enable this device again to repair the server-side subscription.",
      title: "This browser has a local subscription, but the server does not recognize it.",
    };
  }
  if (permission === "granted") {
    return {
      detail: "Enable this device once so PDPP can send alerts here.",
      title: "Notifications are allowed, but this device is not subscribed.",
    };
  }
  return {
    detail: "Installing the PWA only adds the app icon. You still need to enable notifications from this device.",
    title: "This device is not subscribed yet.",
  };
}

function buildSetupSteps({
  unavailable,
  permission,
  endpoint,
  matchesThisBrowser,
  testStatus,
}: {
  unavailable: string | null;
  permission: NotificationPermission | "unknown";
  endpoint: string | null;
  matchesThisBrowser: boolean;
  testStatus: string | null;
}): SetupStep[] {
  const testNotificationAccepted = isTestNotificationAccepted(testStatus);

  return [
    {
      detail: "This page configures notifications only for the browser or installed app you are using right now.",
      label: "Open the right device",
      state: "ok",
    },
    {
      detail: setupPermissionDetail(permission),
      label: "Allow notifications",
      state: setupPermissionState(permission, unavailable),
    },
    {
      detail: setupSubscriptionDetail({ endpoint, matchesThisBrowser }),
      label: "Subscribe this device",
      state: setupSubscriptionState({ matchesThisBrowser, unavailable }),
    },
    {
      detail: testNotificationAccepted
        ? "The push provider accepted the test. Only the device can confirm whether it displayed."
        : "Use Send test notification after this device is subscribed.",
      label: "Send a test",
      state: setupTestState({ matchesThisBrowser, testNotificationAccepted }),
    },
  ];
}

function setupPermissionState(
  permission: NotificationPermission | "unknown",
  unavailable: string | null
): DiagnosticState {
  if (permission === "granted") {
    return "ok";
  }
  if (permission === "denied" || unavailable) {
    return "fail";
  }
  return "warn";
}

function setupPermissionDetail(permission: NotificationPermission | "unknown"): string {
  if (permission === "granted") {
    return "Browser permission is granted.";
  }
  if (permission === "denied") {
    return "Browser or OS settings currently block notifications.";
  }
  return "Tap Enable this device and approve the browser prompt.";
}

function setupSubscriptionState({
  matchesThisBrowser,
  unavailable,
}: {
  matchesThisBrowser: boolean;
  unavailable: string | null;
}): DiagnosticState {
  if (matchesThisBrowser) {
    return "ok";
  }
  if (unavailable) {
    return "fail";
  }
  return "warn";
}

function setupSubscriptionDetail({
  endpoint,
  matchesThisBrowser,
}: {
  endpoint: string | null;
  matchesThisBrowser: boolean;
}): string {
  if (matchesThisBrowser) {
    return "The server recognizes this browser's push subscription.";
  }
  if (endpoint) {
    return "The browser has a local subscription, but the server needs it re-registered.";
  }
  return "A PWA install is not enough; this step creates the push subscription.";
}

function setupTestState({
  matchesThisBrowser,
  testNotificationAccepted,
}: {
  matchesThisBrowser: boolean;
  testNotificationAccepted: boolean;
}): DiagnosticState {
  if (testNotificationAccepted || matchesThisBrowser) {
    return "unknown";
  }
  return "warn";
}

function isTestNotificationAccepted(testStatus: string | null): boolean {
  return (
    testStatus?.startsWith("Test notification sent") === true ||
    testStatus?.startsWith("Test notification delivered") === true
  );
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
      hasNavigatorFeature("serviceWorker"),
      "navigator.serviceWorker present",
      "Browser does not expose serviceWorker."
    ),
    featureRow(
      "Push API (PushManager) available",
      hasWindowFeature("PushManager"),
      "window.PushManager present",
      "Browser does not expose PushManager."
    ),
    featureRow(
      "Notification API available",
      hasWindowFeature("Notification"),
      "window.Notification present",
      "Browser does not expose Notification."
    ),
    vapidRow(config),
    swRow(swState),
    permissionRow(permission),
    browserSubscriptionRow(endpoint, matchesThisBrowser),
    {
      detail:
        subscriptions.length > 0
          ? `${subscriptions.length} saved across all of this owner's devices.`
          : "Server has no saved subscriptions yet for this owner.",
      label: "Server-tracked subscriptions for this owner",
      state: subscriptions.length > 0 ? "ok" : "warn",
    },
    deliveryHealthRow(lastSubscription),
  ];
}

// Collapsible per-precondition checklist. Presentational: the parent owns the
// device state and re-inspection, this only renders the rows and the toggle.
function DiagnosticsDisclosure({
  diagnostics,
  expanded,
  onToggle,
}: {
  diagnostics: DiagnosticRow[];
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="mt-4 border-border/60 border-t pt-3">
      <button
        aria-controls="web-push-diagnostics"
        aria-expanded={expanded}
        className="pdpp-caption text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        onClick={onToggle}
        type="button"
      >
        {expanded ? "Hide diagnostics" : "Show diagnostics"}
      </button>
      {expanded ? (
        <ul aria-label="Web Push diagnostics" className="mt-3 space-y-1.5" id="web-push-diagnostics">
          {diagnostics.map((row) => (
            <li className="pdpp-caption flex items-start gap-2" key={row.label}>
              <span
                aria-hidden="true"
                className={`inline-block w-10 shrink-0 font-mono ${diagnosticToneClass(row.state)}`}
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
  );
}

export function WebPushSettings({
  config,
  subscriptions,
}: {
  config: WebPushConfig;
  subscriptions: WebPushSubscriptionSummary[];
}) {
  const [device, dispatch] = useReducer(deviceReducer, INITIAL_DEVICE_STATE);
  const { status, endpoint, unavailable, permission, swState } = device;
  const [busy, setBusy] = useState(false);
  const [testStatus, setTestStatus] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [showSetup, setShowSetup] = useState(false);

  async function refreshSubscriptionState() {
    if (!hasNavigatorFeature("serviceWorker")) {
      dispatch({ swState: "unsupported", type: "swState" });
      return;
    }
    try {
      const registration = await navigator.serviceWorker.getRegistration("/");
      await registration?.update().catch(() => undefined);
      dispatch({ swState: registration ? "registered" : "absent", type: "swState" });
      const existing = await registration?.pushManager.getSubscription();
      dispatch({ endpoint: existing?.endpoint ?? null, type: "endpoint" });
    } catch {
      dispatch({ swState: "unknown", type: "swState" });
    }
  }

  useEffect(() => {
    const reason = detectSupport(config);
    dispatch({
      permission: "Notification" in window ? Notification.permission : "unknown",
      status: reason ? "Unavailable in this browser" : `Permission: ${Notification.permission}`,
      type: "supportDetected",
      unavailable: reason,
    });
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
        dispatch({ swState: registration ? "registered" : "absent", type: "swState" });
        await registration?.update().catch(() => undefined);
        const existing = await registration?.pushManager.getSubscription();
        if (cancelled) {
          return;
        }
        if (existing) {
          dispatch({
            endpoint: existing.endpoint,
            status: "Web Push is enabled for this browser.",
            type: "subscribed",
          });
        }
      })
      .catch(() => {
        if (!cancelled) {
          dispatch({
            status: "Could not inspect this browser's Web Push subscription.",
            swState: "unknown",
            type: "swState",
          });
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
    setTestStatus(null);
    try {
      const registration = await navigator.serviceWorker.register("/pdpp-dashboard-sw.js");
      dispatch({ swState: "registered", type: "swState" });
      const result = await Notification.requestPermission();
      dispatch({ permission: result, type: "permission" });
      if (result !== "granted") {
        dispatch({
          status:
            result === "denied"
              ? "Permission denied. Enable notifications in browser settings."
              : "Permission was not granted.",
          type: "status",
        });
        return;
      }
      const subscription =
        (await registration.pushManager.getSubscription()) ??
        (await registration.pushManager.subscribe({
          applicationServerKey: urlBase64ToUint8Array(config.public_key),
          userVisibleOnly: true,
        }));
      const response = await fetch("/_ref/web-push/subscriptions", {
        body: JSON.stringify({
          device_label: "PDPP browser",
          platform: navigator.platform || null,
          subscription: subscription.toJSON(),
        }),
        credentials: "same-origin",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        method: "POST",
      });
      if (!response.ok) {
        throw await webPushResponseError(response, "Subscription failed");
      }
      dispatch({
        endpoint: subscription.endpoint,
        status: "Web Push is enabled for this browser.",
        type: "subscribed",
      });
    } catch (err) {
      dispatch({ status: err instanceof Error ? err.message : "Failed to enable Web Push.", type: "status" });
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    setBusy(true);
    setTestStatus("Sending test notification…");
    try {
      const response = await fetch("/_ref/web-push/test", {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        method: "POST",
      });
      if (!response.ok) {
        throw await webPushResponseError(response, "Test notification failed");
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
        setTestStatus("No active subscriptions for this owner. Enable this device first.");
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
    setTestStatus(null);
    try {
      const registration = await navigator.serviceWorker.getRegistration("/");
      const subscription = await registration?.pushManager.getSubscription();
      const targetEndpoint = subscription?.endpoint ?? endpoint;
      if (subscription) {
        await subscription.unsubscribe();
      }
      if (targetEndpoint) {
        const response = await fetch("/_ref/web-push/subscriptions", {
          body: JSON.stringify({ endpoint: targetEndpoint }),
          credentials: "same-origin",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          method: "DELETE",
        });
        if (!response.ok) {
          throw await webPushResponseError(response, "Unsubscribe failed");
        }
      }
      dispatch({ status: "Web Push is disabled for this browser.", type: "disabled" });
    } catch (err) {
      dispatch({ status: err instanceof Error ? err.message : "Failed to disable Web Push.", type: "status" });
    } finally {
      setBusy(false);
    }
  }

  // Per-device install reminder. Each browser/PWA install needs its own
  // pushManager.subscribe() — installing the PWA does not create a push
  // subscription on its own.
  const caveat =
    "Mobile browsers may require opening the installed PDPP app before notifications can arrive. Each phone, tablet, and browser profile must be enabled separately.";

  const [lastSubscription] = subscriptions;
  const matchesThisBrowser = endpoint ? subscriptions.some((s) => s.endpoint === endpoint && !s.revoked_at) : false;
  const currentDeviceStatus = deviceStatus({ endpoint, matchesThisBrowser, permission, swState, unavailable });
  const setupSteps = buildSetupSteps({ endpoint, matchesThisBrowser, permission, testStatus, unavailable });

  const diagnostics = buildDiagnostics({
    config,
    endpoint,
    lastSubscription,
    matchesThisBrowser,
    permission,
    subscriptions,
    swState,
  });

  // Whether this browser is set up and healthy, so the demoted summary line can
  // wear a calm "enabled" tone and skip pushing a setup CTA.
  const enabled = matchesThisBrowser && !unavailable;
  let setupToggleLabel = "Set up notifications";
  if (showSetup) {
    setupToggleLabel = "Hide setup";
  } else if (enabled) {
    setupToggleLabel = "Manage";
  }

  return (
    <Section
      description="Optional browser-native alerts for pending connector interactions."
      title="Browser notifications"
    >
      <div className="rounded-md border border-border bg-card px-4 py-3">
        {/* Demoted-by-default summary: one quiet status line + a single
            affordance. The full multi-step setup grid and diagnostics live
            behind the "Set up notifications" / "Manage" disclosure so this reads
            as a calm secondary utility rather than the loudest block on the
            overview. */}
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <p aria-atomic="true" aria-live="polite" className="pdpp-body flex min-w-0 items-center gap-2" role="status">
            <span
              aria-hidden="true"
              className={`size-2 shrink-0 rounded-full ${enabled ? "bg-[color:var(--success)]" : "bg-muted-foreground/50"}`}
            />
            <span className="min-w-0 font-medium text-foreground">{currentDeviceStatus.title}</span>
          </p>
          <div className="flex shrink-0 items-center gap-2">
            {enabled || unavailable ? null : (
              <button
                className={buttonVariants({ size: "sm", variant: "default" })}
                disabled={busy}
                onClick={enable}
                type="button"
              >
                Enable this device
              </button>
            )}
            <button
              aria-controls="web-push-setup"
              aria-expanded={showSetup}
              className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted/40"
              onClick={() => setShowSetup((open) => !open)}
              type="button"
            >
              {setupToggleLabel}
            </button>
          </div>
        </div>

        {showSetup ? (
          <WebPushSetupDetails
            busy={busy}
            caveat={caveat}
            detail={currentDeviceStatus.detail}
            diagnostics={diagnostics}
            endpoint={endpoint}
            lastSubscription={lastSubscription}
            onDisable={disable}
            onEnable={enable}
            onTest={sendTest}
            onToggleDetails={async () => {
              const next = !showDetails;
              setShowDetails(next);
              if (next) {
                await refreshSubscriptionState();
              }
            }}
            setupSteps={setupSteps}
            showDetails={showDetails}
            status={status}
            subscriptionsCount={subscriptions.length}
            testStatus={testStatus}
            unavailable={unavailable}
          />
        ) : null}
      </div>
    </Section>
  );
}

// The full, on-demand setup surface for a single browser/device: the buttons,
// the four-step checklist, the live status lines, and the diagnostics
// disclosure. Kept presentational (the parent owns device state, the async
// flows, and the disclosure toggles) so WebPushSettings stays a lean
// orchestrator and this dense block only mounts when the owner opens it.
function WebPushSetupDetails({
  detail,
  caveat,
  busy,
  unavailable,
  endpoint,
  onEnable,
  onDisable,
  onTest,
  setupSteps,
  status,
  testStatus,
  subscriptionsCount,
  lastSubscription,
  diagnostics,
  showDetails,
  onToggleDetails,
}: {
  detail: string;
  caveat: string;
  busy: boolean;
  unavailable: string | null;
  endpoint: string | null;
  onEnable: () => void;
  onDisable: () => void;
  onTest: () => void;
  setupSteps: SetupStep[];
  status: string;
  testStatus: string | null;
  subscriptionsCount: number;
  lastSubscription: WebPushSubscriptionSummary | undefined;
  diagnostics: DiagnosticRow[];
  showDetails: boolean;
  onToggleDetails: () => void;
}) {
  return (
    <div className="mt-4 border-border/60 border-t pt-4" id="web-push-setup">
      <p className="pdpp-caption max-w-3xl text-muted-foreground">{detail}</p>
      <p className="pdpp-caption mt-1 max-w-3xl text-muted-foreground">{caveat}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          className={buttonVariants({ size: "sm", variant: "default" })}
          disabled={busy || Boolean(unavailable)}
          onClick={onEnable}
          type="button"
        >
          Enable this device
        </button>
        <button
          className="rounded-md border border-border px-3 py-1.5 text-sm disabled:opacity-50"
          disabled={busy || !endpoint}
          onClick={onDisable}
          type="button"
        >
          Disable this device
        </button>
        <button
          className="rounded-md border border-border px-3 py-1.5 text-sm disabled:opacity-50"
          disabled={busy || !endpoint || Boolean(unavailable)}
          onClick={onTest}
          type="button"
        >
          Send test notification
        </button>
      </div>
      <ol className="mt-4 grid gap-2 md:grid-cols-4">
        {setupSteps.map((step) => (
          <li className={`rounded-md border px-3 py-2 ${setupStepToneClass(step.state)}`} key={step.label}>
            <div className="pdpp-caption flex items-center gap-2 font-medium">
              <span aria-hidden="true" className={`font-mono ${diagnosticToneClass(step.state)}`}>
                {diagnosticMarker(step.state)}
              </span>
              {step.label}
            </div>
            <p className="pdpp-caption mt-1 text-muted-foreground">{step.detail}</p>
          </li>
        ))}
      </ol>
      <div aria-atomic="true" aria-live="polite" role="status">
        <p className="pdpp-caption mt-3 text-muted-foreground">Last check: {status}</p>
        {testStatus ? <p className="pdpp-caption mt-3 text-muted-foreground">{testStatus}</p> : null}
      </div>
      {subscriptionsCount > 0 ? (
        <p className="pdpp-caption mt-3 text-muted-foreground">
          {subscriptionsCount} saved browser subscription{subscriptionsCount === 1 ? "" : "s"}. Last status:{" "}
          {lastSubscription?.last_failure_reason || lastSubscription?.last_success_at || "not used yet"}.
        </p>
      ) : null}

      <DiagnosticsDisclosure diagnostics={diagnostics} expanded={showDetails} onToggle={onToggleDetails} />
    </div>
  );
}
