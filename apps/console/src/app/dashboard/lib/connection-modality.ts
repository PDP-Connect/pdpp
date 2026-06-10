/**
 * Console-side projection of the shared "how do I add a connection of type X?"
 * setup planner.
 *
 * This is the cookie-session-UI sibling of the backend owner-agent intent route.
 * Both surfaces consume `pdpp-reference-implementation/connection-setup-plan`;
 * the console MUST NOT call the owner-bearer route because a browser owner
 * session has no owner bearer. The important invariant is parity: the console
 * tells the owner the same honest story the trusted-agent surface tells, without
 * implying "Add connection" / "Sync now" for a flow the reference cannot
 * complete.
 *
 * The proven console creation primitive is device-exporter enrollment via the
 * cookie-authed `POST /_ref/device-exporters/enrollment-codes` route (surfaced at
 * `/dashboard/device-exporters`). That path is one-click for filesystem-class
 * collectors (`claude_code`, `codex`). It can also mint a browser_collector code
 * for Amazon, but that remains a manual owner-run proof path: the owner must run
 * the monorepo browser collector against a real local browser session. Do not
 * advertise it as a one-click browser-bound flow until the committed live proof
 * flips the owner-agent intent route. Static-secret API sources use the
 * owner-session draft path and connector-owned setup metadata, not console-side
 * connector labels or credential fields. The remaining API/network sources
 * (Notion, Oura, Spotify, …) have no owner connect route at all and remain
 * flatly unsupported from the console.
 *
 * The add-connection picker reads shipped manifests for the full catalog, while
 * this module adds console-only labels and copy around the shared setup plan. If
 * the reference gains a new supported setup path, update the shared planner
 * first; console, owner-agent REST, CLI, and SDK-style projections should all
 * consume that same plan.
 */

import {
  BROWSER_BOUND_CONNECTORS as SHARED_BROWSER_BOUND_CONNECTORS,
  BROWSER_BOUND_RUNBOOK_PATH as SHARED_BROWSER_BOUND_RUNBOOK_PATH,
  SUPPORTED_BROWSER_COLLECTOR_CONNECTORS as SHARED_SUPPORTED_BROWSER_COLLECTOR_CONNECTORS,
  SUPPORTED_LOCAL_COLLECTOR_CONNECTORS as SHARED_SUPPORTED_LOCAL_COLLECTOR_CONNECTORS,
  type SupportedBrowserCollectorConnector,
  type SupportedLocalCollectorConnector,
  canonicalConnectorKey as sharedCanonicalConnectorKey,
  enrollmentKeyForCanonicalKey as sharedEnrollmentKeyForCanonicalKey,
  isBrowserBoundConnector as sharedIsBrowserBoundConnector,
  isSupportedBrowserCollectorConnector as sharedIsSupportedBrowserCollectorConnector,
  isSupportedLocalCollectorConnector as sharedIsSupportedLocalCollectorConnector,
} from "pdpp-reference-implementation/connection-setup-plan";

/**
 * Connector keys the console can create today via local-collector device
 * enrollment. Mirrors `COLLECTOR_RUN_CONNECTORS` in the enrollment form (which is
 * pinned by `enrollment-form.consistency.test.ts`); `connection-modality.test.ts`
 * asserts the two stay in sync so neither can drift silently.
 */
export const SUPPORTED_LOCAL_COLLECTOR_CONNECTORS = SHARED_SUPPORTED_LOCAL_COLLECTOR_CONNECTORS;

/**
 * Browser-bound connectors for which the console can honestly mint an
 * enrollment code and generate the manual monorepo runner commands today. This
 * is intentionally narrower than `BROWSER_BOUND_CONNECTORS`: most browser-bound
 * manifests can be classified for row/action honesty, but only Amazon has the
 * local-device runner profile and proof-run runbook needed for a supported
 * console path before the one-click intent flip.
 */
export const SUPPORTED_BROWSER_COLLECTOR_CONNECTORS = SHARED_SUPPORTED_BROWSER_COLLECTOR_CONNECTORS;

/**
 * Connector creation modalities the console understands, matching the backend
 * intent route's taxonomy. `local_collector` is the only one-click path the
 * console can complete today; the manual Amazon proof-run path is modeled by the
 * supported browser-collector set above, not by flipping this modality.
 */
export type ConnectionAddModality = "local_collector" | "browser_bound" | "api_network";

/** Owner-meaningful display name for a supported local-collector connector key. */
export function localCollectorConnectorLabel(connectorId: SupportedLocalCollectorConnector): string {
  switch (connectorId) {
    case "claude_code":
      return "Claude Code";
    case "codex":
      return "Codex";
    default: {
      // Exhaustiveness guard: a new supported key must add a label above.
      const _exhaustive: never = connectorId;
      return _exhaustive;
    }
  }
}

/** Owner-meaningful display name for a supported manual browser collector. */
export function browserCollectorConnectorLabel(connectorId: SupportedBrowserCollectorConnector): string {
  switch (connectorId) {
    case "amazon":
      return "Amazon";
    default: {
      const _exhaustive: never = connectorId;
      return _exhaustive;
    }
  }
}

/** True when this connector key can be created from the console today. */
export function isSupportedLocalCollectorConnector(
  connectorId: string | null | undefined
): connectorId is SupportedLocalCollectorConnector {
  return sharedIsSupportedLocalCollectorConnector(connectorId);
}

