// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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
  readonly captured_at?: string;
  readonly last_attempted_at?: string;
  readonly status: "unknown";
}

export interface RefConnectorsListRunSummary {
  readonly event_count: number;
  readonly failure_reason: string | null;
  readonly finished_at: string | null;
  readonly first_at: string;
  readonly known_gaps: unknown[];
  readonly last_at: string;
  readonly run_id: string | undefined;
  readonly started_at: string;
  readonly status: string;
}

export interface RefConnectorsListStreamRecord {
  /**
   * Orthogonal state for `record_count` (reconcile-active-summary-evidence
   * design.md "Health boundary"): `"stale"` when the value is carried over
   * from a non-current record_snapshot — a non-authoritative hint, not a
   * proven exact count. Optional so existing non-evidence-backed callers of
   * this shape are unaffected.
   */
  readonly count_state?: "known" | "known_zero" | "unobserved" | "stale" | "unknown";
  readonly last_updated: string | null;
  readonly record_count: number;
  readonly stream: string;
}

export interface RefConnectorsListItem {
  readonly connection_health: unknown;
  readonly connection_id: string;
  readonly connector_display_name?: string;
  readonly connector_id: string;
  readonly connector_instance_id?: string;
  readonly display_name: string;
  readonly freshness: RefConnectorsListFreshness;
  readonly last_run: RefConnectorsListRunSummary | null;
  readonly last_successful_run: RefConnectorsListRunSummary | null;
  readonly manifest_version: string | null;
  readonly refresh_policy: unknown;
  readonly revoked_at?: string | null;
  readonly schedule: unknown;
  /** Server-owned work bucket; clients format this and do not classify health. */
  readonly source_work?: "needs_owner" | "not_measured" | "review" | "system_issue" | "working" | "none";
  readonly status?: string | null;
  readonly stream_count?: number;
  readonly stream_records?: readonly RefConnectorsListStreamRecord[];
  readonly streams: string[];
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
}

/**
 * `identity_inventory` profile row (Fable ruling terminal-read-architecture-
 * fable-0730.md §8, R8.1): the pinned field set, no health/evidence/run/
 * schedule/runtime field. Mirrors `server/ref-control.ts`'s
 * `ConnectorIdentityInventorySummary`.
 */
export interface RefConnectorsListIdentityItem {
  readonly connection_id: string;
  readonly connector_display_name: string;
  readonly connector_id: string;
  readonly connector_instance_id: string;
  readonly display_name: string;
  /** `"pending"` when no `connector_summary_evidence` row exists yet (declared-only). */
  readonly membership_state: "complete" | "pending";
  readonly streams: string[];
}

/**
 * `retained_count_summary` profile row (design doc add-source-perf-design-
 * agy-0730.md; Fable ruling terminal-read-architecture-fable-0730.md R4/R5):
 * the pinned field set for Add Source — identity + `total_records`/
 * `total_records_state`/`acquisition_coverage.latest_batch`, no health/run/
 * schedule/runtime field. Mirrors `server/ref-control.ts`'s
 * `ConnectorRetainedCountSummary`.
 */
export interface RefConnectorsListRetainedCountItem {
  readonly acquisition_coverage: { readonly latest_batch: Record<string, unknown> | null } | null;
  readonly connection_id: string;
  readonly connector_display_name: string;
  readonly connector_id: string;
  readonly connector_instance_id: string;
  readonly display_name: string;
  readonly revoked_at: string | null;
  readonly status: string;
  readonly total_records: number;
  readonly total_records_state: "known" | "known_zero" | "unobserved" | "stale" | "unknown";
}

export interface RefConnectorsRuntimeStatus {
  readonly label: string;
  readonly message: string | null;
  readonly object: "ref_runtime_status";
  readonly ok: boolean;
  readonly reason: "controller_unavailable" | null;
}

export interface RefConnectorsListDependencies {
  /**
   * Owner-only runtime liveness for the connector-control substrate. When false,
   * per-connection rendered verdicts are still honest about their own state but
   * SHALL NOT cascade into N owner-attention pulls; the caller renders this one
   * global status instead.
   */
  getRuntimeStatus?: () => Promise<RefConnectorsRuntimeStatus> | RefConnectorsRuntimeStatus;
  /**
   * Returns configured connection summaries for the route. Host
   * implementation owns the substrate read; the operation does not
   * inspect adapter internals. Order is not required from the dependency
   * — the operation preserves insertion order so the host can choose the
   * canonical sort.
   */
  listConnectorSummaries: () =>
    | Promise<
        | readonly RefConnectorsListItem[]
        | readonly RefConnectorsListIdentityItem[]
        | readonly RefConnectorsListRetainedCountItem[]
      >
    | readonly RefConnectorsListItem[]
    | readonly RefConnectorsListIdentityItem[]
    | readonly RefConnectorsListRetainedCountItem[];
  /**
   * Explicit keyset-page mode for the unscoped summary feed. Compatibility
   * callers keep using `listConnectorSummaries`, preserving their historical
   * envelope until they migrate to a bounded request.
   */
  listConnectorSummariesPage?: () => Promise<RefConnectorsListPage> | RefConnectorsListPage;
}

export interface RefConnectorsListPage {
  readonly data:
    | readonly RefConnectorsListItem[]
    | readonly RefConnectorsListIdentityItem[]
    | readonly RefConnectorsListRetainedCountItem[];
  readonly fleet_health?: unknown;
  readonly has_more: boolean;
  readonly next_cursor: string | null;
}

export interface RefConnectorsListEnvelope {
  readonly data: (RefConnectorsListItem | RefConnectorsListIdentityItem | RefConnectorsListRetainedCountItem)[];
  readonly fleet_health?: unknown;
  readonly has_more?: boolean;
  readonly next_cursor?: string | null;
  readonly object: "list";
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
  dependencies: RefConnectorsListDependencies
): Promise<RefConnectorsListEnvelope> {
  const [result, runtime] = await Promise.all([
    dependencies.listConnectorSummariesPage
      ? dependencies.listConnectorSummariesPage()
      : dependencies.listConnectorSummaries(),
    dependencies.getRuntimeStatus ? dependencies.getRuntimeStatus() : Promise.resolve(undefined),
  ]);
  const page = dependencies.listConnectorSummariesPage ? (result as RefConnectorsListPage) : null;
  const summaries = page
    ? page.data
    : (result as readonly RefConnectorsListItem[] | readonly RefConnectorsListIdentityItem[]);
  const envelope: RefConnectorsListEnvelope = {
    data: [...summaries],
    object: "list",
    ...(page ? { has_more: page.has_more, next_cursor: page.next_cursor } : {}),
    ...(page?.fleet_health === undefined ? {} : { fleet_health: page.fleet_health }),
  };
  return runtime ? { ...envelope, runtime } : envelope;
}
