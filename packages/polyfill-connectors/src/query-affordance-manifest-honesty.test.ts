import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { QUERY_AFFORDANCE_ALLOWLIST } from "./query-affordance-allowlist.ts";

interface JsonSchema {
  enum?: unknown[];
  format?: string;
  type?: string | string[];
  x_pdpp_role?: string;
}

interface ManifestStream {
  cursor_field?: string;
  name?: string;
  query?: {
    search?: {
      lexical_fields?: string[];
      semantic_fields?: string[];
    };
    range_filters?: Record<string, unknown>;
    aggregations?: {
      count?: unknown;
      group_by?: string[];
      group_by_time?: string[];
    };
  };
  schema?: {
    properties?: Record<string, JsonSchema>;
  };
}

interface ConnectorManifest {
  connector_key?: string;
  streams?: ManifestStream[];
}

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MANIFESTS_DIR = join(PACKAGE_ROOT, "manifests");

/**
 * Field-name fragments that mark a timestamp as an ingest / sync / telemetry
 * marker rather than an owner-facing query axis. These are NOT required to
 * declare query affordances even when they are date/date-time strings: an
 * owner filtering "my data" wants to filter by when the record happened, not by
 * when the collector last fetched it.
 */
const INGEST_TIME_FIELD = /^(fetched_at|ingested_at|collected_at|synced_at|observed_at|retrieved_at)$/;

/**
 * Field names that read as a secondary/closing bound of a primary interval
 * (the primary `start_*` is the required axis; the matching `end_*` is
 * optional). Declaring range on these is allowed but not required.
 */
const SECONDARY_INTERVAL_FIELD = /^(end_date|end_time|finished_at|ended_at)$/;

/**
 * Field names that read as a secondary state-change marker (the record moved to
 * a new state) rather than the record's primary event time. These remain useful
 * as range filters, but charting count-over-time by them is rarely the owner's
 * intent — the record's creation/start time is the event axis. They are not
 * REQUIRED to declare group_by_time (a connector may still add it).
 */
const SECONDARY_STATE_TIME_FIELD =
  /^(updated_at|update_time|last_edited_time|closed_at|merged_at|completed_at|last_read|last_read_at|last_reconciled_at|last_message_date|pushed_at|modified_at)$/;

/**
 * Field-name signals that a date field is the record's primary EVENT axis, the
 * natural target for count-over-time charts. Used in addition to an explicit
 * `x_pdpp_role: event-time` declaration.
 */
const EVENT_TIME_FIELD =
  /^(created_at|created_utc|create_time|created_time|start|start_date|start_time|started_at|taken_at|sent_at|date|order_date|day|time_added|played_at|watched_at|first_message_date|posted_date|occurred_at|published_at)$/;

