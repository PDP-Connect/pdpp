// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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

export interface RefSpineClientMetadata {
  readonly client_id: string;
  readonly client_name: string | null;
  readonly registration_mode: string | null;
}

export interface RefSpineSource {
  readonly id: string;
  readonly kind: "connector" | "provider_native";
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
  readonly actor_id: string;
  readonly actor_type: string;
  readonly browser_surface_lease_id?: string;
  readonly browser_surface_profile_key?: string;
  readonly browser_surface_status?: string;
  readonly browser_surface_wait_reason?: string;
  readonly client?: RefSpineClientMetadata | null;
  readonly client_id: string | null;
  readonly connection_id?: string | null;
  readonly connector_id: string | null;
  readonly connector_instance_id?: string | null;
  readonly event_count: number;
  readonly failure: RefSpineFailureSummary | null;
  readonly first_at: string;
  readonly grant_id: string | null;
  /**
   * Parent grant-package id when the grant's binding token carries
   * `package_id`. Optional — populated by the host's spine read for
   * kind=`grant` and absent otherwise.
   */
  readonly grant_package_id?: string | null;
  readonly id?: string;
  readonly kinds: readonly string[];
  readonly last_at: string;
  readonly needs_input: boolean;
  readonly request_id: string | null;
  readonly run_id: string | null;
  readonly source: RefSpineSource | null;
  readonly source_id: string | null;
  readonly source_kind: "connector" | "provider_native" | null;
  readonly status: string;
}

export interface RefSpineCorrelationPage {
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
  readonly summaries: readonly RefSpineCorrelationSummary[];
}

/**
 * Free-form filter bag forwarded to the host's spine read. The
 * operation does not introspect filter semantics — the host owns query
 * parsing and validation. Keeping this opaque keeps the dependency
 * boundary narrow.
 */
export type RefSpineCorrelationFilters = Readonly<Record<string, unknown>>;

export interface RefSpineCorrelationsListInput {
  readonly filters: RefSpineCorrelationFilters;
  readonly kind: RefSpineCorrelationKind;
}

export interface RefSpineCorrelationsListDependencies {
  /**
   * Optional owner-surface guard supplied by the host. The pure operation does
   * not import server connector-key helpers, but owner-facing lists must not
   * expose reference-internal maintenance connectors.
   */
  isInternalConnectorId?: (id: string) => boolean;
  /**
   * Returns a page of correlation summaries for the given kind and
   * filter set. The host implementation owns substrate access (cursor
   * decoding, SQL pagination); the operation projects each summary into
   * a per-kind discriminator and assembles the envelope.
   */
  listSpineCorrelations: (
    kind: RefSpineCorrelationKind,
    filters: RefSpineCorrelationFilters
  ) => Promise<RefSpineCorrelationPage> | RefSpineCorrelationPage;
}

export interface RefSpineTraceSummary {
  readonly actor_id: string;
  readonly actor_type: string;
  readonly client?: RefSpineClientMetadata;
  readonly client_id: string | null;
  readonly event_count: number;
  readonly failure: RefSpineFailureSummary | null;
  readonly first_at: string;
  readonly grant_id: string | null;
  readonly kinds: readonly string[];
  readonly last_at: string;
  readonly object: "trace_summary";
  readonly request_id: string | null;
  readonly run_id: string | null;
  readonly source: RefSpineSource | null;
  readonly status: string;
  readonly trace_id: string | undefined;
}

export interface RefSpineGrantSummary {
  readonly client?: RefSpineClientMetadata;
  readonly client_id: string | null;
  readonly event_count: number;
  readonly failure: RefSpineFailureSummary | null;
  readonly first_at: string;
  readonly grant_id: string | undefined;
  /**
   * Parent grant-package id when this grant's binding token carries
   * `package_id`. Optional and omitted when absent so existing consumers
   * (clients that ignore unknown fields by contract) continue to work.
   */
  readonly grant_package_id?: string;
  readonly kinds: readonly string[];
  readonly last_at: string;
  readonly object: "grant_summary";
  readonly source: RefSpineSource | null;
  readonly status: string;
}

export interface RefSpineRunSummary {
  readonly browser_surface_lease_id?: string;
  readonly browser_surface_profile_key?: string;
  readonly browser_surface_status?: string;
  readonly browser_surface_wait_reason?: string;
  readonly connection_id?: string | null;
  readonly connector_id: string | null;
  readonly connector_instance_id?: string | null;
  readonly event_count: number;
  readonly failure_reason: string | null;
  readonly first_at: string;
  readonly grant_id: string | null;
  readonly kinds: readonly string[];
  readonly last_at: string;
  readonly needs_input: boolean;
  readonly object: "run_summary";
  readonly run_id: string | undefined;
  readonly source: RefSpineSource | null;
  readonly status: string;
}

export type RefSpineCorrelationEntry = RefSpineTraceSummary | RefSpineGrantSummary | RefSpineRunSummary;

