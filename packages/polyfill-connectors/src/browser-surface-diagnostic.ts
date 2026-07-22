// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Closed, structural browser-surface evidence. This module intentionally
 * accepts no text, URL, selector, DOM, fixture, or account-derived fields.
 * The reference runtime independently revalidates this shape before durable
 * persistence, so a connector cannot widen the evidence contract.
 */

const MAX_STRUCTURAL_COUNT = 1_000_000;

export type BrowserSurfaceKind = "chase_current_activity" | "usaa_transaction_export";
export type BrowserSurfacePosture = "recognized" | "verified_empty" | "parser_zero" | "unexpected";
export type BrowserSurfaceManagedState = "isolated" | "legacy_remote" | "managed" | "unknown";
export type BrowserSurfaceRoute = "expected" | "interstitial" | "unknown";
export type BrowserSurfaceWaitOutcome = "not_needed" | "resolved" | "timed_out" | "unknown";

/** Exact persisted contract; all members are finite, bounded structural facts. */
export interface BrowserSurfaceDiagnostic {
  readonly account_detail_marker_count: number;
  readonly activity_table_marker_count: number;
  readonly dashboard_marker_count: number;
  readonly managed_surface: BrowserSurfaceManagedState;
  readonly navigation_marker_count: number;
  readonly parser_count: number;
  readonly phase: "final_snapshot" | "no_export_affordance";
  readonly posture: BrowserSurfacePosture;
  readonly read_count: number;
  readonly route: BrowserSurfaceRoute;
  readonly surface: BrowserSurfaceKind;
  readonly target_count: number;
  readonly transaction_marker_count: number;
  readonly verified_empty_marker_count: number;
  readonly wait_outcome: BrowserSurfaceWaitOutcome;
}

export interface BrowserSurfaceDiagnosticInput {
  readonly accountDetailMarkerCount?: unknown;
  readonly activityTableMarkerCount?: unknown;
  readonly dashboardMarkerCount?: unknown;
  readonly kind: unknown;
  readonly managedSurface: unknown;
  readonly navigationMarkerCount?: unknown;
  readonly parserCount?: unknown;
  readonly readCount?: unknown;
  readonly route: unknown;
  readonly targetCount?: unknown;
  readonly transactionMarkerCount?: unknown;
  readonly verifiedEmptyMarkerCount?: unknown;
  readonly waitOutcome: unknown;
}

/** Map the runtime's non-sensitive launch kind to durable evidence vocabulary. */
export function browserSurfaceManagedState(value: string | undefined): BrowserSurfaceManagedState {
  switch (value) {
    case "managed_neko":
      return "managed";
    case "legacy_remote_cdp":
      return "legacy_remote";
    case "isolated_local":
      return "isolated";
    default:
      return "unknown";
  }
}

function boundedCount(value: unknown): number {
  if (!(typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) {
    return 0;
  }
  return Math.min(value, MAX_STRUCTURAL_COUNT);
}

function isKind(value: unknown): value is BrowserSurfaceKind {
  return value === "chase_current_activity" || value === "usaa_transaction_export";
}

function isManagedState(value: unknown): value is BrowserSurfaceManagedState {
  return value === "isolated" || value === "legacy_remote" || value === "managed" || value === "unknown";
}

function isRoute(value: unknown): value is BrowserSurfaceRoute {
  return value === "expected" || value === "interstitial" || value === "unknown";
}

function isWaitOutcome(value: unknown): value is BrowserSurfaceWaitOutcome {
  return value === "not_needed" || value === "resolved" || value === "timed_out" || value === "unknown";
}

/**
 * Return null unless every categorical input is part of the closed contract.
 * Counts are normalized to bounded integers; all unrecognized source values
 * are rejected rather than copied into durable output.
 */
export function buildBrowserSurfaceDiagnostic(input: BrowserSurfaceDiagnosticInput): BrowserSurfaceDiagnostic | null {
  if (
    !(
      isKind(input.kind) &&
      isManagedState(input.managedSurface) &&
      isRoute(input.route) &&
      isWaitOutcome(input.waitOutcome)
    )
  ) {
    return null;
  }

  const dashboardMarkerCount = boundedCount(input.dashboardMarkerCount);
  const activityTableMarkerCount = boundedCount(input.activityTableMarkerCount);
  const accountDetailMarkerCount = boundedCount(input.accountDetailMarkerCount);
  const transactionMarkerCount = boundedCount(input.transactionMarkerCount);
  const navigationMarkerCount = boundedCount(input.navigationMarkerCount);
  const targetCount = boundedCount(input.targetCount);
  const parserCount = boundedCount(input.parserCount);
  const verifiedEmptyMarkerCount = boundedCount(input.verifiedEmptyMarkerCount);
  const recognizedMarkerCount =
    dashboardMarkerCount +
    activityTableMarkerCount +
    accountDetailMarkerCount +
    transactionMarkerCount +
    navigationMarkerCount;

  let posture: BrowserSurfacePosture = "unexpected";
  if (input.kind === "chase_current_activity") {
    if (parserCount > 0 || targetCount > 0) {
      posture = "recognized";
    } else if (verifiedEmptyMarkerCount > 0) {
      posture = "verified_empty";
    } else if (dashboardMarkerCount > 0 || activityTableMarkerCount > 0) {
      posture = "parser_zero";
    }
  } else if (targetCount > 0 || recognizedMarkerCount > 0) {
    posture = "recognized";
  }

  return {
    account_detail_marker_count: accountDetailMarkerCount,
    activity_table_marker_count: activityTableMarkerCount,
    dashboard_marker_count: dashboardMarkerCount,
    managed_surface: input.managedSurface,
    navigation_marker_count: navigationMarkerCount,
    parser_count: parserCount,
    phase: input.kind === "chase_current_activity" ? "final_snapshot" : "no_export_affordance",
    posture,
    read_count: boundedCount(input.readCount),
    route: input.route,
    surface: input.kind,
    target_count: targetCount,
    transaction_marker_count: transactionMarkerCount,
    verified_empty_marker_count: verifiedEmptyMarkerCount,
    wait_outcome: input.waitOutcome,
  };
}
