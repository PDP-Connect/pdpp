/**
 * Owner-safe presentation of a connector catalog entry's setup disposition.
 *
 * This is the single source of truth for how a setup-plan disposition becomes
 * owner-facing copy: one status label + tone, one short guidance line, one
 * primary next action, and the picker sort rank. Both the Connect "Add data
 * sources" catalog (first-account setup) and the Sources page's per-source
 * add-account projection (adding ANOTHER account to a source that already has
 * data) consume it, so the two surfaces can never drift into two different
 * vocabularies for the same disposition.
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
    case "provider_auth_deployment_blocked":
      return 3;
    case "browser_bound_runbook":
    case "local_collector_unproven":
    case "provider_auth_proof_gated":
      return 4;
    case "api_network_unsupported":
    case "unknown_unsupported":
      return 5;
    default:
      return 6;
  }
}

/** The owner-facing status label + tone for first-account setup. */
export function sourceSetupStatus(entry: ConnectorCatalogEntry): SourceSetupStatus {
  switch (entry.disposition) {
    case "local_collector_enroll":
      return { label: "Add now", tone: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700" };
    case "browser_collector_manual":
      return { label: "Packaged path pending", tone: "border-amber-500/30 bg-amber-500/10 text-amber-700" };
    case "static_secret_connect":
      return { label: "Add account", tone: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700" };
    case "provider_auth_deployment_blocked":
      return { label: "Deployment needed", tone: "border-amber-500/30 bg-amber-500/10 text-amber-700" };
    case "browser_bound_runbook":
      return { label: "Packaged path pending", tone: "border-amber-500/30 bg-amber-500/10 text-amber-700" };
    case "local_collector_unproven":
    case "provider_auth_proof_gated":
      return { label: "Not self-service yet", tone: "border-border bg-muted/30 text-muted-foreground" };
    default:
      return { label: "Not supported yet", tone: "border-border bg-muted/30 text-muted-foreground" };
  }
}

/** One short owner-facing guidance line for first-account setup. */
export function sourceSetupGuidance(entry: ConnectorCatalogEntry): string {
  switch (entry.disposition) {
    case "local_collector_enroll":
      return "Set up the local collector on the machine that has this data. Repeat setup to add another device or account.";
    case "browser_collector_manual":
      return "Browser setup will move into the dashboard. Existing collected data remains usable, but adding another account is not self-service here yet.";
    case "static_secret_connect":
      return "Enter the required provider credential in the protected setup form. Submit again to add another account.";
    case "provider_auth_deployment_blocked":
      return `Configure instance-level provider app material first: ${entry.deploymentReadiness.blockers
        .map((blocker) => blocker.label || blocker.key)
        .join(", ")}.`;
    case "browser_bound_runbook":
      return "Browser setup will move into the dashboard. Existing collected data remains usable, but adding another account is not self-service here yet.";
    case "local_collector_unproven":
      return "This local-source connector needs a packaged collector path before it can be started from the normal setup flow.";
    case "provider_auth_proof_gated":
      return entry.runbookPath
        ? `Provider authorization is not fully wired yet. Tracking runbook: ${entry.runbookPath}.`
        : "Provider authorization is not fully wired yet.";
    case "api_network_unsupported":
      return "This source has no owner-mediated setup path in this build. It is visible so unsupported does not look like omission.";
    default:
      return "This connector is registered without a setup path the reference can classify.";
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
    case "provider_auth_deployment_blocked":
      return { href: "/dashboard/deployment", label: "Open deployment" };
    default:
      return null;
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
      return "self_service";
    case "browser_collector_manual":
    case "browser_bound_runbook":
      return "packaged_path_pending";
    case "provider_auth_deployment_blocked":
      return "deployment_prerequisite";
    default:
      return "not_self_service";
  }
}
