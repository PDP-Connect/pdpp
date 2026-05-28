/**
 * Canonical `ref.spine.correlations.list` operation.
 *
 * Owns the envelope semantics for the reference-only operator-console
 * correlation lists that power `GET /_ref/traces`, `GET /_ref/grants`,
 * and `GET /_ref/runs`. Host adapters supply paginated correlation
 * summaries via the dependency contract; the operation owns the
 * per-kind discriminator (`trace_summary` | `grant_summary` |
 * `run_summary`), the `{object: 'list', data, has_more}` envelope, and
 * the optional-`next_cursor` emission rule (only present when the
 * underlying page exposes one).
 *
 * This is reference/operator surface, not PDPP protocol. Clients must
 * not depend on the response shape.
 *
 * Boundary rules (see openspec/changes/mount-ref-spine-operations):
 * - This module SHALL NOT import Fastify, Express, Next, SQLite,
 *   Postgres, a raw SQL handle, sandbox modules,
 *   `reference-implementation/server/*` route or auth modules, or
 *   `process` / `process.env`.
 * - The spine read flows in through a dependency. The host wires the
 *   concrete read (`listSpineCorrelations` in
 *   `reference-implementation/lib/spine.ts`).
 */

export type RefSpineCorrelationKind = "trace" | "grant" | "run";

export interface RefSpineFailureSummary {
  readonly event_type: string;
  readonly reason: string | null;
}

export interface RefSpineSource {
  readonly kind: "connector" | "provider_native";
  readonly id: string;
}

/**
 * Subset of the spine summary shape consumed by the per-kind
 * projections. The operation does not depend on every field of the
 * underlying `SpineSummary` — only the fields actually projected into
 * the operator-console envelope. Keeping the dependency contract narrow
 * means a future spine-summary refactor that adds new fields does not
 * force a change here.
 */
export interface RefSpineCorrelationSummary {
  readonly browser_surface_lease_id?: string;
  readonly browser_surface_profile_key?: string;
  readonly browser_surface_status?: string;
  readonly browser_surface_wait_reason?: string;
  readonly id?: string;
  readonly first_at: string;
  readonly last_at: string;
  readonly event_count: number;
  readonly status: string;
  readonly kinds: readonly string[];
  readonly request_id: string | null;
  readonly grant_id: string | null;
  /**
   * Parent grant-package id when the grant's binding token carries
   * `package_id`. Optional — populated by the host's spine read for
   * kind=`grant` and absent otherwise.
   */
  readonly grant_package_id?: string | null;
  readonly run_id: string | null;
  readonly client_id: string | null;
  readonly connector_id: string | null;
  readonly source: RefSpineSource | null;
  readonly source_id: string | null;
  readonly source_kind: "connector" | "provider_native" | null;
  readonly actor_type: string;
  readonly actor_id: string;
  readonly failure: RefSpineFailureSummary | null;
  readonly needs_input: boolean;
}

