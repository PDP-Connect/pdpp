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

import type { ConnectorCatalogEntry } from "./connection-catalog.ts";
import { BROWSER_BOUND_RUNBOOK_PATH } from "./connection-modality.ts";

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

/**
 * Whether adding a new account for this disposition is self-service today.
 *
 * `self_service` — the owner can add an account now from a shipped surface
 *   (static-secret capture form, local-collector enrollment).
 * `packaged_path_pending` — supported-direction source whose in-dashboard add
 *   path is still being productized (browser-bound). Existing data keeps
 *   working; this is honest about add-new, never demotion copy.
 * `deployment_prerequisite` — add-new is blocked on instance-level provider
 *   app config, not a per-account step.
 * `not_self_service` — no shipped owner add path yet (proof-gated / unsupported
 *   / unknown). Visible so it never reads as omission.
 */
export type AddAccountSupport =
  | "self_service"
  | "packaged_path_pending"
  | "deployment_prerequisite"
  | "not_self_service";

/** Owner-facing picker order: actionable dispositions first, unsupported last. */
export function sourceSetupRank(entry: ConnectorCatalogEntry): number {
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
    case "provider_auth_deployment_blocked":
      return 5;
    case "browser_bound_runbook":
    case "local_collector_unproven":
    case "provider_auth_proof_gated":
      return 6;
    case "api_network_unsupported":
    case "unknown_unsupported":
      return 7;
    default:
      return 8;
  }
}

/** The owner-facing status label + tone for first-account setup. */
export function sourceSetupStatus(entry: ConnectorCatalogEntry): SourceSetupStatus {
  switch (entry.disposition) {
    case "local_collector_enroll":
      return { label: "Add now", tone: "border-[color:var(--success)]/30 bg-status-success-bg text-status-success-fg" };
    case "browser_collector_manual":
      return {
        label: "Needs local setup",
        tone: "border-[color:var(--warning)]/30 bg-status-warning-bg text-status-warning-fg",
      };
    case "static_secret_connect":
      return {
        label: "Add account",
        tone: "border-[color:var(--success)]/30 bg-status-success-bg text-status-success-fg",
      };
    case "manual_upload_connect":
      return {
        label: "Import file",
        tone: "border-[color:var(--success)]/30 bg-status-success-bg text-status-success-fg",
      };
    case "manual_upload_pending":
      return {
        label: "Import flow pending",
        tone: "border-[color:var(--warning)]/30 bg-status-warning-bg text-status-warning-fg",
      };
    case "provider_auth_deployment_blocked":
      return {
        label: "Deployment needed",
        tone: "border-[color:var(--warning)]/30 bg-status-warning-bg text-status-warning-fg",
      };
    case "browser_bound_runbook":
      return {
        label: "Needs local setup",
        tone: "border-[color:var(--warning)]/30 bg-status-warning-bg text-status-warning-fg",
      };
    case "local_collector_unproven":
    case "provider_auth_proof_gated":
      // Existing data keeps working; there is just no shipped owner add path.
      // Agreed label — kills the last "not self-service" string on the surface.
      return { label: "Existing data only", tone: "border-border bg-muted/30 text-muted-foreground" };
    case "api_network_unsupported":
      // In-app setup not yet wired but connector exists; honest label with path
      // available in the guidance line below.
      return { label: "Setup path pending", tone: "border-border bg-muted/30 text-muted-foreground" };
    default:
      // unknown_unsupported and any future unclassified disposition.
      // "Setup path pending" is honest and removes the dead-end "Not supported yet".
      return { label: "Setup path pending", tone: "border-border bg-muted/30 text-muted-foreground" };
  }
}

