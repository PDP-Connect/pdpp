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
  readonly record_count: number;
  readonly last_updated: string | null;
  readonly freshness: RefConnectorDetailFreshness;
}

export interface RefConnectorDetailEnvelope {
  readonly object: "ref_connector_detail";
  readonly connector_id: string;
  readonly display_name: string;
  readonly manifest_version: string | null;
  readonly total_records: number;
  readonly freshness: RefConnectorDetailFreshness;
  readonly schedule: unknown;
  readonly last_run: RefConnectorDetailRunSummary | null;
  readonly last_successful_run: RefConnectorDetailRunSummary | null;
  readonly recent_runs: RefConnectorDetailRunSummary[];
  readonly manifest_excerpt: RefConnectorDetailManifestExcerpt;
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