export interface RefSpineCorrelationPage {
  readonly summaries: readonly RefSpineCorrelationSummary[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}

/**
 * Free-form filter bag forwarded to the host's spine read. The
 * operation does not introspect filter semantics — the host owns query
 * parsing and validation. Keeping this opaque keeps the dependency
 * boundary narrow.
 */
export type RefSpineCorrelationFilters = Readonly<Record<string, unknown>>;

export interface RefSpineCorrelationsListInput {
  readonly kind: RefSpineCorrelationKind;
  readonly filters: RefSpineCorrelationFilters;
}

export interface RefSpineCorrelationsListDependencies {
  /**
   * Returns a page of correlation summaries for the given kind and
   * filter set. The host implementation owns substrate access (cursor
   * decoding, SQL pagination); the operation projects each summary into
   * a per-kind discriminator and assembles the envelope.
   */
  listSpineCorrelations(
    kind: RefSpineCorrelationKind,
    filters: RefSpineCorrelationFilters,
  ): Promise<RefSpineCorrelationPage> | RefSpineCorrelationPage;
}

export interface RefSpineTraceSummary {
  readonly object: "trace_summary";
  readonly trace_id: string | undefined;
  readonly first_at: string;
  readonly last_at: string;
  readonly event_count: number;
  readonly status: string;
  readonly kinds: readonly string[];
  readonly request_id: string | null;
  readonly grant_id: string | null;
  readonly run_id: string | null;
  readonly client_id: string | null;
  readonly source: RefSpineSource | null;
  readonly actor_type: string;
  readonly actor_id: string;
  readonly failure: RefSpineFailureSummary | null;
}

export interface RefSpineGrantSummary {
  readonly object: "grant_summary";
  readonly grant_id: string | undefined;
  /**
   * Parent grant-package id when this grant's binding token carries
   * `package_id`. Optional and omitted when absent so existing consumers
   * (clients that ignore unknown fields by contract) continue to work.
   */
  readonly grant_package_id?: string;
  readonly first_at: string;
  readonly last_at: string;
  readonly event_count: number;
  readonly status: string;
  readonly kinds: readonly string[];
  readonly client_id: string | null;
  readonly source: RefSpineSource | null;
  readonly failure: RefSpineFailureSummary | null;
}

export interface RefSpineRunSummary {
  readonly browser_surface_lease_id?: string;
  readonly browser_surface_profile_key?: string;
  readonly browser_surface_status?: string;
  readonly browser_surface_wait_reason?: string;
  readonly object: "run_summary";
  readonly run_id: string | undefined;
  readonly connector_id: string | null;
  readonly first_at: string;
  readonly last_at: string;
  readonly event_count: number;
  readonly status: string;
  readonly kinds: readonly string[];
  readonly needs_input: boolean;
  readonly source: RefSpineSource | null;
  readonly grant_id: string | null;
  readonly failure_reason: string | null;
}

export type RefSpineCorrelationEntry =
  | RefSpineTraceSummary
  | RefSpineGrantSummary
  | RefSpineRunSummary;

export interface RefSpineCorrelationsListEnvelope {
  readonly object: "list";
  readonly data: readonly RefSpineCorrelationEntry[];
  readonly has_more: boolean;
  readonly next_cursor?: string;
}

function sourceFromSummary(s: RefSpineCorrelationSummary): RefSpineSource | null {
  if (s.source) {
    return s.source;
  }
  if (s.source_kind && s.source_id) {
    return { kind: s.source_kind, id: s.source_id };
  }
  if (s.connector_id) {
    return { kind: "connector", id: s.connector_id };
  }
  return null;
}

export function summaryToTrace(s: RefSpineCorrelationSummary): RefSpineTraceSummary {
  return {
    object: "trace_summary",
    trace_id: s.id,
    first_at: s.first_at,
    last_at: s.last_at,
    event_count: s.event_count,
    status: s.status,
    kinds: s.kinds,
    request_id: s.request_id,
    grant_id: s.grant_id,
    run_id: s.run_id,
    client_id: s.client_id,
    source: sourceFromSummary(s),
    actor_type: s.actor_type,
    actor_id: s.actor_id,
    failure: s.failure,
  };
}

export function summaryToGrant(s: RefSpineCorrelationSummary): RefSpineGrantSummary {
  return {
    object: "grant_summary",
    grant_id: s.id,
    first_at: s.first_at,
    last_at: s.last_at,
    event_count: s.event_count,
    status: s.status,
    kinds: s.kinds,
    client_id: s.client_id,
    source: sourceFromSummary(s),
    failure: s.failure,
    ...(s.grant_package_id ? { grant_package_id: s.grant_package_id } : {}),
  };
}

export function summaryToRun(s: RefSpineCorrelationSummary): RefSpineRunSummary {
  return {
    object: "run_summary",
    run_id: s.id,
    connector_id: s.connector_id,
    first_at: s.first_at,
    last_at: s.last_at,
    event_count: s.event_count,
    status: s.status,
    kinds: s.kinds,
    needs_input: Boolean(s.needs_input),
    source: sourceFromSummary(s),
    grant_id: s.grant_id,
    failure_reason: s.failure?.reason || null,
    ...(s.browser_surface_status ? { browser_surface_status: s.browser_surface_status } : {}),
    ...(s.browser_surface_wait_reason ? { browser_surface_wait_reason: s.browser_surface_wait_reason } : {}),
    ...(s.browser_surface_lease_id ? { browser_surface_lease_id: s.browser_surface_lease_id } : {}),
    ...(s.browser_surface_profile_key ? { browser_surface_profile_key: s.browser_surface_profile_key } : {}),
  };
}

const PROJECTORS = {
  trace: summaryToTrace,
  grant: summaryToGrant,
  run: summaryToRun,
} as const;

/**
 * Execute the canonical `ref.spine.correlations.list` operation.
 *
 * The operation projects each correlation summary into the per-kind
 * discriminated entry and assembles the `{object: 'list', data,
 * has_more}` envelope, attaching `next_cursor` only when the underlying
 * page exposes one. The operation has no notion of HTTP, owner
 * sessions, or framework.
 */
export async function executeRefSpineCorrelationsList(
  input: RefSpineCorrelationsListInput,
  dependencies: RefSpineCorrelationsListDependencies,
): Promise<RefSpineCorrelationsListEnvelope> {
  const page = await dependencies.listSpineCorrelations(input.kind, input.filters);
  const project = PROJECTORS[input.kind];
  const data = page.summaries.map((summary) => project(summary));
  const envelope: RefSpineCorrelationsListEnvelope = {
    object: "list",
    data,
    has_more: page.hasMore,
  };
  if (page.nextCursor) {
    return { ...envelope, next_cursor: page.nextCursor };
  }
  return envelope;
}
