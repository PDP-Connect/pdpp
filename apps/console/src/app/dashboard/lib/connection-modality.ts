/**
 * Console-side single source of truth for "how do I add a connection of type X?".
 *
 * This is the cookie-session-UI sibling of the backend owner-agent intent route
 * `classifyConnectorIntentModality` / `unsupportedReason`
 * (`reference-implementation/server/routes/owner-connection-intent.ts`). The
 * console MUST NOT call that route — it is owner-bearer REST and a browser owner
 * session has no owner bearer. But the console should tell the owner the *same*
 * honest story the trusted-agent surface tells: which connector types the
 * reference can actually create from here, and — for the ones it can't — the
 * exact missing primitive for reviewers plus plain-language dashboard copy,
 * never an implied "Add connection" / "Sync now" that would silently fail.
 *
 * The proven console creation primitive is device-exporter enrollment via the
 * cookie-authed `POST /_ref/device-exporters/enrollment-codes` route (surfaced at
 * `/dashboard/device-exporters`). That path is one-click for filesystem-class
 * collectors (`claude_code`, `codex`). It can also mint a browser_collector code
 * for Amazon, but that remains a manual owner-run proof path: the owner must run
 * the monorepo browser collector against a real local browser session. Do not
 * advertise it as a one-click browser-bound flow until the committed live proof
 * flips the owner-agent intent route. API/network sources (GitHub/Gmail) have no
 * owner connect route at all and remain flatly unsupported from the console.
 *
 * Keep this list and the backend classifier in lockstep. The backend classifies
 * from a connector manifest's `runtime_requirements.bindings`; the console has no
 * manifest at the records list, so it enumerates the proven set by key. If the
 * reference gains a new proven local-collector connector (or a browser-collector
 * enrollment primitive ships and flips a browser-bound connector to supported),
 * update both surfaces together.
 */

/**
 * Connector keys the console can create today via local-collector device
 * enrollment. Mirrors `COLLECTOR_RUN_CONNECTORS` in the enrollment form (which is
 * pinned by `enrollment-form.consistency.test.ts`); `connection-modality.test.ts`
 * asserts the two stay in sync so neither can drift silently.
 */
export const SUPPORTED_LOCAL_COLLECTOR_CONNECTORS = ["claude_code", "codex"] as const;

export type SupportedLocalCollectorConnector = (typeof SUPPORTED_LOCAL_COLLECTOR_CONNECTORS)[number];

/**
 * Browser-bound connectors for which the console can honestly mint an
 * enrollment code and generate the manual monorepo runner commands today. This
 * is intentionally narrower than `BROWSER_BOUND_CONNECTORS`: most browser-bound
 * manifests can be classified for row/action honesty, but only Amazon has the
 * local-device runner profile and proof-run runbook needed for a supported
 * console path before the one-click intent flip.
 */
export const SUPPORTED_BROWSER_COLLECTOR_CONNECTORS = ["amazon"] as const;

export type SupportedBrowserCollectorConnector = (typeof SUPPORTED_BROWSER_COLLECTOR_CONNECTORS)[number];

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
  return (
    typeof connectorId === "string" && (SUPPORTED_LOCAL_COLLECTOR_CONNECTORS as readonly string[]).includes(connectorId)
  );
}

/** True when this browser-bound connector has a supported manual console setup path. */
export function isSupportedBrowserCollectorConnector(
  connectorId: string | null | undefined
): connectorId is SupportedBrowserCollectorConnector {
  return (
    typeof connectorId === "string" &&
    (SUPPORTED_BROWSER_COLLECTOR_CONNECTORS as readonly string[]).includes(bareConnectorKey(connectorId))
  );
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
export const BROWSER_BOUND_CONNECTORS = [
  "amazon",
  "anthropic",
  "chase",
  "chatgpt",
  "doordash",
  "heb",
  "linkedin",
  "loom",
  "meta",
  "reddit",
  "shopify",
  "uber",
  "usaa",
  "wholefoods",
] as const;

export type BrowserBoundConnector = (typeof BROWSER_BOUND_CONNECTORS)[number];

const FIRST_PARTY_REGISTRY_PREFIX = "https://registry.pdpp.org/connectors/";
const TRAILING_SLASH_RE = /\/$/;

/**
 * Reduce a connector identifier to the bare canonical key the records row keys
 * on. The RS connector summary already canonicalizes first-party ids, but the
 * reference falls back to the raw value when canonicalization fails. Stripping
 * the registry-URL prefix here keeps a URL-shaped fallback id from slipping a
 * dead "Sync now" back onto a browser-bound row. Mirrors the registry-prefix
 * handling in `reference-implementation/server/connector-key.js`.
 */
function bareConnectorKey(connectorId: string): string {
  if (connectorId.startsWith(FIRST_PARTY_REGISTRY_PREFIX)) {
    return connectorId.slice(FIRST_PARTY_REGISTRY_PREFIX.length).replace(TRAILING_SLASH_RE, "");
  }
  return connectorId;
}

/**
 * True when this connector is browser-bound (manifest `browser` binding).
 * Accepts the canonical bare key the row normally receives and the registry-URL
 * fallback form, so a non-canonical id cannot resurrect a false Sync now.
 */
export function isBrowserBoundConnector(connectorId: string | null | undefined): boolean {
  if (typeof connectorId !== "string") {
    return false;
  }
  return (BROWSER_BOUND_CONNECTORS as readonly string[]).includes(bareConnectorKey(connectorId));
}

/** The browser-bound runbook path, surfaced verbatim by console guidance. */
export const BROWSER_BOUND_RUNBOOK_PATH = "docs/operator/browser-collector-proof-runbook.md";

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
    examples: ["GitHub", "Gmail"],
    missingPrimitive:
      "a standalone owner API-connect route — today an API connection only materializes implicitly on first ingest",
    ownerFacingReason:
      "needs an owner-approved API connection flow; today these connections appear only after a connector has ingested data",
  },
] as const;