function manifestFiles(): string[] {
  return readdirSync(MANIFESTS_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort();
}

function readManifest(file: string): ConnectorManifest {
  return JSON.parse(readFileSync(join(MANIFESTS_DIR, file), "utf8")) as ConnectorManifest;
}

function nonNullTypes(schema: JsonSchema | undefined): string[] {
  const raw = schema?.type;
  if (raw == null) {
    return [];
  }
  const list = Array.isArray(raw) ? raw : [raw];
  return list.filter((t): t is string => typeof t === "string" && t !== "null");
}

/** A schema-supported group_by_time / range time field: a date|date-time string. */
function isDateStringSchema(schema: JsonSchema | undefined): boolean {
  const types = nonNullTypes(schema);
  return types.length === 1 && types[0] === "string" && (schema?.format === "date" || schema?.format === "date-time");
}

function isIntegerOrNumberSchema(schema: JsonSchema | undefined): boolean {
  const types = nonNullTypes(schema);
  return types.length === 1 && (types[0] === "integer" || types[0] === "number");
}

/** Range filters accept numeric or date/date-time string fields (records.js coerce path). */
function isRangeableSchema(schema: JsonSchema | undefined): boolean {
  return isIntegerOrNumberSchema(schema) || isDateStringSchema(schema);
}

function isScalarSchema(schema: JsonSchema | undefined): boolean {
  const types = nonNullTypes(schema);
  if (types.length !== 1) {
    return false;
  }
  const [only] = types;
  return only !== undefined && ["boolean", "integer", "number", "string"].includes(only);
}

function allowKey(connector: string, stream: string, field: string, affordance: string): string {
  return `${connector}.${stream}.${field}.${affordance}`;
}

function isAllowlisted(connector: string, stream: string, field: string, affordance: string): boolean {
  return Object.hasOwn(QUERY_AFFORDANCE_ALLOWLIST, allowKey(connector, stream, field, affordance));
}

/**
 * A useful, owner-facing time field that should be range-filterable. Excludes
 * ingest/sync markers and the stream's own sync cursor — those are real
 * timestamps but not the axis an owner filters on. Secondary interval closings
 * and state-change markers are still range-useful, so they remain in scope here
 * (a connector declares range or allowlists it).
 */
function isRangeRequiredTimeField(field: string, schema: JsonSchema, stream: ManifestStream): boolean {
  if (!isDateStringSchema(schema)) {
    return false;
  }
  if (INGEST_TIME_FIELD.test(field)) {
    return false;
  }
  if (stream.cursor_field === field) {
    return false;
  }
  return true;
}

/**
 * A field that is the record's primary EVENT axis and should therefore support
 * count-over-time bucketing. True when the manifest declares
 * `x_pdpp_role: event-time` or the field name is an unambiguous event/creation
 * time. Secondary state-change markers (updated_at, closed_at, …) and interval
 * closings are deliberately excluded: charting by them is rarely the intent.
 */
function isGroupByTimeRequiredField(field: string, schema: JsonSchema, stream: ManifestStream): boolean {
  if (!isDateStringSchema(schema)) {
    return false;
  }
  if (INGEST_TIME_FIELD.test(field)) {
    return false;
  }
  if (SECONDARY_INTERVAL_FIELD.test(field)) {
    return false;
  }
  if (SECONDARY_STATE_TIME_FIELD.test(field)) {
    return false;
  }
  if (stream.cursor_field === field) {
    return false;
  }
  const isEventRole = schema.x_pdpp_role === "event-time";
  return isEventRole || EVENT_TIME_FIELD.test(field);
}

test("connector manifests declare range filters for useful owner-facing time fields", () => {
  const violations: string[] = [];

  for (const file of manifestFiles()) {
    const manifest = readManifest(file);
    const connectorKey = manifest.connector_key ?? file.replace(/\.json$/, "");

    for (const stream of manifest.streams ?? []) {
      const streamName = stream.name ?? "<unnamed>";
      const properties = stream.schema?.properties ?? {};
      const rangeFields = new Set(Object.keys(stream.query?.range_filters ?? {}));

      for (const [field, schema] of Object.entries(properties)) {
        if (!isRangeRequiredTimeField(field, schema, stream)) {
          continue;
        }
        if (rangeFields.has(field)) {
          continue;
        }
        if (isAllowlisted(connectorKey, streamName, field, "range")) {
          continue;
        }
        violations.push(
          `${connectorKey}.${streamName}.${field}: useful time field missing query.range_filters (declare it or allowlist range)`
        );
      }
    }
  }

  assert.deepEqual(violations, []);
});

test("connector manifests declare group_by_time for useful owner-facing time fields", () => {
  const violations: string[] = [];

  for (const file of manifestFiles()) {
    const manifest = readManifest(file);
    const connectorKey = manifest.connector_key ?? file.replace(/\.json$/, "");

    for (const stream of manifest.streams ?? []) {
      const streamName = stream.name ?? "<unnamed>";
      const properties = stream.schema?.properties ?? {};
      const groupByTime = new Set(stream.query?.aggregations?.group_by_time ?? []);

      for (const [field, schema] of Object.entries(properties)) {
        if (!isGroupByTimeRequiredField(field, schema, stream)) {
          continue;
        }
        if (groupByTime.has(field)) {
          continue;
        }
        if (isAllowlisted(connectorKey, streamName, field, "group_by_time")) {
          continue;
        }
        violations.push(
          `${connectorKey}.${streamName}.${field}: event-time field missing query.aggregations.group_by_time (declare it or allowlist group_by_time)`
        );
      }
    }
  }

  assert.deepEqual(violations, []);
});

test("group_by_time declarations target only server-supported date/date-time string fields", () => {
  // Mirrors the server contract in reference-implementation/server/records.js:
  // group_by_time requires a string field with format date|date-time. Integer
  // epochs and bare strings are rejected at request time, so a manifest must
  // never declare them.
  const violations: string[] = [];

  for (const file of manifestFiles()) {
    const manifest = readManifest(file);
    const connectorKey = manifest.connector_key ?? file.replace(/\.json$/, "");

    for (const stream of manifest.streams ?? []) {
      const streamName = stream.name ?? "<unnamed>";
      const properties = stream.schema?.properties ?? {};
      const aggregations = stream.query?.aggregations;
      const groupByTime = aggregations?.group_by_time ?? [];

      // group_by / group_by_time run as metric=count and require count:true.
      if ((groupByTime.length > 0 || (aggregations?.group_by ?? []).length > 0) && aggregations?.count !== true) {
        violations.push(`${connectorKey}.${streamName}: declares grouping without aggregations.count: true`);
      }

      for (const field of groupByTime) {
        const schema = properties[field];
        if (!schema) {
          violations.push(
            `${connectorKey}.${streamName}.${field}: group_by_time targets a field absent from schema.properties`
          );
          continue;
        }
        if (!isDateStringSchema(schema)) {
          violations.push(
            `${connectorKey}.${streamName}.${field}: group_by_time requires a date/date-time string field; server aggregation rejects this schema`
          );
        }
      }
    }
  }

  assert.deepEqual(violations, []);
});

test("range_filters and group_by declarations target schema-supported fields", () => {
  const violations: string[] = [];

  for (const file of manifestFiles()) {
    const manifest = readManifest(file);
    const connectorKey = manifest.connector_key ?? file.replace(/\.json$/, "");

    for (const stream of manifest.streams ?? []) {
      const streamName = stream.name ?? "<unnamed>";
      const properties = stream.schema?.properties ?? {};

      for (const field of Object.keys(stream.query?.range_filters ?? {})) {
        const schema = properties[field];
        if (!schema) {
          violations.push(`${connectorKey}.${streamName}.${field}: range_filters targets an absent field`);
          continue;
        }
        if (!isRangeableSchema(schema)) {
          violations.push(
            `${connectorKey}.${streamName}.${field}: range_filters requires a numeric or date/date-time field`
          );
        }
      }

      for (const field of stream.query?.aggregations?.group_by ?? []) {
        const schema = properties[field];
        if (!schema) {
          violations.push(`${connectorKey}.${streamName}.${field}: group_by targets an absent field`);
          continue;
        }
        if (!isScalarSchema(schema)) {
          violations.push(`${connectorKey}.${streamName}.${field}: group_by requires a scalar field`);
        }
      }
    }
  }

  assert.deepEqual(violations, []);
});

test("query affordance allowlist entries are non-stale and not contradicted by manifests", () => {
  // Both-directions check: every allowlist entry must point at a real field whose
  // affordance is genuinely NOT declared. An entry that is also declared, or whose
  // stream/field no longer exists, is stale and must be removed.
  const stale: string[] = [];

  const streamIndex = new Map<string, ManifestStream>();
  for (const file of manifestFiles()) {
    const manifest = readManifest(file);
    const connectorKey = manifest.connector_key ?? file.replace(/\.json$/, "");
    for (const stream of manifest.streams ?? []) {
      streamIndex.set(`${connectorKey}.${stream.name ?? "<unnamed>"}`, stream);
    }
  }

  for (const [entryKey, reason] of Object.entries(QUERY_AFFORDANCE_ALLOWLIST)) {
    assert.ok(reason.length > 0, `${entryKey}: allowlist entries require a justification reason`);

    const parts = entryKey.split(".");
    const affordance = parts.pop();
    const field = parts.pop();
    const streamKey = parts.join(".");
    if (!(affordance && field)) {
      stale.push(`${entryKey}: malformed allowlist key (expected connector.stream.field.affordance)`);
      continue;
    }
    const stream = streamIndex.get(streamKey);
    if (!stream) {
      stale.push(`${entryKey}: stream not found`);
      continue;
    }
    const schema = stream.schema?.properties?.[field];
    if (!schema) {
      stale.push(`${entryKey}: field not found in schema`);
      continue;
    }
    let declared: boolean;
    switch (affordance) {
      case "range":
        declared = Object.hasOwn(stream.query?.range_filters ?? {}, field);
        break;
      case "group_by_time":
        declared = (stream.query?.aggregations?.group_by_time ?? []).includes(field);
        break;
      case "group_by":
        declared = (stream.query?.aggregations?.group_by ?? []).includes(field);
        break;
      case "lexical":
        declared = (stream.query?.search?.lexical_fields ?? []).includes(field);
        break;
      case "semantic":
        declared = (stream.query?.search?.semantic_fields ?? []).includes(field);
        break;
      default:
        stale.push(`${entryKey}: unknown affordance '${affordance}'`);
        continue;
    }
    if (declared) {
      stale.push(`${entryKey}: affordance is declared in the manifest; remove the allowlist entry`);
    }
  }

  assert.deepEqual(stale, []);
});
