// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Owner-safe presentation of a connector catalog entry's setup disposition.
 *
 * This is the single source of truth for how a setup-plan disposition becomes
 * owner-facing copy: one status label + tone, one short guidance line, one
 * primary next action, and the picker sort rank. Both the Sources "Add source"
 * catalog (first-account setup) and the Sources page's per-source add-account
 * projection (adding ANOTHER account to a source that already has data) consume
 * it, so the two surfaces can never drift into two different vocabularies for
 * the same disposition.
 *
 * It introduces NO new classification truth — `disposition` already comes from
 * the shared reference setup planner via `buildConnectorCatalog`. This module
 * only maps that disposition to owner-safe words and a route.
 *
 * Phase 0 guardrails encoded here: source cards never preview shell commands,
 * never reference monorepo paths or unpublished CLI subcommands, never use an
 * inert-tracking primary label, and never use per-account deployment-variable
 * copy. The labels are the owner-facing vocabulary from
 * `owner-journey-slvp-realignment-plan-2026-06-10.md`.
 */

import { type ConnectorCatalogEntry, isExperimentalEntry, isOwnerActionableEntry } from "./connection-catalog.ts";

export interface SourceSetupStatus {
  /** One short owner-facing status label. */
  label: string;
  /** Tailwind classes for the badge tone. */
  tone: string;
}

export interface SourceSetupAction {
  href: string;
  label: string;
}

