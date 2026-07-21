/**
 * Canonical `ref.connectors.list` operation.
 *
 * Owns the envelope semantics for the legacy reference-only
 * connector-summary list at `GET /_ref/connectors`. Despite the route name,
 * each item is a configured connection summary (`connection_id` is required);
 * the addable connector catalog is a separate registered-manifest surface.
 * Host adapters supply connector-summary data via the dependency contract;
 * the operation owns the `{object: 'list', data}` envelope and its element
 * ordering.
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

export interface RefConnectorsListStreamRecord {
  readonly last_updated: string | null;
  readonly record_count: number;
  readonly stream: string;
  /**
   * Orthogonal state for `record_count` (reconcile-active-summary-evidence
   * design.md "Health boundary"): `"stale"` when the value is carried over
   * from a non-current record_snapshot — a non-authoritative hint, not a
   * proven exact count. Optional so existing non-evidence-backed callers of
   * this shape are unaffected.
   */
  readonly count_state?: "known" | "known_zero" | "unobserved" | "stale" | "unknown";
}

export interface RefConnectorsListItem {
  readonly connection_id: string;
  readonly connection_health: unknown;
  readonly connector_display_name?: string;
  readonly connector_id: string;
  readonly connector_instance_id?: string;
  readonly display_name: string;
  readonly manifest_version: string | null;
  readonly streams: string[];
  readonly stream_count?: number;
  readonly stream_records?: readonly RefConnectorsListStreamRecord[];
  readonly total_records: number;
  /**
   * Orthogonal state for `total_records` (reconcile-active-summary-evidence
   * design.md "Health boundary"): `"stale"` when the evidence row backing
   * `total_records` exists but its record_snapshot is not current — the
   * number is a non-authoritative carried-over hint, not a proven exact
   * count. Optional so existing non-evidence-backed callers of this shape
   * are unaffected. A client MUST NOT render `total_records` as an
   * authoritative count unless this reads `"known"` or `"known_zero"`.
   */
  readonly total_records_state?: "known" | "known_zero" | "unobserved" | "stale" | "unknown";
  readonly total_retained_bytes?: number | null;
  readonly freshness: RefConnectorsListFreshness;
  readonly refresh_policy: unknown;
  readonly revoked_at?: string | null;
  readonly schedule: unknown;
  readonly status?: string | null;
  readonly last_run: RefConnectorsListRunSummary | null;
  readonly last_successful_run: RefConnectorsListRunSummary | null;
}

export interface RefConnectorsRuntimeStatus {
  readonly object: "ref_runtime_status";
  readonly ok: boolean;
  readonly reason: "controller_unavailable" | null;
  readonly label: string;
  readonly message: string | null;
}

export interface RefConnectorsListDependencies {
  /**
   * Returns configured connection summaries for the route. Host
   * implementation owns the substrate read; the operation does not
   * inspect adapter internals. Order is not required from the dependency
   * — the operation preserves insertion order so the host can choose the
   * canonical sort.
   */
  listConnectorSummaries(): Promise<readonly RefConnectorsListItem[]> | readonly RefConnectorsListItem[];
  /**
   * Owner-only runtime liveness for the connector-control substrate. When false,
   * per-connection rendered verdicts are still honest about their own state but
   * SHALL NOT cascade into N owner-attention pulls; the caller renders this one
   * global status instead.
   */
  getRuntimeStatus?(): Promise<RefConnectorsRuntimeStatus> | RefConnectorsRuntimeStatus;
}

export interface RefConnectorsListEnvelope {
  readonly object: "list";
  readonly data: RefConnectorsListItem[];
  readonly runtime?: RefConnectorsRuntimeStatus;
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
  const [summaries, runtime] = await Promise.all([
    dependencies.listConnectorSummaries(),
    dependencies.getRuntimeStatus ? dependencies.getRuntimeStatus() : Promise.resolve(undefined),
  ]);
  const envelope: RefConnectorsListEnvelope = {
    object: "list",
    data: [...summaries],
  };
  return runtime ? { ...envelope, runtime } : envelope;
}
