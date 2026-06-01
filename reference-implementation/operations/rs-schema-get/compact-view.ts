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
 *     (e.g. `type=string,granted=true,exact,range=gte|lt,agg=count_distinct`),
 *   - expandable relation summaries,
 *   - the envelope shape (`object: "schema"`, `bearer`, `connectors[]`).
 *
 * It DROPS the dominant size drivers: the raw per-stream/per-field JSON Schema
 * blobs and the five verbose capability sub-objects per field. Full detail
 * stays opt-in via the default (omitted) view; no existing client loses fields
 * by default.
 *
 * The capability-flag vocabulary mirrors the MCP server's compact `schema`
 * projection (`packages/mcp-server/src/tools.js`) so the two surfaces speak the
 * same terse flag language to agents. This module is the REST-side, typed port
 * of that vocabulary; it consumes the RS operation's flat envelope
 * (`{ object, bearer, connectors }`) rather than the `{ data: ... }`-wrapped
 * body the package MCP client sees.
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

// Stream-metadata keys preserved verbatim in the compact projection. Identity,
// addressing, and connection fields pass through; the heavy `schema`,
// `views`, `relationships`, and `query` blobs are intentionally absent.
const STREAM_PASSTHROUGH_KEYS = [
  "object",
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
  "granted_connections",
  "freshness",
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
    flags.push(operators ? `range=${inlineValue(operators)}` : "range");
  } else if (cap.declared === true && cap.usable === false) {
    flags.push(`range=unusable${reasonSuffix(cap.reason)}`);
  }
}

function addAggregationCapabilityFlags(flags: string[], aggregation: unknown): void {
  if (!isObject(aggregation)) return;
  const usable = Object.entries(aggregation)
    .filter(([, capability]) => isObject(capability) && (capability as CapabilityFlag).usable === true)
    .map(([name]) => name);
  if (usable.length > 0) {
    flags.push(`agg=${inlineValue(usable.join("|"))}`);
  }
}

/**
 * Collapse a single field-capability object to a terse flag string carrying
 * the declared type, grant flag, and every usable capability an agent needs to
 * build filter / sort / expand / fields / count / aggregate arguments.
 */
export function formatFieldCapabilityFlags(capabilities: unknown): string {
  if (!isObject(capabilities)) return "declared";
  const cap = capabilities as FieldCapability;
  const flags: string[] = [];
  const type = firstString(typeof cap.type === "string" ? cap.type : undefined, schemaTypeOf(cap.schema));
  if (type) flags.push(`type=${inlineValue(type)}`);
  if (typeof cap.granted === "boolean") {
    flags.push(`granted=${cap.granted}`);
  }
  addCapabilityFlag(flags, "exact", cap.exact_filter);
  addRangeCapabilityFlag(flags, cap.range_filter);
  addCapabilityFlag(flags, "lexical", cap.lexical_search);
  addCapabilityFlag(flags, "semantic", cap.semantic_search);
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

function compactStream(entry: unknown): unknown {
  if (!isObject(entry)) return entry;
  const out: Record<string, unknown> = {};
  for (const key of STREAM_PASSTHROUGH_KEYS) {
    if (entry[key] !== undefined) out[key] = entry[key];
  }
  if (entry.field_capabilities !== undefined) {
    out.field_capabilities = compactFieldCapabilities(entry.field_capabilities);
  }
  if (entry.expand_capabilities !== undefined) {
    out.expand_capabilities = compactExpandCapabilities(entry.expand_capabilities);
  }
  return out;
}

function compactConnector(connector: ConnectorSchemaItem): ConnectorSchemaItem {
  const streams = Array.isArray(connector.streams) ? connector.streams : [];
  return {
    ...connector,
    streams: streams.map((stream) => compactStream(stream)) as ConnectorSchemaItem["streams"],
  };
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
 * connector grouping, stream identity, per-connection `granted_connections`,
 * field names, declared types, and terse capability flags all survive. A
 * top-level `detail: "compact"` marker is added so callers can detect the
 * projection without diffing. When `stream` is supplied the document is first
 * scoped to that stream (the cheap `schema(stream)` discovery middle step).
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
