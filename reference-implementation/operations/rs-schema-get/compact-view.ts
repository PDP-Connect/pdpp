/**
 * Compact projection for the `rs.schema.get` response envelope.
 *
 * The default `GET /v1/schema` body carries, for every field of every stream of
 * every connector under the grant, both the full per-field JSON Schema and the
 * verbose `{declared, usable}` capability sub-objects. Live agent clients
 * observed package-level schema responses around 2 MB — too large as the
 * default agent-facing discovery payload, and it defeats the intended
 * `list_streams -> schema(stream) -> query_records` path.
 *
 * `GET /v1/schema?view=compact` returns a materially smaller projection that
 * preserves the identity an agent needs to keep moving:
 *   - stream identity (`name`) and per-connection identity
 *     (`granted_connections[].{connection_id, display_name}`),
 *   - field names + declared types,
 *   - a single terse, agent-usable capability flag string per field
 *     (e.g. `t=string,eq,r=gte|lt,a=count_distinct`),
 *   - expandable relation summaries,
 *   - the envelope shape (`object: "schema"`, `bearer`, `connectors[]`).
 *
 * It DROPS the dominant size drivers: the raw per-stream/per-field JSON Schema
 * blobs and the five verbose capability sub-objects per field. Full detail
 * stays opt-in via the default (omitted) view; no existing client loses fields
 * by default.
 *
 * The capability-flag vocabulary is deliberately abbreviated on the compact
 * REST path: `t` (declared type), `g=false` (only when a field is not granted),
 * `eq`, `r`, `lex`, `sem`, and `a`. This keeps the projection small enough for
 * real owner grants while preserving every capability bit an agent needs.
 *
 * Boundary rules (same as `rs-schema-get/index.ts`): this module is pure — it
 * SHALL NOT import Fastify, Next, SQLite, Postgres, a raw SQL handle, a generic
 * repository, or `process.env`.
 */

import type { ConnectorSchemaItem } from "./index.ts";

type Json = unknown;

interface CapabilityFlag {
  readonly declared?: unknown;
  readonly usable?: unknown;
  readonly operators?: unknown;
  readonly reason?: unknown;
  readonly [key: string]: unknown;
}

interface FieldCapability {
  readonly type?: unknown;
  readonly granted?: unknown;
  readonly schema?: unknown;
  readonly exact_filter?: unknown;
  readonly range_filter?: unknown;
  readonly lexical_search?: unknown;
  readonly semantic_search?: unknown;
  readonly aggregation?: unknown;
  readonly [key: string]: unknown;
}

interface SchemaResponse {
  object: "schema";
  bearer: unknown;
  connectors: ConnectorSchemaItem[];
  [extra: string]: unknown;
}

// Stream-metadata keys preserved verbatim in the compact projection. Identity
// and addressing fields pass through; the heavy `schema`, `views`,
// `relationships`, `query`, per-stream `object` marker, and freshness telemetry
// are intentionally absent. Freshness is available from list/health surfaces;
// schema(stream) is the token-efficient field/capability discovery step.
//
// `granted_connections` is intentionally NOT in this list: it is handled
// separately by the connector-level dedup below. The native RS attaches the
// SAME `granted_connections` array to every stream of a connector (it is
// computed once per connector and only narrowed when a per-stream grant pins a
// connection). Passing it through verbatim per stream multiplied the
// connection list by the stream count — the dominant driver of the live
// owner-grant budget miss (a 19-connection grant repeated its ~2 KB connection
// list on every stream). The lift keeps the identity an agent needs while
// paying for it once per connector.
const STREAM_PASSTHROUGH_KEYS = [
  "name",
  "connector_key",
  "connector_id",
  "connector_display_name",
  "display_name",
  "connection_display_name",
  "connection_id",
  "connector_instance_id",
  "record_count",
  "granted",
  "primary_key",
  "cursor_field",
  "source",
] as const;

