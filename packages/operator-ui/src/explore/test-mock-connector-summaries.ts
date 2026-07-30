// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared `DashboardDataSource.listConnectorSummaries` mock for Explore test
 * suites. `assembleExplorerData` now requests `profile: "identity_inventory"`
 * (Fable ruling terminal-read-architecture-fable-0730.md §8) — every fixture
 * needs to answer both the identity profile and the default full-summary
 * request from the same `RefConnectorSummary[]` fixture list, since only the
 * identity subset is derivable from it.
 */
import type { DashboardDataSource } from "../lib/data-source.ts";
import type { RefConnectorIdentitySummary, RefConnectorSummary } from "../lib/ref-client.ts";

function toIdentitySummary(summary: RefConnectorSummary): RefConnectorIdentitySummary {
  return {
    connection_id: summary.connection_id,
    connector_display_name: summary.connector_display_name ?? summary.connector_id,
    connector_id: summary.connector_id,
    connector_instance_id: summary.connector_instance_id ?? summary.connection_id,
    display_name: summary.display_name,
    membership_state: "complete",
    // biome-ignore lint/suspicious/noUnnecessaryConditions: mirrors the same defensive guard `toConnectionFacet` applies at this boundary.
    streams: [...(summary.streams ?? [])],
  };
}

/** Build a `listConnectorSummaries` mock over a fixed fixture list, honoring `profile`. */
export function mockListConnectorSummaries(
  summaries: readonly RefConnectorSummary[]
): DashboardDataSource["listConnectorSummaries"] {
  return ((options?: { profile?: "identity_inventory" }) =>
    options?.profile === "identity_inventory"
      ? Promise.resolve({
          data: summaries.map(toIdentitySummary),
          has_more: false,
          object: "list" as const,
        })
      : Promise.resolve({
          data: [...summaries],
          has_more: false,
          object: "list" as const,
        })) as DashboardDataSource["listConnectorSummaries"];
}
