/**
 * Canonical `rs.schema.get` operation.
 *
 * Owns the AS/RS schema-discovery semantics for `GET /v1/schema` independent
 * of HTTP framework, sandbox UI, concrete database driver, and `process.env`.
 * Both the native Fastify route and the website sandbox
 * `GET /sandbox/v1/schema` route mount this operation; the per-connector item
 * assembly stays behind a dependency because native and sandbox draw their
 * connector-item shapes from different sources (manifest + grant + freshness
 * vs deterministic demo data).
 *
 * Boundary rules (see openspec/changes/mount-rs-schema-get-operation):
 * - This module SHALL NOT import Fastify, Next, SQLite, Postgres, a raw SQL
 *   handle, a generic repository, or `process.env`.
 * - Manifest, grant-visibility, registered-connector enumeration, freshness,
 *   and per-connector item assembly are passed in as `dependencies`. Hosts
 *   wire the concrete implementations: native -> server/index.js manifest +
 *   grant + buildConnectorSchemaItem; sandbox -> fixture helpers backed by
 *   `_demo/dataset.ts` + buildLiveStreamMetadata.
 */

export interface SchemaGetSourceDescriptor {
  kind: "connector" | "provider_native";
  id: string;
  [extra: string]: unknown;
}

/**
 * Host-shaped per-connector schema item. The operation does not constrain
 * fields beyond `object` / `source` / `stream_count` / `streams` because
 * native (rich `field_capabilities`, freshness, grant projections) and
 * sandbox (deterministic demo metadata) intentionally differ today; envelope
 * shape is a host concern.
 */
export interface ConnectorSchemaItem {
  object: "connector";
  source: SchemaGetSourceDescriptor;
  stream_count: number;
  streams: Array<{ object: "stream_metadata"; name: string; [extra: string]: unknown }>;
  connector_id?: string;
  connector_key?: string;
  [extra: string]: unknown;
}

export type SchemaGetActor =
  | { kind: "owner"; subject_id: string | null }
  | {
      kind: "client";
      subject_id: string | null;
      client_id: string | null;
      grant_id: string | null;
    };

export interface SchemaGetDependencies {
  /**
   * Returns the connector schema items the actor is allowed to see, in the
   * order the host wants them rendered. Implementations are responsible for
   * the actor's visibility rules (owner native binding vs owner registered
   * connectors vs client grant scope vs sandbox fixtures).
   */
  listConnectorItems(): Promise<ConnectorSchemaItem[]>;
  /**
   * Source descriptor that should appear in instrumentation events for this
   * call (`source` field on disclosure.served / query.received). Some owner
   * branches (e.g. owner with multiple registered connectors and no
   * primary native binding) intentionally have no single source descriptor;
   * implementations may return `null` in that case to match the prior
   * native behavior.
   */
  getSourceDescriptor(): SchemaGetSourceDescriptor | null;
}

export interface SchemaGetInput {
  actor: SchemaGetActor;
}

/** `bearer` block on the schema response — bearer projection is operation-owned. */
export interface SchemaGetBearer {
  token_kind: "owner" | "client";
  scope: "owner" | "grant";
  grant_id?: string;
  client_id?: string;
}

export interface SchemaGetOutput {
  /** Canonical schema response envelope. */
  response: {
    object: "schema";
    bearer: SchemaGetBearer;
    connectors: ConnectorSchemaItem[];
  };
  /**
   * Echoed for instrumentation parity with the native route. Hosts thread
   * this into `query.received` and `disclosure.served` events. May be `null`
   * when no single source descriptor applies (owner across multiple
   * registered connectors).
   */
  sourceDescriptor: SchemaGetSourceDescriptor | null;
  /**
   * `query.received`-shaped data block. Hosts pass this through to the
   * disclosure spine; the operation populates the conserved fields.
   */
  queryData: { query_shape: "schema" };
  /**
   * Connector and stream counts derived from `response.connectors`. Hosts
   * use these for the `disclosure.served` data block so the operation does
   * not require hosts to recompute them from the response shape.
   */
  counts: { connector_count: number; stream_count: number };
}

function projectBearer(actor: SchemaGetActor): SchemaGetBearer {
  if (actor.kind === "owner") {
    return { token_kind: "owner", scope: "owner" };
  }
  const bearer: SchemaGetBearer = { token_kind: "client", scope: "grant" };
  if (actor.grant_id) {
    bearer.grant_id = actor.grant_id;
  }
  if (actor.client_id) {
    bearer.client_id = actor.client_id;
  }
  return bearer;
}

/**
 * Execute the canonical `rs.schema.get` operation.
 *
 * Pure of any transport: callers translate `Request`/Fastify `req` into
 * `SchemaGetInput` and translate `SchemaGetOutput.response` into the
 * envelope their host emits.
 */
export async function executeSchemaGet(
  input: SchemaGetInput,
  dependencies: SchemaGetDependencies,
): Promise<SchemaGetOutput> {
  const sourceDescriptor = dependencies.getSourceDescriptor();
  const connectors = await dependencies.listConnectorItems();
  const bearer = projectBearer(input.actor);

  const stream_count = connectors.reduce(
    (sum, item) => sum + item.stream_count,
    0,
  );

  return {
    response: {
      object: "schema",
      bearer,
      connectors,
    },
    sourceDescriptor,
    queryData: { query_shape: "schema" },
    counts: {
      connector_count: connectors.length,
      stream_count,
    },
  };
}
