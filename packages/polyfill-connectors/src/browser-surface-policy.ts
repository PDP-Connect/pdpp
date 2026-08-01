// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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
  /**
   * Declares WHEN a connector needs a managed surface, not just how its page
   * is treated once it has one:
   *
   *   - `"run"` (default when absent): today's behavior. The controller
   *     reserves a managed surface before spawn and holds it for the whole
   *     run. Right for a connector whose provider auth or interaction lives
   *     in the browser for the run's duration.
   *   - `"phase"`: the connector only needs a managed surface for bounded
   *     phases inside an otherwise browser-free run. The controller must NOT
   *     reserve a run-level surface for it; the connector requests one
   *     mid-run (`requestBrowserSurfacePhase`) only while it actually needs
   *     one, and releases it immediately after.
   *
   * This is what lets a mostly-API connector join the managed-surface
   * allowlist without starving the shared surface pool for its entire run.
   */
  readonly surfaceScope?: "phase" | "run";
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
  // Slack's browser is a short-lived API transport, NOT a credential
  // boundary: its provider session lives in durable API tokens, not a live
  // browser page. Only ~4 quick gap streams near the end of an otherwise
  // ~1h API-driven run actually need a browser, to route around a source
  // that blocks plain HTTP for that narrow slice. Declaring `surfaceScope:
  // "phase"` means the controller does not reserve a managed surface for
  // the whole hour — it would otherwise starve the shared surface pool for
  // nearly the entire run to cover a few minutes of real use. Slack
  // acquires a phase-scoped surface immediately before those streams and
  // releases it right after, so no page/process preservation is needed
  // either.
  slack: {
    preservePageOnSuccess: false,
    preservePageOnFailure: false,
    retainSurfaceProcess: false,
    surfaceScope: "phase",
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

/**
 * Whether the connector needs a managed surface only for bounded mid-run
 * phases rather than for its whole run. Consumed by the reference
 * implementation to skip the pre-spawn run-level lease for this connector
 * (it requests a phase-scoped surface itself, mid-run) and by
 * `scheduler-readiness.ts`, which treats a phase-scoped connector as ready on
 * the same presence-only check as a run-scoped one.
 */
export function connectorUsesPhaseScopedSurface(connectorName: string | null | undefined): boolean {
  return browserSurfacePolicyFor(connectorName)?.surfaceScope === "phase";
}

export { BROWSER_SURFACE_POLICY_REGISTRY };
