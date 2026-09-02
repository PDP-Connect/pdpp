// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Exact-revision acceptance receipt for the retained production instance.
//
// This module composes the stream-health authority (`live.ts`) — which
// already proves exhaustive owner summaries, resolved `/sources` DOM, strict
// per-stream facts, pagination completeness, and the exact revision receipt —
// with two facts that authority intentionally does not compute itself:
//
//   - the global banner verdict (`GET /_ref/fleet-health`), the one surface
//     the plan's acceptance gate is actually about ("the exact bad fleet
//     banner is absent"). `FleetHealthVerdict` already consumes this
//     authority's `StreamHealthAuthorityResult["status"]` as its
//     `coverage_audit` dimension (`reference-implementation/server/fleet-health.ts`)
//     — this receipt does not re-derive fleet semantics, it reads the one
//     structured verdict the health-model lane owns and reports it verbatim;
//   - per-connection projection settlement (`ProjectionReliable`), so a rerun
//     can show a stale/dirty projection converge to `true` without manual SQL
//     and without a report author guessing from the rendered pill alone.
//
// The result is ONE receipt: run it once against a live origin and get every
// fact the acceptance gates in BANNER-ZERO-PLAN.md ask for in one place,
// with the exact revision that produced it. This module does not redefine
// any row's health classification — it is read-only composition over the
// authority's own findings and the health-model lane's own fleet verdict.

import { type FetchImpl, resolveOwnerAuthForLive } from "../lib/owner-session.ts";
import {
  type LiveStreamHealthAuthorityResult,
  type OwnerSourcesBrowserFactory,
  resolveOwnerAuthForStreamHealth,
  runLiveStreamHealthAuthority,
} from "./live.ts";

const REGEX_TRAILING_SLASHES = /\/+$/;

export type FleetHealthState = "healthy" | "healthy_with_advisories" | "indeterminate" | "unhealthy";

export interface FleetHealthReceiptFacet {
  readonly error: string | null;
  readonly fetched: boolean;
  readonly fullyHealthy: boolean | null;
  readonly ok: boolean;
  readonly state: FleetHealthState | null;
}

export interface ProjectionSettlementRow {
  readonly connectionId: string | null;
  readonly connectorId: string | null;
  readonly reason: string | null;
  readonly settled: boolean;
}

export interface ProjectionSettlementFacet {
  /** False when this facet could not be evaluated at all (e.g. the authority fetch failed). Never inferred from an empty row set. */
  readonly evaluated: boolean;
  readonly rows: readonly ProjectionSettlementRow[];
  readonly settled: boolean;
  readonly unsettledCount: number;
}

export interface StreamHealthReceipt {
  readonly authority: LiveStreamHealthAuthorityResult;
  readonly fleetHealth: FleetHealthReceiptFacet;
  readonly generatedAt: string;
  readonly ok: boolean;
  readonly origin: string;
  readonly projectionSettlement: ProjectionSettlementFacet;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

const FLEET_HEALTH_STATES: ReadonlySet<string> = new Set([
  "healthy",
  "healthy_with_advisories",
  "indeterminate",
  "unhealthy",
]);

async function fetchFleetHealth({
  base,
  fetchImpl,
  headers,
}: {
  base: string;
  fetchImpl: FetchImpl;
  headers: Record<string, string>;
}): Promise<FleetHealthReceiptFacet> {
  try {
    const res = await fetchImpl(`${base}/_ref/fleet-health`, { headers: { accept: "application/json", ...headers } });
    if (res.status < 200 || res.status >= 300) {
      return {
        error: `GET /_ref/fleet-health returned status ${res.status}`,
        fetched: false,
        fullyHealthy: null,
        ok: false,
        state: null,
      };
    }
    const body = asObject(JSON.parse(await res.text()));
    const state = asNonEmptyString(body?.state);
    if (!(state && FLEET_HEALTH_STATES.has(state))) {
      return {
        error: "fleet-health response has an unrecognized state",
        fetched: true,
        fullyHealthy: null,
        ok: false,
        state: null,
      };
    }
    const fullyHealthy = body?.fully_healthy === true;
    return {
      error: null,
      fetched: true,
      fullyHealthy,
      // "ok" here means the banner is quiet: no active source is in a proven
      // needs_you/blocked state. `healthy_with_advisories` and `indeterminate`
      // both still render a non-null hero (BANNER-ZERO-PLAN.md's global
      // banner is specifically the `state !== "healthy"` fallback case in
      // `buildFleetHealthHero`), so only exact `healthy` counts as quiet here.
      ok: state === "healthy",
      state: state as FleetHealthState,
    };
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : String(err),
      fetched: false,
      fullyHealthy: null,
      ok: false,
      state: null,
    };
  }
}

function projectionSettlementFromConnections(connections: readonly unknown[]): ProjectionSettlementFacet {
  const rows: ProjectionSettlementRow[] = [];
  for (const value of connections) {
    const connection = asObject(value);
    if (!connection) {
      continue;
    }
    // Only active connections carry a meaningful settlement question — a
    // revoked/paused/archived row's projection is intentionally frozen, and
    // this facet's job is convergence-after-rerun, not the row's health class.
    if (connection.status !== "active") {
      continue;
    }
    const health = asObject(connection.connection_health);
    const conditions = Array.isArray(health?.conditions) ? health.conditions : [];
    const reliable = conditions.map((entry) => asObject(entry)).find((entry) => entry?.type === "ProjectionReliable");
    const connectionId =
      asNonEmptyString(connection.connection_id) ?? asNonEmptyString(connection.connector_instance_id);
    const connectorId =
      asNonEmptyString(connection.connector_id) ??
      asNonEmptyString(connection.connector_key) ??
      asNonEmptyString(connection.provider_id);
    if (!reliable) {
      // No ProjectionReliable condition is itself unsettled evidence: this
      // receipt cannot claim convergence for a row it cannot observe.
      rows.push({ connectionId, connectorId, reason: "no_projection_reliable_condition", settled: false });
      continue;
    }
    rows.push({
      connectionId,
      connectorId,
      reason: reliable.status === "true" ? null : (asNonEmptyString(reliable.reason) ?? "unknown"),
      settled: reliable.status === "true",
    });
  }
  const unsettledCount = rows.filter((row) => !row.settled).length;
  return { evaluated: true, rows, settled: unsettledCount === 0, unsettledCount };
}

