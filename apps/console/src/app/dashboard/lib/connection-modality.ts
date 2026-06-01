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
 * The proven console creation primitive is local-collector device enrollment via
 * the cookie-authed `POST /_ref/device-exporters/enrollment-codes` route
 * (surfaced at `/dashboard/device-exporters`). That path is proven one-click for
 * the filesystem-class collectors `claude_code` and `codex`. Browser-bound
 * sources (Amazon, Chase, ChatGPT) share the same enrollment route — it accepts
 * them and enrolls a `browser_collector` instance — but the console deliberately
 * does NOT advertise a one-click flow for them until committed proof shows a real
 * logged-in browser session ingesting end-to-end. Those modalities therefore
 * stay in the unsupported list, with a `runbookPath` pointing at the owner-run
 * procedure that works today. API/network sources (GitHub/Gmail) have no owner
 * connect route at all and remain flatly unsupported from the console.
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
 * Connector creation modalities the console understands, matching the backend
 * intent route's taxonomy. `local_collector` is the only one the console can
 * complete today; the rest are honestly unsupported with a named reason.
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

/** True when this connector key can be created from the console today. */
export function isSupportedLocalCollectorConnector(
  connectorId: string | null | undefined
): connectorId is SupportedLocalCollectorConnector {
  return (
    typeof connectorId === "string" && (SUPPORTED_LOCAL_COLLECTOR_CONNECTORS as readonly string[]).includes(connectorId)
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
 * The connection modalities the console cannot create today. Amazon is the
 * standing browser-bound exemplar (matching the backend's Amazon acceptance
 * fixture). Each entry names the precise missing primitive and a plain
 * owner-facing reason so the copy can be honest without implying the owner can
 * complete the flow here.
 */
export const UNSUPPORTED_ADD_MODALITIES: readonly UnsupportedAddModality[] = [
  {
    modality: "browser_bound",
    label: "Browser-bound sources",
    examples: ["Amazon", "Chase", "ChatGPT"],
    missingPrimitive:
      "the browser-collector enrollment primitive (browser_collector source kind + binding-aware enrollment) already ships; what remains is committed proof that a local collector drives the browser connector end-to-end with a real logged-in session — until that lands, no one-click flow is advertised",
    ownerFacingReason:
      "the enrollment path exists, but the console does not yet offer a one-click flow: a browser-bound connection needs a real, owner-logged-in browser session running locally, which you complete yourself with the local collector",
    runbookPath: "docs/operator/browser-collector-proof-runbook.md",
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
