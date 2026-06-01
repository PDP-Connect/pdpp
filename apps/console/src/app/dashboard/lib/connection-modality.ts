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
 * exact missing primitive, never an implied "Add connection" / "Sync now" that
 * would silently fail.
 *
 * The proven console creation primitive is local-collector device enrollment via
 * the cookie-authed `POST /_ref/device-exporters/enrollment-codes` route
 * (surfaced at `/dashboard/device-exporters`). That path is proven only for the
 * filesystem-class collectors `claude_code` and `codex`. Everything else
 * (browser-bound like Amazon, API/network like GitHub/Gmail) is honestly
 * unsupported from the console today.
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
 * One honestly-unsupported connection modality, with a human exemplar and the
 * exact missing primitive named. Worded to agree with the backend
 * `unsupportedReason` so the console and the trusted-agent surface tell the owner
 * the same truth.
 */
export interface UnsupportedAddModality {
  /** Representative connector names so the owner recognizes the class. */
  examples: readonly string[];
  /** Short owner-facing label for the class of connectors. */
  label: string;
  /** The exact reference primitive that does not yet exist. */
  missingPrimitive: string;
  modality: Exclude<ConnectionAddModality, "local_collector">;
}

/**
 * The connection modalities the console cannot create today. Amazon is the
 * standing browser-bound exemplar (matching the backend's Amazon acceptance
 * fixture). Each entry names the precise missing primitive so the copy can be
 * honest without implying the owner can complete the flow here.
 */
export const UNSUPPORTED_ADD_MODALITIES: readonly UnsupportedAddModality[] = [
  {
    modality: "browser_bound",
    label: "Browser-bound sources",
    examples: ["Amazon", "Chase", "ChatGPT"],
    missingPrimitive:
      "a browser-collector enrollment primitive (a browser_collector source kind, binding-aware enrollment, and committed proof that a local collector drives the browser connector end-to-end)",
  },
  {
    modality: "api_network",
    label: "API / network sources",
    examples: ["GitHub", "Gmail"],
    missingPrimitive:
      "a standalone owner API-connect route — today an API connection only materializes implicitly on first ingest",
  },
] as const;