export function publicTierLabel(tier: ConnectorCatalogEntry["publicTier"]): string {
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

/**
 * Owner context projected from manifest setup/capability metadata. The
 * fallback is intentionally setup-modality based: it keeps provider auth
 * distinct from file import without naming a connector or claiming a new
 * protocol behavior.
 */
export function sourceSetupContext(entry: ConnectorCatalogEntry): string | null {
  if (entry.setupHelpText) {
    return entry.setupHelpText;
  }
  if (entry.setupModality === "provider_authorization") {
    return (
      entry.refreshPolicyRationale ??
      "This source uses provider authorization, not a file import. Provider app settings must be configured on the instance before an owner can authorize an account."
    );
  }
  return entry.setupDescription;
}

function browserBoundWithStoredCredentials(entry: ConnectorCatalogEntry): boolean {
  return entry.modality === "browser_bound" && entry.setupModality === "static_secret";
}

function isUnavailableSetupEntry(entry: ConnectorCatalogEntry): boolean {
  return (
    !isOwnerActionableEntry(entry) &&
    entry.disposition !== "provider_auth_deployment_blocked" &&
    entry.disposition !== "provider_auth_proof_gated" &&
    entry.disposition !== "manual_upload_pending" &&
    !isExperimentalEntry(entry)
  );
}

/**
 * Whether adding a new account for this disposition is self-service today.
 *
 * `self_service` — the owner can add an account now from a shipped surface
 *   (static-secret capture form, local-collector enrollment, browser-session
 *   connect-account flow).
 * `packaged_path_pending` — supported-direction source whose in-dashboard add
 *   path is still being productized (browser-bound or manual-upload pending).
 *   Existing data keeps working; this is honest about add-new, never demotion
 *   copy.
 * `deployment_prerequisite` — add-new is blocked on instance-level provider
 *   app config, not a per-account step.
 * `experimental_opt_in` — a real setup path exists, but no owner has completed
 *   a live proof run yet. Requires an explicit owner opt-in; never shown in
 *   the normal self-service list.
 * `not_self_service` — no shipped owner add path yet (proof-gated / unsupported
 *   / unknown). Visible so it never reads as omission.
 */
export type AddAccountSupport =
  | "self_service"
  | "packaged_path_pending"
  | "deployment_prerequisite"
  | "experimental_opt_in"
  | "not_self_service";

export type SourceSetupAvailability =
  | "available_now"
  | "requires_server_setup"
  | "experimental_opt_in"
  | "not_available_here";

/** Owner-facing picker order: actionable dispositions first, unsupported last. */
export function sourceSetupRank(entry: ConnectorCatalogEntry): number {
  if (isUnavailableSetupEntry(entry)) {
    return 8;
  }
  switch (entry.disposition) {
    case "local_collector_enroll":
      return 0;
    case "static_secret_connect":
      return 1;
    case "browser_collector_manual":
      return 2;
    case "manual_upload_connect":
      return 3;
    case "manual_upload_pending":
      return 4;
    case "provider_auth_connect":
      return 5;
    case "provider_auth_deployment_blocked":
      return 6;
    case "browser_bound_runbook":
    case "local_collector_unproven":
    case "provider_auth_proof_gated":
      return 7;
    case "static_secret_experimental":
      return 9;
    case "api_network_unsupported":
    case "unknown_unsupported":
      return 8;
    default:
      return 9;
  }
}

/** The owner-facing status label + tone for first-account setup. */
export function sourceSetupStatus(entry: ConnectorCatalogEntry): SourceSetupStatus {
  if (entry.publicTier === "development") {
    return { label: publicTierLabel(entry.publicTier), tone: "border-border bg-muted/30 text-muted-foreground" };
  }
  if (entry.publicTier === "preview") {
    return { label: publicTierLabel(entry.publicTier), tone: "border-[color:var(--warning)]/30 bg-status-warning-bg text-status-warning-fg" };
  }
  if (isUnavailableSetupEntry(entry)) {
    return { label: "Not available here", tone: "border-border bg-muted/30 text-muted-foreground" };
  }
  if (browserBoundWithStoredCredentials(entry)) {
    return {
      label: "Supported",
      tone: "border-[color:var(--success)]/30 bg-status-success-bg text-status-success-fg",
    };
  }
  switch (entry.disposition) {
    case "local_collector_enroll":
      return {
        label: "Supported",
        tone: "border-[color:var(--success)]/30 bg-status-success-bg text-status-success-fg",
      };
    case "browser_collector_manual":
      return {
        label: "Supported",
        tone: "border-[color:var(--success)]/30 bg-status-success-bg text-status-success-fg",
      };
    case "static_secret_connect":
      return {
        label: "Supported",
        tone: "border-[color:var(--success)]/30 bg-status-success-bg text-status-success-fg",
      };
    case "manual_upload_connect":
      return {
        label: "Supported",
        tone: "border-[color:var(--success)]/30 bg-status-success-bg text-status-success-fg",
      };
    case "provider_auth_connect":
      return {
        label: "Supported",
        tone: "border-[color:var(--success)]/30 bg-status-success-bg text-status-success-fg",
      };
    case "static_secret_experimental":
      return {
        label: "Preview",
        tone: "border-[color:var(--warning)]/30 bg-status-warning-bg text-status-warning-fg",
      };
    case "manual_upload_pending":
      return {
        label: "Import not available yet",
        tone: "border-[color:var(--warning)]/30 bg-status-warning-bg text-status-warning-fg",
      };
    case "provider_auth_deployment_blocked":
      return {
        label: "Server setup required",
        tone: "border-[color:var(--warning)]/30 bg-status-warning-bg text-status-warning-fg",
      };
    case "browser_bound_runbook":
      return {
        label: "Browser setup not available yet",
        tone: "border-[color:var(--warning)]/30 bg-status-warning-bg text-status-warning-fg",
      };
    case "local_collector_unproven":
    case "provider_auth_proof_gated":
      // Existing data keeps working; there is just no shipped owner add path.
      return { label: "Not available here", tone: "border-border bg-muted/30 text-muted-foreground" };
    case "api_network_unsupported":
      return { label: "Not available here", tone: "border-border bg-muted/30 text-muted-foreground" };
    default:
      // unknown_unsupported and any future unclassified disposition.
      return { label: "Not available here", tone: "border-border bg-muted/30 text-muted-foreground" };
  }
}

/**
 * Guidance for an entry whose disposition this dashboard does not recognise.
 *
 * "Not available here" must never be a dead end: an owner reading it learns
 * nothing about where to act. This says the one honest thing — the reference
 * described this source in a way this dashboard cannot classify — and then
 * hands over every concrete lead the entry actually carries:
 *
 *   - real deployment blockers, named exactly as the shipped
 *     `provider_auth_deployment_blocked` copy names them, so an operator can set
 *     those settings where the instance runs;
 *   - the operator runbook path when the manifest declares one;
 *   - otherwise the specific pair of facts (`connectorKey`, `disposition`) an
 *     operator needs to identify the mismatch, plus where to look.
 *
 * `sourceSetupContext` still renders the modality/description line beside this,
 * and `externalDocs` links still render, so provider documentation is reachable
 * even when nothing here can be named.
 */
function unclassifiedSetupGuidance(entry: ConnectorCatalogEntry): string {
  const blockers = entry.deploymentReadiness.blockers.map((blocker) => blocker.label || blocker.key).filter(Boolean);
  if (blockers.length > 0) {
    return `This source is waiting on server settings: ${blockers.join(", ")}. Set them as environment variables where this instance runs, then restart the server — the source becomes available here automatically once its settings are present.`;
  }
  if (entry.runbookPath) {
    return `This dashboard does not recognise this source's setup path (${entry.connectorKey}), so it cannot offer an add flow. An operator can follow this source's runbook at ${entry.runbookPath} on the machine running this instance.`;
  }
  return `This dashboard does not recognise this source's setup path, so it cannot offer an add flow yet. Nothing is wrong with your data — existing collection keeps working. An operator can check this instance's connector manifest for '${entry.connectorKey}' (reported setup state '${entry.disposition}') and upgrade the instance, or report it so the setup path can be added.`;
}

/**
 * Dispositions this module classifies deliberately. Each has its own `case`
 * below, so a member of this set keeps its specific copy even though the broad
 * {@link isUnavailableSetupEntry} predicate also matches it. Anything OUTSIDE
 * this set that reaches an unavailable branch is by definition unrecognised,
 * and gets the actionable unclassified guidance instead of a flat refusal.
 */
const CLASSIFIED_UNAVAILABLE_DISPOSITIONS = new Set([
  "api_network_unsupported",
  "browser_bound_runbook",
  "local_collector_unproven",
  "provider_auth_proof_gated",
]);

/** One short owner-facing guidance line for first-account setup. */
export function sourceSetupGuidance(entry: ConnectorCatalogEntry): string {
  if (isUnavailableSetupEntry(entry) && !CLASSIFIED_UNAVAILABLE_DISPOSITIONS.has(entry.disposition)) {
    return unclassifiedSetupGuidance(entry);
  }
  if (browserBoundWithStoredCredentials(entry)) {
    return "Sign in in the secure browser. Saving sign-in details is optional and may help with setup or repair, but one-time codes, passkeys, and other human steps still happen in the browser. Automatic reconnection is not guaranteed.";
  }
  switch (entry.disposition) {
    case "local_collector_enroll":
      return "Set up the local collector on the machine that has this data. Repeat setup to add another device or account.";
    case "browser_collector_manual":
      return "Connect a new account in a secure browser. Add an optional source label to distinguish it later; to reconnect an existing source, go back to Sources and open its reconnect flow.";
    case "static_secret_connect":
      return "Enter the required provider credential in the protected setup form. Submit again to add another account.";
    case "manual_upload_connect":
      return "Upload an owner-exported file. Reuse an existing source for another export from the same identity; create a new source only for a different account, profile, device, or source identity.";
    case "provider_auth_connect":
      return "Authorize this provider account in the provider's browser. The connection activates after authorization and account inventory succeed.";
    case "manual_upload_pending":
      return "This source accepts an owner-provided file, but file import is not available in this dashboard yet.";
    case "provider_auth_deployment_blocked":
      return `Finish the server setup first: ${entry.deploymentReadiness.blockers
        .map((blocker) => blocker.label || blocker.key)
        .join(", ")}.`;
    case "static_secret_experimental":
      return "Preview: this setup path has not completed live validation. Test it with non-critical data.";
    case "browser_bound_runbook":
      return "This source can collect through a logged-in browser, but this dashboard cannot start a new account from here yet.";
    case "local_collector_unproven":
      return "This source needs a local collection setup before it can start from this dashboard.";
    case "provider_auth_proof_gated":
      return "Server setup is complete, but this provider's owner authorization flow has not yet completed live validation with a real provider account. Provider authorization is not available here yet.";
    case "api_network_unsupported":
      // A KNOWN reason, not an unclassified one: this provider exposes no
      // owner-reachable collection path, so name that rather than implying a
      // setup step exists somewhere.
      return "This source has no owner-reachable collection path — the provider offers no export or API this instance can collect from. Nothing to set up here; provider documentation below explains what the provider does offer.";
    default:
      // Any future unclassified disposition: never a blank wall, and never a
      // dead end. Name what is unknown and who can act on it.
      return unclassifiedSetupGuidance(entry);
  }
}

/** The primary next action for first-account setup, or null when none exists. */
export function sourceSetupAction(entry: ConnectorCatalogEntry): SourceSetupAction | null {
  if (entry.publicTier === "development" || !(isOwnerActionableEntry(entry) || isExperimentalEntry(entry))) {
    return null;
  }
  // Browser-bound connectors that also declare credential capture still start
  // from the one browser-session path. The optional saved-sign-in-details
  // fields live inside that page rather than becoming a second picker choice.
  if (browserBoundWithStoredCredentials(entry)) {
    return {
      href: `/connect/browser-session/${encodeURIComponent(entry.connectorKey)}`,
      label: "Connect account",
    };
  }
  switch (entry.disposition) {
    case "local_collector_enroll":
      return {
        href: `/device-exporters?connector=${encodeURIComponent(entry.enrollmentKey ?? entry.connectorKey)}`,
        label: "Set up collector",
      };
    case "static_secret_connect":
      return {
        href: `/connect/static-secret/${encodeURIComponent(entry.connectorKey)}`,
        label: "Add account",
      };
    case "static_secret_experimental":
      return {
        href: `/connect/static-secret/${encodeURIComponent(entry.connectorKey)}`,
        label: "Add account",
      };
    case "manual_upload_connect":
      return {
        href: `/connect/manual-upload/${encodeURIComponent(entry.connectorKey)}`,
        label: "Import file",
      };
    case "browser_collector_manual":
      return {
        href: `/connect/browser-session/${encodeURIComponent(entry.enrollmentKey ?? entry.connectorKey)}`,
        label: "Connect account",
      };
    case "provider_auth_connect":
      return {
        href: `/connect/provider-auth/${encodeURIComponent(entry.connectorKey)}`,
        label: "Authorize account",
      };
    default:
      return null;
  }
}

export function sourceSetupSecondaryAction(_entry: ConnectorCatalogEntry): SourceSetupAction | null {
  // Stored credentials are an optional part of the browser-session page. Keep
  // the Add Source catalog to one primary account-connect action so the legacy
  // static-secret route cannot look like an equal setup modality.
  return null;
}

export function sourceSetupAvailability(entry: ConnectorCatalogEntry): SourceSetupAvailability {
  if (entry.publicTier === "development") {
    return "not_available_here";
  }
  if (isUnavailableSetupEntry(entry)) {
    return "not_available_here";
  }
  switch (entry.disposition) {
    case "local_collector_enroll":
    case "static_secret_connect":
    case "manual_upload_connect":
    case "browser_collector_manual":
    case "provider_auth_connect":
      return "available_now";
    case "provider_auth_deployment_blocked":
      return "requires_server_setup";
    case "static_secret_experimental":
      return "experimental_opt_in";
    default:
      return "not_available_here";
  }
}

/** Only runnable actions belong in /sources/add; server-setting and runbook cards do not. */
export function isRunnableAddOffer(entry: ConnectorCatalogEntry): boolean {
  const availability = sourceSetupAvailability(entry);
  if (entry.publicTier === "supported") {
    return availability === "available_now";
  }
  // A preview-tier entry is offered when its setup path is genuinely
  // self-service, which is exactly what `available_now` already means: "the
  // owner can add an account now from a shipped surface". The previous
  // condition paired preview with ONLY `experimental_opt_in`, which held until
  // the first preview-tier local-collector connector shipped -- enrollment
  // issues a code the owner redeems on their own machine, so it resolves to
  // `available_now` and matched neither arm. The connector was registered,
  // owner-actionable, and invisible on /sources/add.
  //
  // Keyed on availability rather than on the one disposition that broke, so a
  // future preview-tier disposition resolving to `available_now` does not
  // reintroduce the same invisibility. The remaining availabilities
  // (`requires_server_setup`, `not_available_here`) still correctly withhold
  // the offer.
  return (
    entry.publicTier === "preview" && (availability === "experimental_opt_in" || availability === "available_now")
  );
}

/**
 * Classify whether adding a NEW account is self-service for this disposition.
 * This is the fact the Sources page must keep distinct from "this source has
 * existing working data": a source can collect data today yet not yet support
 * self-service add-another-account (the browser-bound dispositions).
 */
export function addAccountSupport(entry: ConnectorCatalogEntry): AddAccountSupport {
  if (isUnavailableSetupEntry(entry)) {
    return "not_self_service";
  }
  switch (entry.disposition) {
    case "local_collector_enroll":
    case "static_secret_connect":
    case "manual_upload_connect":
    case "browser_collector_manual":
    case "provider_auth_connect":
      return "self_service";
    case "browser_bound_runbook":
    case "manual_upload_pending":
      return "packaged_path_pending";
    case "provider_auth_deployment_blocked":
      return "deployment_prerequisite";
    case "static_secret_experimental":
      return "experimental_opt_in";
    default:
      return "not_self_service";
  }
}