// Expand-capability keys preserved verbatim per relation.
const EXPAND_PASSTHROUGH_KEYS = [
  "name",
  "relation",
  "stream",
  "target_stream",
  "cardinality",
  "granted",
  "usable",
  "foreign_key",
  "max_limit",
  "default_limit",
  "reason",
] as const;

function isObject(value: Json): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

// Render a value so the flag string stays single-token: strip separators that
// would break `key=value,key2` parsing.
function inlineValue(value: unknown): string {
  if (value === undefined || value === null) return "null";
  return String(value)
    .replace(/[;,[\]{}=]/g, "_")
    .replace(/\s+/g, "_");
}

function schemaTypeOf(schema: unknown): string | undefined {
  if (!isObject(schema)) return undefined;
  if (typeof schema.type === "string") return schema.type;
  if (Array.isArray(schema.type)) {
    const joined = schema.type.filter((item) => typeof item === "string").join("|");
    return joined.length > 0 ? joined : undefined;
  }
  return undefined;
}

function reasonSuffix(reason: unknown): string {
  return typeof reason === "string" && reason.length > 0 ? `:${reason}` : "";
}

function addCapabilityFlag(flags: string[], name: string, capability: unknown): void {
  if (!isObject(capability)) return;
  const cap = capability as CapabilityFlag;
  if (cap.usable === true) {
    flags.push(name);
  } else if (cap.declared === true && cap.usable === false) {
    flags.push(`${name}=unusable${reasonSuffix(cap.reason)}`);
  }
}

function addRangeCapabilityFlag(flags: string[], capability: unknown): void {
  if (!isObject(capability)) return;
  const cap = capability as CapabilityFlag;
  const operators =
    Array.isArray(cap.operators) && cap.operators.length > 0 ? cap.operators.join("|") : null;
  if (cap.usable === true) {
    flags.push(operators ? `r=${inlineValue(operators)}` : "r");
  } else if (cap.declared === true && cap.usable === false) {
    flags.push(`r=unusable${reasonSuffix(cap.reason)}`);
  }
}

function addAggregationCapabilityFlags(flags: string[], aggregation: unknown): void {
  if (!isObject(aggregation)) return;
  const usable = Object.entries(aggregation)
    .filter(([, capability]) => isObject(capability) && (capability as CapabilityFlag).usable === true)
    .map(([name]) => name);
  if (usable.length > 0) {
    flags.push(`a=${inlineValue(usable.join("|"))}`);
  }
}

/**
 * Collapse a single field-capability object to a terse flag string carrying
 * the declared type, non-default grant flag, and every usable capability an
 * agent needs to build filter / sort / expand / fields / count / aggregate
 * arguments. `granted=true` is the common case on owner-agent schema output, so
 * it is omitted; `g=false` is emitted only when the field is not granted.
 */
export function formatFieldCapabilityFlags(capabilities: unknown): string {
  if (!isObject(capabilities)) return "declared";
  const cap = capabilities as FieldCapability;
  const flags: string[] = [];
  const type = firstString(typeof cap.type === "string" ? cap.type : undefined, schemaTypeOf(cap.schema));
  if (type) flags.push(`t=${inlineValue(type)}`);
  if (cap.granted === false) {
    flags.push("g=false");
  }
  addCapabilityFlag(flags, "eq", cap.exact_filter);
  addRangeCapabilityFlag(flags, cap.range_filter);
  addCapabilityFlag(flags, "lex", cap.lexical_search);
  addCapabilityFlag(flags, "sem", cap.semantic_search);
  addAggregationCapabilityFlags(flags, cap.aggregation);
  return flags.length > 0 ? flags.join(",") : "declared";
}