/** True when this browser-bound connector has a supported manual console setup path. */
export function isSupportedBrowserCollectorConnector(
  connectorId: string | null | undefined
): connectorId is SupportedBrowserCollectorConnector {
  return sharedIsSupportedBrowserCollectorConnector(connectorId);
}

/**
 * One honestly-unsupported connection modality, with a human exemplar, the
 * exact missing primitive for reviewers, and plain-language dashboard copy.
 * The technical primitive stays worded to agree with the backend
 * `unsupportedReason` so the console and the trusted-agent surface tell the same
 * truth without forcing implementation jargon into the visible dashboard row.
 */
export interface UnsupportedAddModality {
  /** Representative connector names so the owner recognizes the class. */
  examples: readonly string[];
  /** Short owner-facing label for the class of connectors. */
  label: string;
  /** The exact reference primitive that does not yet exist. */
  missingPrimitive: string;
  modality: Exclude<ConnectionAddModality, "local_collector">;
  /** Plain-language dashboard copy explaining why the flow is unavailable. */
  ownerFacingReason: string;
  /**
   * Optional repo doc path with the owner-run procedure that *does* work today,
   * for a modality whose primitive ships but whose one-click flow is gated on
   * committed proof. Rendered inline as a `code` path (matching the console's
   * existing `docs/operator/*` references), never as an "Add connection" button —
   * pointing at the documented manual path is honest discoverability, not an
   * advertised next step the reference has not yet proven.
   */
  runbookPath?: string;
}

/**
 * The connection modalities the console cannot create today. Amazon is no longer
 * listed here: it has a supported manual browser_collector enrollment path. Each
 * remaining entry names the precise missing primitive and a plain owner-facing
 * reason so the copy can be honest without implying the owner can complete the
 * flow here.
 */
/**
 * Connector keys whose manifest declares a `browser` binding — the browser-bound
 * class the backend intent route classifies as `browser_bound`
 * (`classifyConnectorIntentModality`, browser binding wins over a co-present
 * network binding). The console has no manifest `runtime_requirements.bindings`
 * threaded to the records row, so — exactly as this module already does for the
 * supported local-collector set — it enumerates the class by key. The list is
 * pinned against the committed manifests by `connection-modality.test.ts` so it
 * cannot drift from the real connector bindings. This list is for setup and
 * enrollment honesty. Existing connection run controls are governed by the owner
 * run surface and must not categorically suppress browser-bound run-now actions.
 */
export const BROWSER_BOUND_CONNECTORS = SHARED_BROWSER_BOUND_CONNECTORS;

/**
 * Public canonical bare key for a manifest's (possibly registry-URL-shaped)
 * `connector_id`. The connector catalog keys, displays, and routes on this value;
 * exporting the existing private helper keeps one canonicalization rule for the
 * console rather than letting the catalog re-implement the registry-prefix strip.
 */
export function canonicalConnectorKey(connectorId: string): string {
  return sharedCanonicalConnectorKey(connectorId);
}

/**
 * Map a canonical bare connector key to the enrollment-form key the supported
 * sets and the device-exporter deep-link expect. The only divergence today is
 * the local-collector slug: manifests use `claude-code` (hyphen), but the proven
 * enrollment path and `SUPPORTED_LOCAL_COLLECTOR_CONNECTORS` use `claude_code`
 * (underscore), mirroring the form's `COLLECTOR_RUN_CONNECTORS` literal. Every
 * other connector's bare key already equals its enrollment key. Keeping this
 * mapping here — next to the supported sets it serves — means the catalog never
 * mints a `?connector=` value the enrollment form would reject.
 */
export function enrollmentKeyForCanonicalKey(canonicalKey: string): string {
  return sharedEnrollmentKeyForCanonicalKey(canonicalKey);
}

/**
 * True when this connector is browser-bound (manifest `browser` binding).
 * Accepts the canonical bare key the row normally receives and the registry-URL
 * fallback form, so a non-canonical id cannot resurrect a false Sync now.
 */
export function isBrowserBoundConnector(connectorId: string | null | undefined): boolean {
  return sharedIsBrowserBoundConnector(connectorId);
}

/** The browser-bound runbook path, surfaced verbatim by console guidance. */
export const BROWSER_BOUND_RUNBOOK_PATH = SHARED_BROWSER_BOUND_RUNBOOK_PATH;

export const UNSUPPORTED_ADD_MODALITIES: readonly UnsupportedAddModality[] = [
  {
    modality: "browser_bound",
    label: "Browser-bound sources",
    examples: ["Chase", "ChatGPT"],
    missingPrimitive:
      "a connector-specific browser-collector runner path and committed proof before the console can generate setup steps; Amazon is the current manual proof-run path",
    ownerFacingReason:
      "needs a supported browser-collector run profile and real owner-logged-in browser proof before the console can generate setup commands",
    runbookPath: BROWSER_BOUND_RUNBOOK_PATH,
  },
  {
    modality: "api_network",
    label: "API / network sources",
    examples: ["Notion", "Spotify"],
    missingPrimitive:
      "a standalone owner API-connect route — today an API connection only materializes implicitly on first ingest",
    ownerFacingReason:
      "needs an owner-approved API connection flow; today these connections appear only after a connector has ingested data",
  },
] as const;