export interface RefSpineCorrelationsListEnvelope {
  readonly data: readonly RefSpineCorrelationEntry[];
  readonly has_more: boolean;
  readonly next_cursor?: string;
  readonly object: "list";
}

function sourceFromSummary(s: RefSpineCorrelationSummary): RefSpineSource | null {
  if (s.source) {
    return s.source;
  }
  if (s.source_kind && s.source_id) {
    return { id: s.source_id, kind: s.source_kind };
  }
  if (s.connector_id) {
    return { id: s.connector_id, kind: "connector" };
  }
  return null;
}

function summarySourceId(s: RefSpineCorrelationSummary): string | null {
  if (s.source?.id) {
    return s.source.id;
  }
  if (s.source_id) {
    return s.source_id;
  }
  if (s.connector_id) {
    return s.connector_id;
  }
  return null;
}

function isOwnerVisibleSummary(
  summary: RefSpineCorrelationSummary,
  isInternalConnectorId: RefSpineCorrelationsListDependencies["isInternalConnectorId"]
): boolean {
  const sourceId = summarySourceId(summary);
  return !(sourceId && isInternalConnectorId?.(sourceId));
}

function connectionIdFromBrowserSurfaceProfileKey(profileKey: string | null | undefined): string | null {
  if (!profileKey) {
    return null;
  }
  const suffix = profileKey.split(":").at(-1);
  return suffix?.startsWith("cin_") ? suffix : null;
}

function runConnectionIdentity(s: RefSpineCorrelationSummary): string | null {
  return (
    s.connection_id ??
    s.connector_instance_id ??
    connectionIdFromBrowserSurfaceProfileKey(s.browser_surface_profile_key)
  );
}

function runFailureReason(s: RefSpineCorrelationSummary): string | null {
  if (s.failure?.reason) {
    return s.failure.reason;
  }
  if (s.status === "surface_failed") {
    return s.browser_surface_wait_reason || s.browser_surface_status || "browser_surface_failed";
  }
  return null;
}

export function summaryToTrace(s: RefSpineCorrelationSummary): RefSpineTraceSummary {
  return {
    client_id: s.client_id,
    event_count: s.event_count,
    first_at: s.first_at,
    grant_id: s.grant_id,
    kinds: s.kinds,
    last_at: s.last_at,
    object: "trace_summary",
    request_id: s.request_id,
    run_id: s.run_id,
    status: s.status,
    trace_id: s.id,
    ...(s.client ? { client: s.client } : {}),
    actor_id: s.actor_id,
    actor_type: s.actor_type,
    failure: s.failure,
    source: sourceFromSummary(s),
  };
}

export function summaryToGrant(s: RefSpineCorrelationSummary): RefSpineGrantSummary {
  return {
    client_id: s.client_id,
    event_count: s.event_count,
    first_at: s.first_at,
    grant_id: s.id,
    kinds: s.kinds,
    last_at: s.last_at,
    object: "grant_summary",
    status: s.status,
    ...(s.client ? { client: s.client } : {}),
    failure: s.failure,
    source: sourceFromSummary(s),
    ...(s.grant_package_id ? { grant_package_id: s.grant_package_id } : {}),
  };
}

export function summaryToRun(s: RefSpineCorrelationSummary): RefSpineRunSummary {
  const connectionId = runConnectionIdentity(s);
  return {
    object: "run_summary",
    run_id: s.id,
    ...(connectionId ? { connection_id: connectionId, connector_instance_id: connectionId } : {}),
    connector_id: s.connector_id,
    event_count: s.event_count,
    failure_reason: runFailureReason(s),
    first_at: s.first_at,
    grant_id: s.grant_id,
    kinds: s.kinds,
    last_at: s.last_at,
    needs_input: Boolean(s.needs_input),
    source: sourceFromSummary(s),
    status: s.status,
    ...(s.browser_surface_status ? { browser_surface_status: s.browser_surface_status } : {}),
    ...(s.browser_surface_wait_reason ? { browser_surface_wait_reason: s.browser_surface_wait_reason } : {}),
    ...(s.browser_surface_lease_id ? { browser_surface_lease_id: s.browser_surface_lease_id } : {}),
    ...(s.browser_surface_profile_key ? { browser_surface_profile_key: s.browser_surface_profile_key } : {}),
  };
}

const PROJECTORS = {
  grant: summaryToGrant,
  run: summaryToRun,
  trace: summaryToTrace,
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
  dependencies: RefSpineCorrelationsListDependencies
): Promise<RefSpineCorrelationsListEnvelope> {
  const page = await dependencies.listSpineCorrelations(input.kind, input.filters);
  const project = PROJECTORS[input.kind];
  const data = page.summaries
    .filter((summary) => isOwnerVisibleSummary(summary, dependencies.isInternalConnectorId))
    .map((summary) => project(summary));
  const envelope: RefSpineCorrelationsListEnvelope = {
    data,
    has_more: page.hasMore,
    object: "list",
  };
  if (page.nextCursor) {
    return { ...envelope, next_cursor: page.nextCursor };
  }
  return envelope;
}