/**
 * Run the full acceptance receipt against a live owner session: the strict
 * stream-health authority, the global fleet-banner verdict, and per-connection
 * projection settlement — one command, one revision, one result.
 */
export async function runStreamHealthReceipt({
  browserFactory,
  env = process.env,
  expectedRevision = env.PDPP_EXPECTED_REFERENCE_REVISION?.trim() || null,
  expectedSha = env.PDPP_EXPECTED_SHA?.trim() || null,
  fetchImpl = fetch as unknown as FetchImpl,
  origin,
}: {
  browserFactory?: OwnerSourcesBrowserFactory;
  env?: NodeJS.ProcessEnv;
  expectedRevision?: string | null;
  expectedSha?: string | null;
  fetchImpl?: FetchImpl;
  origin: string;
}): Promise<StreamHealthReceipt> {
  const base = origin.replace(REGEX_TRAILING_SLASHES, "");
  const generatedAt = new Date().toISOString();

  const authority = await runLiveStreamHealthAuthority({
    ...(browserFactory ? { browserFactory } : {}),
    env,
    expectedRevision,
    expectedSha,
    fetchImpl,
    origin: base,
  });

  const auth = await resolveOwnerAuthForStreamHealth({ base, env, fetchImpl });
  let fleetHealth: FleetHealthReceiptFacet = {
    error: "owner authentication was not resolved for the fleet-health facet",
    fetched: false,
    fullyHealthy: null,
    ok: false,
    state: null,
  };
  if (auth.supported) {
    fleetHealth = await fetchFleetHealth({ base, fetchImpl, headers: auth.header });
  } else if (auth.mode === "password-session") {
    // resolveOwnerAuthForLive already attempted the login; surface its error
    // rather than re-deriving a generic "not resolved" message.
    const retry = await resolveOwnerAuthForLive({ base, env, fetchImpl });
    fleetHealth = {
      error: retry.error ?? "owner authentication was not resolved for the fleet-health facet",
      fetched: false,
      fullyHealthy: null,
      ok: false,
      state: null,
    };
  }

  // Projection settlement reads the SAME connection inventory the authority
  // already fetched. `runLiveStreamHealthAuthority` intentionally does not
  // expose raw connections (only findings), so this re-runs the same bounded
  // page-follow rather than threading connections through its return shape —
  // only when the authority itself successfully fetched, so a failed
  // authority fetch never reports false settlement (empty rows, `settled:
  // true` would be a false all-clear).
  const settlement = authority.fetched
    ? projectionSettlementFromConnections(await fetchConnectionsForSettlement({ auth, base, fetchImpl }))
    : { evaluated: false, rows: [], settled: false, unsettledCount: 0 };

  const ok = authority.ok && fleetHealth.ok && settlement.evaluated && settlement.settled;
  return { authority, fleetHealth, generatedAt, ok, origin: base, projectionSettlement: settlement };
}

export interface RestartRegressionCheck {
  readonly detail: string;
  readonly regressed: boolean;
  readonly rule: string;
}

/**
 * A controlled restart must never make the acceptance outcome WORSE. The
 * revision, timestamps, and individual finding reasons may legitimately
 * differ (a restart can also carry a deploy), but the axes the plan's
 * acceptance gates name — green count, banner quiet, projection settlement,
 * overall pass — must not regress from their pre-restart value.
 */
export function checkRestartForRegression(
  before: StreamHealthReceipt,
  after: StreamHealthReceipt
): readonly RestartRegressionCheck[] {
  return [
    {
      rule: "authority.score.numerator",
      regressed: after.authority.score.numerator < before.authority.score.numerator,
      detail: `before=${before.authority.score.ratio} after=${after.authority.score.ratio}`,
    },
    {
      rule: "fleet_banner_quiet",
      regressed: before.fleetHealth.ok && !after.fleetHealth.ok,
      detail: `before=${before.fleetHealth.state ?? "<unresolved>"} after=${after.fleetHealth.state ?? "<unresolved>"}`,
    },
    {
      rule: "projection_settlement",
      regressed: before.projectionSettlement.settled && !after.projectionSettlement.settled,
      detail: `before unsettled=${before.projectionSettlement.unsettledCount} after unsettled=${after.projectionSettlement.unsettledCount}`,
    },
    {
      rule: "overall_pass",
      regressed: before.ok && !after.ok,
      detail: `before=${before.ok} after=${after.ok}`,
    },
  ];
}

async function fetchConnectionsForSettlement({
  auth,
  base,
  fetchImpl,
}: {
  auth: { header: Record<string, string>; supported: boolean };
  base: string;
  fetchImpl: FetchImpl;
}): Promise<readonly unknown[]> {
  if (!auth.supported) {
    return [];
  }
  const { fetchAllConnectorSummaries } = await import("../lib/ref-connectors-page-follow.ts");
  const paged = await fetchAllConnectorSummaries({
    base,
    fetchImpl,
    headers: { accept: "application/json", ...auth.header },
  });
  return paged.ok ? paged.data : [];
}