/** One short owner-facing guidance line for first-account setup. */
export function sourceSetupGuidance(entry: ConnectorCatalogEntry): string {
  switch (entry.disposition) {
    case "local_collector_enroll":
      return "Set up the local collector on the machine that has this data. Repeat setup to add another device or account.";
    case "browser_collector_manual":
      return "This source collects data by driving your logged-in browser session locally. Existing data is usable. To add an account or re-authenticate now, follow the browser-collector runbook. In-dashboard setup is tracked and coming.";
    case "static_secret_connect":
      return "Enter the required provider credential in the protected setup form. Submit again to add another account.";
    case "manual_upload_connect":
      return "Upload an owner-exported file. Reuse an existing source for another export from the same identity; create a new source only for a different account, profile, device, or source identity.";
    case "manual_upload_pending":
      return "This source imports an owner-provided file. The connector declares the import shape, but the dashboard file-capture step is not packaged yet.";
    case "provider_auth_deployment_blocked":
      return `Configure instance-level provider app material first: ${entry.deploymentReadiness.blockers
        .map((blocker) => blocker.label || blocker.key)
        .join(", ")}.`;
    case "browser_bound_runbook":
      return "This source collects data by driving your logged-in browser session locally. Existing data is usable. To add an account or re-authenticate now, follow the browser-collector runbook. In-dashboard setup is tracked and coming.";
    case "local_collector_unproven":
      return "This local-source connector needs a packaged collector path before it can be started from the normal setup flow.";
    case "provider_auth_proof_gated":
      return entry.runbookPath
        ? `Provider authorization is not fully wired yet. Tracking runbook: ${entry.runbookPath}.`
        : "Provider authorization is not fully wired yet.";
    case "api_network_unsupported":
      return entry.runbookPath
        ? `In-app setup is not wired yet, but a manual runbook exists at ${entry.runbookPath}. It's listed here so you know it's planned, not missing.`
        : "In-app setup for this source is not wired yet. It's listed so you know it's planned, not missing. Check the operator docs for any available manual path.";
    default:
      // unknown_unsupported and any future unclassified disposition: never a
      // blank wall. Give the owner at least a direction.
      return entry.runbookPath
        ? `In-app setup is not available yet. A runbook may help: ${entry.runbookPath}.`
        : "In-app setup for this source isn't available yet. Check the operator docs or open a support request to learn about the expected timeline.";
  }
}

/** The primary next action for first-account setup, or null when none exists. */
export function sourceSetupAction(entry: ConnectorCatalogEntry): SourceSetupAction | null {
  switch (entry.disposition) {
    case "local_collector_enroll":
      return {
        href: `/dashboard/device-exporters?connector=${encodeURIComponent(entry.enrollmentKey ?? entry.connectorKey)}`,
        label: "Set up collector",
      };
    case "static_secret_connect":
      return {
        href: `/dashboard/connect/static-secret/${encodeURIComponent(entry.connectorKey)}`,
        label: "Add account",
      };
    case "manual_upload_connect":
      return {
        href: `/dashboard/connect/manual-upload/${encodeURIComponent(entry.connectorKey)}`,
        label: "Import file",
      };
    case "provider_auth_deployment_blocked":
      return { href: "/dashboard/deployment", label: "Open deployment" };
    case "browser_bound_runbook":
    case "browser_collector_manual":
      // The in-dashboard neko browser flow is tracked but not yet deployed.
      // Return a real forward action pointing at the browser-session connect
      // page so the owner is never left at a blank wall. Once neko is
      // confirmed deployed this route renders the embedded login surface;
      // before that it shows the honest runbook path.
      return {
        href: `/dashboard/connect/browser-session/${encodeURIComponent(entry.connectorKey)}`,
        label: "Connect by logging in",
      };
    case "local_collector_unproven":
    case "provider_auth_proof_gated":
      return entry.runbookPath
        ? { href: entry.runbookPath, label: "View runbook" }
        : null;
    default:
      return entry.runbookPath ? { href: entry.runbookPath, label: "View runbook" } : null;
  }
}

/**
 * Classify whether adding a NEW account is self-service for this disposition.
 * This is the fact the Sources page must keep distinct from "this source has
 * existing working data": a source can collect data today yet not yet support
 * self-service add-another-account (the browser-bound dispositions).
 */
export function addAccountSupport(entry: ConnectorCatalogEntry): AddAccountSupport {
  switch (entry.disposition) {
    case "local_collector_enroll":
    case "static_secret_connect":
    case "manual_upload_connect":
      return "self_service";
    case "browser_collector_manual":
    case "browser_bound_runbook":
    case "manual_upload_pending":
      return "packaged_path_pending";
    case "provider_auth_deployment_blocked":
      return "deployment_prerequisite";
    default:
      return "not_self_service";
  }
}
