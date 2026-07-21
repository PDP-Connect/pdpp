/**
 * Reference-only browser-surface policy for browser-backed connectors.
 *
 * This is the single source of truth for how a connector's live browser page and
 * managed surface process are treated. Two facts are declared together because
 * they are the same fact seen from two layers:
 *
 *   - `preservePageOnSuccess` / `preservePageOnFailure`: the connector-runtime
 *     child keeps its Chromium page open after a run instead of closing it,
 *     because the source's provider auth is held in the live page rather than
 *     durable browser storage.
 *   - `retainSurfaceProcess`: the reference implementation's surface-lease caller
 *     keeps the managed surface *process* alive across routine idle-TTL and
 *     capacity-pressure reap, for the same reason — stopping the process loses
 *     the provider API session even with a persistent profile.
 *
 * Keeping both on one record removes the "set the page flags here AND register
 * retention there" maintenance trap: a connector's browser policy is stated once.
 *
 * Boundary: this is connector-runtime policy, NOT PDPP Core and NOT a Collection
 * Profile / manifest field. It lives in the polyfill-connectors package (the
 * connector-runtime layer), is side-effect-free, and is intentionally NOT
 * re-exported from the runner barrel (`src/runner/index.ts`) so it is a targeted
 * import for the connector entry and the reference lease caller, not a broad
 * connector-runtime surface. Keys are bare connector runtime names (the `name`
 * passed to `runConnector`, post registry-prefix strip), matching the
 * `credential-probe` registry convention.
 */

export interface BrowserSurfacePolicy {
  /** Keep the run page open after a failed run for later repair/reuse. */
  readonly preservePageOnFailure: boolean;
  /** Reuse and keep the run page open after a successful run. */
  readonly preservePageOnSuccess: boolean;
  /**
   * Keep the managed surface *process* alive across routine idle-TTL and
   * capacity-pressure reap. Only meaningful for connectors whose auth lives in
   * the live browser process; always implies page preservation.
   */
  readonly retainSurfaceProcess: boolean;
}

const BROWSER_SURFACE_POLICY_REGISTRY: Readonly<Record<string, BrowserSurfacePolicy>> = {
  // ChatGPT's authenticated provider API session is held in the live browser
  // process, not durable browser storage. It preserves both pages and retains
  // its surface process; true process loss remains an owner browser-session
  // repair condition rather than a silent auth loss.
  chatgpt: {
    preservePageOnSuccess: true,
    preservePageOnFailure: true,
    retainSurfaceProcess: true,
  },
};

/**
 * Returns the browser-surface policy for a connector runtime name, or null when
 * the connector declares none (default cleanup semantics, no process retention).
 */
export function browserSurfacePolicyFor(connectorName: string | null | undefined): BrowserSurfacePolicy | null {
  if (typeof connectorName !== "string" || !connectorName) {
    return null;
  }
  return BROWSER_SURFACE_POLICY_REGISTRY[connectorName] ?? null;
}

/**
 * The `BrowserConfig` page-preservation fields for a connector, ready to spread
 * into `runConnector({ browser: { ...browserConfigPreservationFor(name), ... } })`.
 * Empty when the connector declares no policy.
 */
export function browserConfigPreservationFor(
  connectorName: string | null | undefined
): Pick<BrowserSurfacePolicy, "preservePageOnSuccess" | "preservePageOnFailure"> | Record<string, never> {
  const policy = browserSurfacePolicyFor(connectorName);
  if (!policy) {
    return {};
  }
  return {
    preservePageOnSuccess: policy.preservePageOnSuccess,
    preservePageOnFailure: policy.preservePageOnFailure,
  };
}

/**
 * Whether the connector's managed surface process must be retained across routine
 * idle/capacity reap. Consumed by the reference implementation's lease caller.
 */
export function connectorRetainsSurfaceProcess(connectorName: string | null | undefined): boolean {
  return browserSurfacePolicyFor(connectorName)?.retainSurfaceProcess === true;
}

export { BROWSER_SURFACE_POLICY_REGISTRY };