function compactFieldCapabilities(fieldCapabilities: unknown): unknown {
  if (Array.isArray(fieldCapabilities)) {
    return fieldCapabilities.map((entry) => {
      if (!isObject(entry)) return entry;
      const name = firstString(entry.name as string, entry.field as string);
      return { name, flags: formatFieldCapabilityFlags(entry) };
    });
  }
  if (!isObject(fieldCapabilities)) return fieldCapabilities;
  const out: Record<string, string> = {};
  for (const [name, capability] of Object.entries(fieldCapabilities)) {
    out[name] = formatFieldCapabilityFlags(capability);
  }
  return out;
}

function compactExpandCapabilities(expandCapabilities: unknown): unknown {
  if (!Array.isArray(expandCapabilities)) return expandCapabilities;
  return expandCapabilities.map((relation) => {
    if (!isObject(relation)) return relation;
    const out: Record<string, unknown> = {};
    for (const key of EXPAND_PASSTHROUGH_KEYS) {
      if (relation[key] !== undefined) out[key] = relation[key];
    }
    return Object.keys(out).length > 0 ? out : relation;
  });
}

/**
 * Stable comparison key for a `granted_connections` array, used only to decide
 * whether a stream's connection set equals the connector-level shared set.
 * Order-insensitive (sorted by connection_id) so two streams that list the same
 * connections in a different order still dedup; the original array is preserved
 * verbatim wherever it is actually emitted.
 */
function grantedConnectionsKey(value: unknown): string {
  if (!Array.isArray(value)) return "";
  const entries = value.map((entry) => {
    if (!isObject(entry)) return JSON.stringify(entry);
    const id = typeof entry.connection_id === "string" ? entry.connection_id : "";
    const label = typeof entry.display_name === "string" ? entry.display_name : "";
    const alias = typeof entry.connector_instance_id === "string" ? entry.connector_instance_id : "";
    return JSON.stringify([id, label, alias]);
  });
  entries.sort();
  return entries.join("\n");
}

/**
 * Pick the connection set to lift to the connector level: the most frequent
 * non-empty `granted_connections` array across the connector's streams. Most
 * connectors attach one identical set to every stream, so the mode is that set;
 * choosing the mode also minimizes the per-stream overrides that must remain
 * when a few streams pin a different connection subset.
 */
function pickSharedGrantedConnections(streams: unknown[]): {
  shared: unknown[] | null;
  sharedKey: string;
} {
  const byKey = new Map<string, { value: unknown[]; count: number }>();
  for (const stream of streams) {
    if (!isObject(stream) || !Array.isArray(stream.granted_connections)) continue;
    if (stream.granted_connections.length === 0) continue;
    const key = grantedConnectionsKey(stream.granted_connections);
    const existing = byKey.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      byKey.set(key, { value: stream.granted_connections, count: 1 });
    }
  }
  let bestKey = "";
  let best: { value: unknown[]; count: number } | null = null;
  for (const [key, candidate] of byKey) {
    if (!best || candidate.count > best.count) {
      best = candidate;
      bestKey = key;
    }
  }
  return { shared: best ? best.value : null, sharedKey: best ? bestKey : "" };
}

function compactStream(entry: unknown, hasShared: boolean, sharedKey: string): unknown {
  if (!isObject(entry)) return entry;
  const out: Record<string, unknown> = {};
  for (const key of STREAM_PASSTHROUGH_KEYS) {
    if (entry[key] !== undefined) out[key] = entry[key];
  }
  // Keep `granted_connections` per stream ONLY when it diverges from the
  // connector-level shared set (a per-stream grant that pins a connection
  // subset, or a stream the connector-level set does not cover). Streams that
  // carry the shared set drop it and inherit the connector-level array; agents
  // read connector-level by default and per-stream when present.
  //
  // When no connector-level set was lifted (`hasShared` false), every stream's
  // `granted_connections` is preserved verbatim — including an empty array,
  // which is meaningful (a granted stream with no active connection) and must
  // not be silently dropped.
  if (entry.granted_connections !== undefined) {
    const streamKey = Array.isArray(entry.granted_connections)
      ? grantedConnectionsKey(entry.granted_connections)
      : null;
    if (!hasShared || streamKey === null || streamKey !== sharedKey) {
      out.granted_connections = entry.granted_connections;
    }
  }
  if (entry.field_capabilities !== undefined) {
    out.field_capabilities = compactFieldCapabilities(entry.field_capabilities);
  }
  if (entry.expand_capabilities !== undefined) {
    out.expand_capabilities = compactExpandCapabilities(entry.expand_capabilities);
  }
  return out;
}

