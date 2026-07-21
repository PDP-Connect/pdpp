/**
 * Canonical `ref.connectors.detail` operation.
 *
 * Owns the envelope semantics for the reference-only operator-console
 * per-connector view that powers `GET /_ref/connectors/:connectorId`.
 * Host adapters supply detail data via the dependency contract; the
 * operation owns the `{object: 'ref_connector_detail', ...}` discriminator
 * and its `not_found` / `connector_invalid` failure shape mapping.
 *
 * This is reference/operator surface, not PDPP protocol. Clients must not
 * depend on the response shape.
 *
 * Boundary rules (see openspec/changes/mount-ref-connectors-approvals-operations):
 * - This module SHALL NOT import Fastify, Express, Next, SQLite, Postgres,
 *   a raw SQL handle, sandbox modules, `reference-implementation/server/*`
 *   route or auth modules, or `process` / `process.env`.
 * - Detail capabilities flow in through dependencies. The host wires the
 *   concrete reads (e.g. `getConnectorDetail` in `server/ref-control.ts`).
 */

import type {
  RefConnectorsListFreshness,
  RefConnectorsListRunSummary,
} from "../ref-connectors-list/index.ts";

export type RefConnectorDetailFreshness = RefConnectorsListFreshness;
export type RefConnectorDetailRunSummary = RefConnectorsListRunSummary;

export interface RefConnectorDetailManifestExcerpt {
  readonly connector_id: string | undefined;
  readonly display_name: string;
  readonly profile_ids: string[];
  readonly protocol_version: string | null;
  readonly version: string | undefined;
}

export interface RefConnectorDetailStreamSummary {
  readonly object: "stream";
  readonly name: string;
  readonly semantics: string | null;
  /**
   * `null` when the count is genuinely unknown/unavailable for this
   * connection — never coerced to a fabricated `0`
   * (reconcile-active-summary-evidence design.md "Health boundary" /
   * spec.md's stream count-state invariants). Declared stream NAMES are a
   * connector-level catalog fact and still appear even when
   * `connection_resolution` is not `"resolved"`; `record_count` is the
   * genuinely per-connection fact that reads `null` in that case.
   */
  readonly record_count: number | null;
  /**
   * Orthogonal state for `record_count` (reconcile-active-summary-evidence
   * design.md "Health boundary"): a `record_count` carried over from a
   * non-current record_snapshot reads `"stale"`, never
   * `"known"`/`"known_zero"` — a consumer must not render a failed
   * snapshot's carried-over number as an authoritative exact count.
   * `"unobserved"` when no evidence exists yet for this stream/connection.
   */
  readonly count_state: "known" | "known_zero" | "unobserved" | "stale" | "unknown";
  readonly last_updated: string | null;
  readonly freshness: RefConnectorDetailFreshness;
}

export interface RefConnectorDetailEnvelope {
  readonly object: "ref_connector_detail";
  readonly connector_id: string;
  readonly display_name: string;
  readonly manifest_version: string | null;
  /**
   * How this connector-keyed detail resolved to an owner connection
   * (reconcile-active-summary-evidence design.md "Central consumer and
   * cache boundary"): `"resolved"` when exactly one connection exists for
   * this connector_id, so every per-connection field below reflects that
   * single connection's evidence. `"unresolved"` (zero connections) or
   * `"ambiguous"` (2+ connections, none addressed unambiguously) OMIT
   * per-connection health/counts (`connection_health`/`total_records` read
   * `null`) rather than merging sibling evidence or fabricating a zero —
   * zero is a real count claim, not the same thing as "unresolvable."
   */
  readonly connection_resolution: "resolved" | "unresolved" | "ambiguous";
  /**
   * Per-connection health snapshot. Host-shaped (opaque `unknown` here,
   * matching `RefConnectorsListItem.connection_health` in the sibling list
   * operation) — the host's real richer type flows through without this
   * boundary-safe operation re-declaring its full shape. `null` when
   * `connection_resolution` is not `"resolved"`.
   */
  readonly connection_health: unknown;
  /** `null` when `connection_resolution` is not `"resolved"` — see that field's doc above. */
  readonly total_records: number | null;
  /**
   * Orthogonal state for `total_records` (reconcile-active-summary-evidence
   * design.md "Health boundary"): `"stale"` when the evidence row backing
   * `total_records` exists but its record_snapshot is not current — the
   * number is a non-authoritative carried-over hint, not a proven exact
   * count. `"unobserved"` when `connection_resolution` is not `"resolved"`
   * or no evidence row exists yet, matching `total_records: null`/`0`
   * there. A client MUST NOT render `total_records` as an authoritative
   * count unless this reads `"known"` or `"known_zero"`.
   */
  readonly total_records_state: "known" | "known_zero" | "unobserved" | "stale" | "unknown";
  readonly freshness: RefConnectorDetailFreshness;
  readonly schedule: unknown;
  readonly last_run: RefConnectorDetailRunSummary | null;
  readonly last_successful_run: RefConnectorDetailRunSummary | null;
  readonly recent_runs: RefConnectorDetailRunSummary[];
  readonly manifest_excerpt: RefConnectorDetailManifestExcerpt;
  /**
   * Declared stream NAMES are a connector-level catalog fact owned by the
   * registered manifest and remain present regardless of
   * `connection_resolution` — only each entry's per-connection
   * `record_count` (see {@link RefConnectorDetailStreamSummary}) is
   * resolution-dependent.
   */
  readonly streams: RefConnectorDetailStreamSummary[];
}

export interface RefConnectorDetailDependencies {
  /**
   * Resolve the connector detail for the requested id. Returns `null` when
   * the connector is unregistered or its manifest is unparseable; the
   * operation maps both to a `not_found`-shaped failure that the host can
   * translate to its native HTTP error envelope.
   *
   * Adapters MAY also throw their existing host-internal errors (for
   * example `RefControlError`); the operation does not catch them so the
   * host can keep its current error mapping.
   */
  getConnectorDetail(connectorId: string): Promise<Omit<RefConnectorDetailEnvelope, "object"> | null>;
}

export interface RefConnectorDetailInput {
  readonly connectorId: string;
}

export class RefConnectorDetailNotFoundError extends Error {
  readonly code = "not_found" as const;
  readonly connectorId: string;
  constructor(connectorId: string) {
    super(`Unknown connector: ${connectorId}`);
    this.connectorId = connectorId;
    this.name = "RefConnectorDetailNotFoundError";
  }
}

/**
 * Execute the canonical `ref.connectors.detail` operation.
 *
 * Hosts pass capability-shaped dependencies; the operation assembles the
 * `ref_connector_detail` envelope. The operation has no notion of HTTP,
 * owner sessions, headers, or framework — it returns the envelope (or
 * raises `RefConnectorDetailNotFoundError`) and lets the host write the
 * response.
 */
export async function executeRefConnectorDetail(
  input: RefConnectorDetailInput,
  dependencies: RefConnectorDetailDependencies,
): Promise<RefConnectorDetailEnvelope> {
  const detail = await dependencies.getConnectorDetail(input.connectorId);
  if (!detail) {
    throw new RefConnectorDetailNotFoundError(input.connectorId);
  }
  return {
    object: "ref_connector_detail",
    ...detail,
  };
}
