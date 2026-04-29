/**
 * Canonical `ref.connectors.list` operation.
 *
 * Owns the envelope semantics for the reference-only operator-console
 * connector catalog that powers `GET /_ref/connectors`. Host adapters
 * (Fastify route in `reference-implementation/server/index.js`) supply
 * connector-summary data via the dependency contract; the operation owns
 * the `{object: 'list', data}` envelope and its element ordering.
 *
 * This is reference/operator surface, not PDPP protocol. Clients must not
 * depend on the response shape.
 *
 * Boundary rules (see openspec/changes/mount-ref-connectors-approvals-operations):
 * - This module SHALL NOT import Fastify, Express, Next, SQLite, Postgres,
 *   a raw SQL handle, sandbox modules, `reference-implementation/server/*`
 *   route or auth modules, or `process` / `process.env`.
 * - Connector-summary capabilities flow in through dependencies. The host
 *   wires the concrete reads (e.g. `listConnectorSummaries` in
 *   `server/ref-control.ts`).
 */

export interface RefConnectorsListFreshness {
  readonly status: "unknown";
  readonly captured_at?: string;
  readonly last_attempted_at?: string;
}

export interface RefConnectorsListRunSummary {
  readonly run_id: string | undefined;
  readonly status: string;
  readonly started_at: string;
  readonly finished_at: string | null;
  readonly first_at: string;
  readonly last_at: string;
  readonly event_count: number;
  readonly failure_reason: string | null;
  readonly known_gaps: unknown[];
}

export interface RefConnectorsListItem {
  readonly connector_id: string;
  readonly display_name: string;
  readonly manifest_version: string | null;
  readonly streams: string[];
  readonly total_records: number;
  readonly freshness: RefConnectorsListFreshness;
  readonly refresh_policy: unknown;
  readonly schedule: unknown;
  readonly last_run: RefConnectorsListRunSummary | null;
  readonly last_successful_run: RefConnectorsListRunSummary | null;
}

export interface RefConnectorsListDependencies {
  /**
   * Returns the connector summaries to surface in the catalog. Host
   * implementation owns the substrate read; the operation does not
   * inspect adapter internals. Order is not required from the dependency
   * — the operation preserves insertion order so the host can choose the
   * canonical sort (currently the registered-connectors row order).
   */
  listConnectorSummaries(): Promise<readonly RefConnectorsListItem[]> | readonly RefConnectorsListItem[];
}

export interface RefConnectorsListEnvelope {
  readonly object: "list";
  readonly data: RefConnectorsListItem[];
}

/**
 * Execute the canonical `ref.connectors.list` operation.
 *
 * Hosts pass capability-shaped dependencies; the operation assembles the
 * `{object: 'list', data}` envelope. The operation has no notion of HTTP,
 * owner sessions, headers, or framework — it returns the envelope and lets
 * the host write the response.
 */
export async function executeRefConnectorsList(
  dependencies: RefConnectorsListDependencies,
): Promise<RefConnectorsListEnvelope> {
  const summaries = await dependencies.listConnectorSummaries();
  return {
    object: "list",
    data: [...summaries],
  };
}
