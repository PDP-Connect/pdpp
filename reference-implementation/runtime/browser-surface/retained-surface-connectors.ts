import { connectorRetainsSurfaceProcess as policyRetainsSurfaceProcess } from "../../../packages/polyfill-connectors/src/browser-surface-policy.ts";
import { canonicalConnectorKey } from "../../server/connector-key.js";

/**
 * Reference-side adapter over the shared connector-runtime browser-surface
 * policy (`packages/polyfill-connectors/src/browser-surface-policy.ts`). That
 * policy is the single source of truth for both page preservation (consumed by
 * the connector-runtime child) and surface-process retention (consumed here, by
 * the reference implementation's surface-lease caller). This adapter only maps
 * the reference's connector id forms (URLs, aliases) to the bare connector
 * runtime name the policy is keyed by; it holds no policy data of its own.
 *
 * Retention exists because some connectors hold their provider API session in
 * the live browser process, not durable browser storage: stopping the surface
 * process loses auth even with a persistent profile, so the process must survive
 * routine idle-TTL and capacity-pressure reap. The generic remote-surface layer
 * never learns any of this — it receives only a boolean.
 */
export function connectorRetainsSurfaceProcess(connectorId: string): boolean {
  const key = canonicalConnectorKey(connectorId);
  if (key && policyRetainsSurfaceProcess(key)) {
    return true;
  }
  return policyRetainsSurfaceProcess(connectorId);
}