/**
 * Compact a connector item, lifting the connection set shared by its streams to
 * `connector.granted_connections` so the (often large) list is paid for once
 * per connector instead of once per stream. Streams whose set matches the lift
 * drop their copy; divergent streams keep theirs. When no stream carries a
 * connection set (e.g. provider_native), nothing is lifted and streams are
 * unchanged on that axis.
 */
function compactConnector(connector: ConnectorSchemaItem): ConnectorSchemaItem {
  const streams = Array.isArray(connector.streams) ? connector.streams : [];
  const { shared, sharedKey } = pickSharedGrantedConnections(streams);
  const hasShared = shared !== null;
  const out: ConnectorSchemaItem = {
    ...connector,
    streams: streams.map((stream) => compactStream(stream, hasShared, sharedKey)) as ConnectorSchemaItem["streams"],
  };
  if (shared) {
    out.granted_connections = shared;
  }
  return out;
}

function streamNameOf(entry: unknown): string | undefined {
  if (!isObject(entry)) return undefined;
  return firstString(entry.name as string, entry.stream as string, entry.stream_name as string);
}

/**
 * Narrow a list of connector items to a single stream, dropping connectors
 * that contribute no matching stream. Preserves the connector envelope and
 * recomputes `stream_count` so the projection stays internally consistent.
 */
function scopeConnectorsToStream(
  connectors: ConnectorSchemaItem[],
  streamTarget: string,
): ConnectorSchemaItem[] {
  return connectors
    .map((connector) => {
      const streams = Array.isArray(connector.streams) ? connector.streams : [];
      const matching = streams.filter((entry) => streamNameOf(entry) === streamTarget);
      if (matching.length === 0) return null;
      return { ...connector, streams: matching, stream_count: matching.length };
    })
    .filter((item): item is ConnectorSchemaItem => item !== null);
}

export interface CompactSchemaOptions {
  /** When set, scope the document to a single stream before compaction. */
  stream?: string | null;
}

/**
 * Project the canonical `rs.schema.get` response into its compact view.
 *
 * Additive and identity-preserving: the envelope shape, bearer block,
 * connector grouping, stream identity, per-connection connection identity,
 * field names, declared types, and terse capability flags all survive. A
 * top-level `detail: "compact"` marker is added so callers can detect the
 * projection without diffing. When `stream` is supplied the document is first
 * scoped to that stream (the cheap `schema(stream)` discovery middle step).
 *
 * `granted_connections` is de-duplicated to the connector level: the set shared
 * by a connector's streams is emitted once as `connector.granted_connections`,
 * and per-stream copies survive only where a stream's set diverges (a grant
 * that pins a connection subset for that stream). This is what keeps a
 * many-connection grant under budget — the connection list scales with the
 * connector's connection count, not connection count times stream count. An
 * agent resolving a `connection_id` reads the connector-level set by default
 * and the per-stream override when one is present.
 */
export function projectSchemaCompactView(
  response: SchemaResponse,
  { stream = null }: CompactSchemaOptions = {},
): SchemaResponse {
  const connectors = Array.isArray(response.connectors) ? response.connectors : [];
  const scoped = stream ? scopeConnectorsToStream(connectors, stream) : connectors;
  return {
    ...response,
    detail: "compact",
    connectors: scoped.map((connector) => compactConnector(connector)),
  };
}
