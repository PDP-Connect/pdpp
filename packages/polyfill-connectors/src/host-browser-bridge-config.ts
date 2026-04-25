/**
 * Host-browser bridge configuration resolver.
 *
 * Pure env-var parsing for the Dockerized container side of the host
 * browser bridge. The container reads these to decide whether to
 * acquire a browser by attaching to the host bridge instead of
 * launching one locally.
 *
 * Spec: openspec/changes/design-host-browser-bridge-for-docker/design.md
 *
 * Container-side env:
 *
 *   PDPP_HOST_BROWSER_BRIDGE_URL
 *     WS endpoint of the bridge as reachable from the container.
 *     Typically `ws://host.docker.internal:7670`. When unset, the
 *     container falls back to its native isolated launcher.
 *
 *   PDPP_HOST_BROWSER_BRIDGE_TOKEN
 *     Required when PDPP_HOST_BROWSER_BRIDGE_URL is set. Shared secret
 *     the bridge expects on every connection. Empty/whitespace counts
 *     as unset and produces a config error rather than a silent
 *     unauthenticated connection.
 *
 *   PDPP_HOST_BROWSER_BRIDGE_DAILY_CHROME
 *     Explicit opt-in escape hatch that acknowledges the bridge is
 *     pointed at a host Chrome which may be the operator's daily
 *     profile. Must be set to "1" to count as opted-in. The runtime
 *     emits a per-run warning whenever this is on. Off by default.
 */

export interface HostBrowserBridgeConfig {
  readonly dailyChromeAcknowledged: boolean;
  readonly token: string;
  readonly url: string;
}

export type HostBrowserBridgeResolution =
  | { readonly mode: "disabled" }
  | { readonly mode: "configured"; readonly config: HostBrowserBridgeConfig }
  | { readonly mode: "misconfigured"; readonly reason: string };

const URL_VAR = "PDPP_HOST_BROWSER_BRIDGE_URL";
const TOKEN_VAR = "PDPP_HOST_BROWSER_BRIDGE_TOKEN";
const DAILY_CHROME_VAR = "PDPP_HOST_BROWSER_BRIDGE_DAILY_CHROME";

const URL_RE = /^wss?:\/\/[^\s]+$/i;

function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined) {
    return;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Resolve container-side bridge configuration from process.env.
 *
 * Returns one of three modes:
 *   - "disabled": URL is unset → caller should use the native launcher.
 *   - "configured": URL+token are valid → caller should attach to the bridge.
 *   - "misconfigured": URL is set but token is missing or URL is malformed →
 *     caller MUST fail the run; falling back to a native launcher would
 *     silently bypass operator intent.
 */
export function resolveHostBrowserBridgeConfig(env: NodeJS.ProcessEnv = process.env): HostBrowserBridgeResolution {
  const url = readEnv(env, URL_VAR);
  if (!url) {
    // If only the token or escape-hatch flag is set without a URL, that's
    // user confusion worth surfacing rather than treating as "disabled."
    if (readEnv(env, TOKEN_VAR) || readEnv(env, DAILY_CHROME_VAR)) {
      return {
        mode: "misconfigured",
        reason: `${TOKEN_VAR} or ${DAILY_CHROME_VAR} is set but ${URL_VAR} is empty; either set ${URL_VAR} or unset the others.`,
      };
    }
    return { mode: "disabled" };
  }

  if (!URL_RE.test(url)) {
    return {
      mode: "misconfigured",
      reason: `${URL_VAR}=${url} must be a ws:// or wss:// URL.`,
    };
  }

  const token = readEnv(env, TOKEN_VAR);
  if (!token) {
    return {
      mode: "misconfigured",
      reason: `${URL_VAR} is set but ${TOKEN_VAR} is empty; refusing to connect unauthenticated.`,
    };
  }

  const dailyChromeAcknowledged = readEnv(env, DAILY_CHROME_VAR) === "1";

  return {
    mode: "configured",
    config: { url, token, dailyChromeAcknowledged },
  };
}

/**
 * Stable error code emitted when the runtime is configured to use the
 * bridge but the bridge cannot be reached or rejects the connection.
 * The dashboard renders this as a deployment-config error state, not a
 * generic pending interaction. See design.md § Failure Mode.
 */
export const HOST_BROWSER_BRIDGE_UNAVAILABLE_CODE = "host_browser_bridge_unavailable";

/**
 * Build the actionable error message the runtime surfaces when the
 * bridge is configured but unreachable. Includes the URL the operator
 * configured plus a copy-paste hint to verify the host bridge is
 * running and the token matches.
 */
export function hostBrowserBridgeUnavailableMessage(args: { url: string; cause: string }): string {
  return [
    `Host browser bridge unavailable at ${args.url}: ${args.cause}.`,
    "Ensure the host bridge is running",
    "(`pnpm --dir packages/polyfill-connectors exec tsx bin/host-browser-bridge.ts --profile <name>`)",
    "and that PDPP_HOST_BROWSER_BRIDGE_TOKEN matches the token printed by the bridge.",
  ].join(" ");
}
