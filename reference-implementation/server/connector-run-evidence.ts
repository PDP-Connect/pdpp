/**
 * Connector run evidence and refresh-policy projection.
 *
 * Scope: owns connector run-summary lookups and manifest refresh-policy reads
 * used by schema/freshness projection and scheduler admission. It does not own
 * scheduler state, route mounting, or record visibility.
 *
 * Invariant: no import from index.js; this leaf imports spine reads directly.
 */

import { listSpineCorrelations } from "../lib/spine.ts";

export function getConnectorRunEvidenceSource(
  source: { kind?: unknown; id?: unknown } | null | undefined
): string | null {
  return source?.kind === "connector" && typeof source.id === "string" && source.id ? source.id : null;
}

export async function getLatestConnectorRunSummary(
  connectorId: string | null | undefined,
  status: string | null = null
): Promise<{ last_at: unknown; status: unknown } | null> {
  if (!connectorId) {
    return null;
  }
  const filters = status
    ? { sourceKind: "connector", sourceId: connectorId, status, limit: 1 }
    : { sourceKind: "connector", sourceId: connectorId, limit: 1 };
  const { summaries } = await listSpineCorrelations("run", filters);
  const summary = summaries[0] || null;
  if (!summary) {
    return null;
  }
  return {
    last_at: summary.last_at,
    status: summary.status,
  };
}

export function getManifestRefreshPolicy(manifest: { capabilities?: unknown } | null | undefined): unknown {
  const capabilities = manifest?.capabilities;
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) {
    return null;
  }
  return (capabilities as Record<string, unknown>).refresh_policy ?? null;
}

export function getMaximumStalenessSeconds(refreshPolicy: unknown): number | null {
  if (!refreshPolicy || typeof refreshPolicy !== "object" || Array.isArray(refreshPolicy)) {
    return null;
  }
  const value = (refreshPolicy as Record<string, unknown>).maximum_staleness_seconds;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}
