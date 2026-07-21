// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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
 * `/device-exporters`). Static-secret API sources use the owner-session
 * draft path and connector-owned setup metadata, not console-side connector
 * labels or credential fields. The console renders connector display names from
 * manifests and setup plans; this module must not carry provider-specific UI
 * labels, example lists, or credential-field copy.
 *
 * The add-connection picker reads shipped manifests for the full catalog. If the
 * reference gains a new supported setup path, update the shared planner first;
 * console, owner-agent REST, CLI, and SDK-style projections should all consume
 * that same plan.
 */

import {
  BROWSER_BOUND_CONNECTORS as SHARED_BROWSER_BOUND_CONNECTORS,
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
 * enrollment code and generate manual runner commands today. This is
 * intentionally narrower than `BROWSER_BOUND_CONNECTORS`: most browser-bound
 * manifests can be classified for row/action honesty, but only a proven subset
 * has the runner profile and proof-run runbook needed for a supported console
 * path before the one-click intent flip.
 */
export const SUPPORTED_BROWSER_COLLECTOR_CONNECTORS = SHARED_SUPPORTED_BROWSER_COLLECTOR_CONNECTORS;

/**
 * Connector creation modalities the console understands, matching the backend
 * intent route's taxonomy. `local_collector` is the only one-click path the
 * console can complete today; manual browser proof paths are modeled by the
 * supported browser-collector set above, not by flipping this modality.
 */
export type ConnectionAddModality = "local_collector" | "browser_bound" | "api_network";

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

/**
 * Connection source-binding kinds whose PRIMARY auth is an owner-authenticated
 * browser session, not a stored credential. A connection bound this way repairs
 * by browser/session repair (re-establish the session) — NOT static-secret
 * credential capture — even when the connector also supports a username_password
 * static secret at the connector level (e.g. a ChatGPT connection that logs in
 * via SSO through the browser). Mirrors the server-side
 * `BROWSER_SESSION_BINDING_KINDS` in `ref-control.ts`; the two must stay in sync.
 */
const BROWSER_SESSION_BINDING_KINDS = new Set(["browser_collector", "browser_enrollment_shell"]);

/**
 * True when THIS connection is bound as a browser session (from its
 * connection-scoped `source_binding_kind`), so repair must route to
 * browser/session repair rather than static-secret credential capture. This is
 * the connection-binding-first discriminator; it takes precedence over the
 * connector-level `isBrowserBoundConnector`/static-secret-capability facts.
 */
export function isBrowserSessionBoundConnection(sourceBindingKind: string | null | undefined): boolean {
  return typeof sourceBindingKind === "string" && BROWSER_SESSION_BINDING_KINDS.has(sourceBindingKind);
}
