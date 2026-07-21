/**
 * Canonical `rs.streams.list` operation.
 *
 * Owns the AS/RS stream-list semantics independent of HTTP framework, sandbox
 * UI, concrete database driver, and `process.env`. Both the native Fastify
 * `GET /v1/streams` route and the website sandbox `GET /sandbox/v1/streams`
 * route mount this operation; differences in transport, authentication,
 * pagination, and freshness shape live in the host adapters.
 *
 * Boundary rules (see openspec/changes/mount-rs-streams-list-operation):
 * - This module SHALL NOT import Fastify, Next, SQLite, Postgres, a raw SQL
 *   handle, a generic repository, or `process.env`.
 * - Stream summary capabilities are passed in as `dependencies`. Hosts wire
 *   the concrete implementations: native -> records.js helpers; sandbox ->
 *   fixture helpers backed by `_demo/dataset.ts`.
 */

export interface StreamsListSourceDescriptor {
  kind: "connector" | "provider_native";
  id: string;
  [extra: string]: unknown;
}

export interface StreamSummary {
  /** Always the literal "stream" — matches the live RS list-item shape. */
  object: "stream";
  /** Stream name as declared in the manifest. */
  name: string;
  /** Number of visible records under the actor's scope. */
  record_count: number;
  /** ISO 8601 timestamp of the latest visible record, or null. */
  last_updated: string | null;
  /**
   * Canonical public identifier of the connection (owner-configured
   * account/device/profile) the entry attributes to, when known. Populated
   * by host adapters from the storage binding; omitted only when the
   * deployment cannot resolve a single connection for the (stream, actor)
   * pair — in which case multi-connection deployments SHALL emit one
   * entry per (stream, connection_id). Owned by:
   *   openspec/changes/expose-connection-identity-on-public-read
   */
  connection_id?: string;
  /**
   * Owner-meaningful label for the connection. Never the storage-layer
   * placeholder (`legacy`, `default_account`); host adapters SHOULD fall
   * back to `<connector> · account N` when the owner has not renamed the
   * connection. Omitted only when `connection_id` is also omitted.
   */
  display_name?: string;
  /**
   * Deprecated wire alias for `connection_id`. Carries the same opaque
   * value during the migration window so pre-migration consumers can
   * continue reading.
   */
  connector_instance_id?: string;
  /**
   * Connector identity for owner-wide polyfill stream catalogs where there
   * is no single request-level source descriptor. Omitted for single-source
   * calls whose `sourceDescriptor` already identifies the source.
   */
  connector_id?: string;
  /** Per-entry source descriptor for owner-wide polyfill stream catalogs. */
  source?: StreamsListSourceDescriptor;
}

export type StreamsListActor =
  | { kind: "owner"; subject_id: string | null }
  | {
      kind: "client";
      subject_id: string | null;
      client_id: string | null;
      grant_id: string | null;
      stream_count_limit: number | null;
    };

export interface StreamsListDependencies {
  /**
   * Returns the stream summaries the actor is allowed to see, in the order
   * the host wants them rendered. Implementations are responsible for the
   * actor's visibility rules (owner-wide vs grant-scoped vs fixture).
   */
  listSummaries(): Promise<StreamSummary[]>;
  /**
   * Source descriptor that should appear in instrumentation events for this
   * call (`source` field on disclosure.served / query.received). Hosts
   * compute this once and hand it to the operation so dependency
   * implementations stay narrow.
   */
  getSourceDescriptor(): StreamsListSourceDescriptor | null;
}

export interface StreamsListInput {
  actor: StreamsListActor;
  /**
   * Optional canonical `connection_id` filter. Hosts forward this through
   * `listSummaries` so the storage layer can restrict its scan to a single
   * connection. Omitted, the operation returns the union across whatever
   * connections the actor's scope authorizes for each stream (fan-in by
   * default). Pre-migration callers MAY pass the deprecated
   * `connector_instance_id` alias instead; the host adapter is responsible
   * for resolving both fields to the same canonical value and for
   * rejecting requests where they refer to different connections.
   */
  connection_id?: string | null;
}

export interface StreamsListOutput {
  /** Canonical list of stream summaries; envelope shape is host-owned. */
  streams: StreamSummary[];
  /** Echoed for instrumentation parity with the native route. */
  sourceDescriptor: StreamsListSourceDescriptor | null;
  /**
   * `query.received`-shaped data block. Hosts pass this through to the
   * disclosure spine; the operation populates the conserved fields.
   */
  queryData: {
    query_shape: "stream_list";
    stream_count_limit?: number | null;
  };
}

/**
 * Execute the canonical `rs.streams.list` operation.
 *
 * Pure of any transport: callers translate `Request`/`URLSearchParams`/Fastify
 * into `StreamsListInput` and translate `StreamsListOutput.streams` into the
 * envelope their host emits.
 */
export async function executeStreamsList(
  input: StreamsListInput,
  dependencies: StreamsListDependencies,
): Promise<StreamsListOutput> {
  const sourceDescriptor = dependencies.getSourceDescriptor();
  const streams = await dependencies.listSummaries();

  const queryData: StreamsListOutput["queryData"] = {
    query_shape: "stream_list",
  };
  if (input.actor.kind === "client") {
    queryData.stream_count_limit = input.actor.stream_count_limit;
  }

  return {
    streams,
    sourceDescriptor,
    queryData,
  };
}
