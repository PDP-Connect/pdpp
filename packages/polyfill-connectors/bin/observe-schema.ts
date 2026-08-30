#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * observe-schema — compare a connector's DECLARED manifest stream schemas
 * against what its RECORDS actually look like.
 *
 * The scenario format (`src/scenario/format.ts`, `pdpp.connector-scenario/1`)
 * does not store emitted record data — `expected.records` is only
 * `{count, ids, record_sha256s}`, a verification digest, not a corpus you
 * can observe field shapes from. So this tool's input is raw record data
 * directly: JSONL files under a fixture's `records/<stream>.jsonl` (the
 * `fixtures/<connector>/scrubbed/pilot-real-shape/records/` layout, or any
 * other capture directory with the same `records/<stream>.jsonl` shape) —
 * one JSON object per line, no envelope.
 *
 * For each stream declared in `manifests/<connector>.json`, this loads the
 * matching `records/<stream>.jsonl` file(s), walks every observed record
 * (recursing into nested objects and array elements), and reports:
 *   - a per-field table: dot-path, observed type(s), presence % of samples
 *   - divergences from the declared JSON Schema: fields observed but not
 *     declared, fields declared but never observed, observed types the
 *     schema doesn't admit (including null where not nullable), and enum
 *     values observed outside a declared `enum`.
 *
 * This is a read-only, informational tool: it always exits 0. Use the
 * final `divergences: N` line (or grep the DIVERGENCES sections) to decide
 * whether to act on the output.
 *
 * Usage:
 *   pnpm exec tsx bin/observe-schema.ts <connector> [--records <dir-or-file>...]
 *
 * Examples:
 *   pnpm exec tsx bin/observe-schema.ts jellyfin
 *   pnpm exec tsx bin/observe-schema.ts jellyfin --records fixtures/jellyfin/scrubbed/pilot-real-shape/records
 *   pnpm exec tsx bin/observe-schema.ts jellyfin --records runs/jellyfin/2026-08-01/records/items.jsonl
 *
 * `--records` may be repeated and may point at a directory (every
 * `<stream>.jsonl` file inside it is loaded for that stream, matched by
 * filename stem) or a single `.jsonl` file (matched to the stream whose
 * name equals the file's stem). When omitted, defaults to the connector's
 * own pilot fixture dir: `fixtures/<connector>/scrubbed/pilot-real-shape/records`.
 *
 * `--manifest <path>` is a dev/test-only override that reads the stream
 * schemas from the given file instead of `manifests/<connector>.json` —
 * mirrors `connector-dev.ts`'s `--entrypoint` override. It exists so the
 * integration test (bin/observe-schema.test.ts) can drive this CLI
 * end-to-end against a throwaway temp manifest crafted to exercise every
 * divergence class, without writing into the real manifests/ directory.
 *
 * Sample cap: at most 10,000 records per stream are read (an informational
 * report, not an exhaustive audit — bounded so a huge capture stays fast).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(__dirname, "..");
const MANIFEST_DIR = join(PACKAGE_ROOT, "manifests");

const SAMPLE_CAP = 10_000;
const JSONL_EXTENSION_RE = /\.jsonl$/;

// ─── Manifest / JSON Schema types ───────────────────────────────────────

interface JsonSchema {
  enum?: unknown[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  type?: string | string[];
  [extra: string]: unknown;
}

interface ManifestStream {
  name: string;
  schema?: JsonSchema;
  [extra: string]: unknown;
}

interface Manifest {
  connector_key?: string;
  streams?: ManifestStream[];
  [extra: string]: unknown;
}

// ─── CLI args ────────────────────────────────────────────────────────────

export interface CliArgs {
  connector: string;
  /**
   * Dev/test-only override for the manifest file path, bypassing the
   * `manifests/<connector>.json` registry lookup — same shape as
   * `connector-dev.ts`'s `--entrypoint` override. Lets the integration
   * test exercise every divergence class against a throwaway temp
   * manifest without touching the real `manifests/` directory.
   */
  manifestPath?: string;
  recordSources: string[];
}

function usageAndExit(code: number): never {
  process.stderr.write("Usage: observe-schema <connector> [--records <dir-or-file>...] [--manifest <path>]\n");
  process.exit(code);
}

export function parseArgs(argv: readonly string[]): CliArgs {
  let connector: string | undefined;
  let manifestPath: string | undefined;
  const recordSources: string[] = [];
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    i += 1;
    if (arg === "--records") {
      const value = argv[i];
      i += 1;
      if (!value) {
        usageAndExit(2);
      }
      recordSources.push(value);
      continue;
    }
    if (arg === "--manifest") {
      const value = argv[i];
      i += 1;
      if (!value) {
        usageAndExit(2);
      }
      manifestPath = value;
      continue;
    }
    if (arg && !arg.startsWith("--") && !connector) {
      connector = arg;
      continue;
    }
    usageAndExit(2);
  }
  if (!connector) {
    usageAndExit(2);
  }
  return { connector, recordSources, ...(manifestPath ? { manifestPath } : {}) };
}

// ─── Manifest loading ────────────────────────────────────────────────────

export function readManifest(connector: string, manifestPathOverride?: string): Manifest {
  const manifestPath = manifestPathOverride ?? join(MANIFEST_DIR, `${connector}.json`);
  if (!existsSync(manifestPath)) {
    throw new Error(`no manifest found for connector "${connector}" (expected ${manifestPath})`);
  }
  return JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
}

export function defaultRecordsDir(connector: string): string {
  return join(PACKAGE_ROOT, "fixtures", connector, "scrubbed", "pilot-real-shape", "records");
}

// ─── Record loading ──────────────────────────────────────────────────────

/** stream name -> JSONL file paths that supply records for it. */
export function resolveStreamFiles(streamNames: readonly string[], sources: readonly string[]): Map<string, string[]> {
  const byStream = new Map<string, string[]>();
  const addFile = (path: string): void => {
    const stem = basename(path).replace(JSONL_EXTENSION_RE, "");
    if (!streamNames.includes(stem)) {
      return;
    }
    const existing = byStream.get(stem) ?? [];
    existing.push(path);
    byStream.set(stem, existing);
  };

  for (const source of sources) {
    if (!existsSync(source)) {
      process.stderr.write(`[observe-schema] WARN: --records source not found: ${source}\n`);
      continue;
    }
    const stat = statSync(source);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(source)) {
        if (entry.endsWith(".jsonl")) {
          addFile(join(source, entry));
        }
      }
      continue;
    }
    addFile(source);
  }
  return byStream;
}

export function loadJsonlRecords(path: string, cap: number): unknown[] {
  const raw = readFileSync(path, "utf8");
  const records: unknown[] = [];
  for (const line of raw.split("\n")) {
    if (records.length >= cap) {
      break;
    }
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    records.push(JSON.parse(trimmed));
  }
  return records;
}

// ─── Observation ─────────────────────────────────────────────────────────

/** Runtime type name for a JSON value, matching JSON Schema's `type` vocabulary. */
export function jsonType(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? "integer" : "number";
  }
  if (typeof value === "boolean") {
    return "boolean";
  }
  if (typeof value === "string") {
    return "string";
  }
  if (typeof value === "object") {
    return "object";
  }
  return typeof value;
}

interface FieldObservation {
  count: number;
  enumViolations: Set<string>;
  types: Set<string>;
}

/**
 * Walk one record's value tree, accumulating per-dot-path observations.
 * Arrays report their element paths as `<path>[]`; the array field itself
 * is also recorded at `<path>` with type "array". Objects recurse into
 * `<path>.<key>`; the object field itself is recorded at `<path>` too.
 */
function observeValue(value: unknown, path: string, fields: Map<string, FieldObservation>): void {
  const observation = fields.get(path) ?? { count: 0, types: new Set(), enumViolations: new Set() };
  observation.count += 1;
  observation.types.add(jsonType(value));
  fields.set(path, observation);

  if (Array.isArray(value)) {
    for (const element of value) {
      observeValue(element, `${path}[]`, fields);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      observeValue(nested, path ? `${path}.${key}` : key, fields);
    }
  }
}

/** Observe every field path across a set of records. Top-level fields start with no prefix. */
export function observeRecords(records: readonly unknown[]): Map<string, FieldObservation> {
  const fields = new Map<string, FieldObservation>();
  for (const record of records) {
    if (record === null || typeof record !== "object" || Array.isArray(record)) {
      observeValue(record, "$root", fields);
      continue;
    }
    for (const [key, value] of Object.entries(record as Record<string, unknown>)) {
      observeValue(value, key, fields);
    }
  }
  return fields;
}

// ─── Schema walking (declared side) ─────────────────────────────────────

interface DeclaredField {
  enumValues?: unknown[];
  types: string[];
}

/** Flatten a JSON Schema into the same dot-path vocabulary `observeRecords` uses. */
export function declaredFields(schema: JsonSchema | undefined, path = ""): Map<string, DeclaredField> {
  const out = new Map<string, DeclaredField>();
  walkSchema(schema, path, out);
  return out;
}

function schemaTypes(schema: JsonSchema): string[] {
  const raw = schema.type;
  if (raw === undefined) {
    return [];
  }
  return Array.isArray(raw) ? raw : [raw];
}

function walkSchema(schema: JsonSchema | undefined, path: string, out: Map<string, DeclaredField>): void {
  if (!(schema && path)) {
    // Recurse into children even without registering the root ("") path itself.
    if (schema?.properties) {
      for (const [key, child] of Object.entries(schema.properties)) {
        walkSchema(child, key, out);
      }
    }
    return;
  }

  const types = schemaTypes(schema);
  out.set(path, { types, ...(schema.enum ? { enumValues: schema.enum } : {}) });

  if (schema.properties) {
    for (const [key, child] of Object.entries(schema.properties)) {
      walkSchema(child, `${path}.${key}`, out);
    }
  }
  if (schema.items) {
    walkSchema(schema.items, `${path}[]`, out);
  }
}

// ─── Divergence detection ────────────────────────────────────────────────

export interface Divergence {
  detail: string;
  kind: "undeclared-field" | "unobserved-field" | "type-mismatch" | "enum-violation" | "no-samples";
  path: string;
}

export function computeDivergences(
  observed: Map<string, FieldObservation>,
  declared: Map<string, DeclaredField>
): Divergence[] {
  const divergences: Divergence[] = [];
  const observedPaths = new Set(observed.keys());

  for (const [path, obs] of observed) {
    const decl = declared.get(path);
    if (!decl) {
      // Only flag as undeclared if some ancestor object path IS declared
      // with a `properties` schema (so this is a real "extra field"), or
      // there is no declared parent at all (top-level extra field). If an
      // ancestor is declared as an untyped/opaque object (no properties,
      // e.g. `provider_ids: {type: [object, null]}` with no properties
      // key), its children are legitimately undeclared-by-design — skip.
      if (hasOpaqueDeclaredAncestor(path, declared)) {
        continue;
      }
      divergences.push({
        kind: "undeclared-field",
        path,
        detail: `observed but not declared in schema (observed type(s): ${[...obs.types].sort().join(", ")})`,
      });
      continue;
    }

    const admitted = new Set(decl.types);
    // JSON Schema's `integer` is a SUBTYPE of `number` (every integer is a
    // number; the reverse isn't true) — a schema declaring `type: "number"`
    // legitimately admits an observed `integer` sample (e.g. a field whose
    // samples all happen to be whole numbers, like a heart rate or a
    // duration in whole milliseconds), not a divergence. This does NOT run
    // the other direction: a schema declaring only `type: "integer"` still
    // flags an observed `number` (non-integer) sample, since that really
    // would violate the declared constraint.
    const admitsIntegerAsNumber = admitted.has("number") && !admitted.has("integer");
    const nonAdmitted = [...obs.types].filter((t) => {
      if (admitted.size === 0) {
        return false;
      }
      if (admitted.has(t)) {
        return false;
      }
      if (t === "integer" && admitsIntegerAsNumber) {
        return false;
      }
      return true;
    });
    if (nonAdmitted.length > 0) {
      const nonAdmittedSorted = nonAdmitted.toSorted((a, b) => a.localeCompare(b));
      const admittedSorted = [...admitted].toSorted((a, b) => a.localeCompare(b));
      divergences.push({
        kind: "type-mismatch",
        path,
        detail: `observed type(s) [${nonAdmittedSorted.join(", ")}] not admitted by declared type(s) [${admittedSorted.join(", ")}]`,
      });
    }

    if (decl.enumValues) {
      for (const violation of obs.enumViolations) {
        divergences.push({
          kind: "enum-violation",
          path,
          detail: `observed value outside declared enum: ${violation}`,
        });
      }
    }
  }

  for (const [path] of declared) {
    if (!path) {
      continue;
    }
    if (!observedPaths.has(path)) {
      // Don't double-report an unobserved field whose parent object was
      // itself never observed (that's implied, not a distinct field gap) —
      // still report top-level and any path whose direct parent WAS seen,
      // to keep the signal about the specific missing field.
      divergences.push({ kind: "unobserved-field", path, detail: "declared but never observed in any sample" });
    }
  }

  return divergences;
}

function hasOpaqueDeclaredAncestor(path: string, declared: Map<string, DeclaredField>): boolean {
  const segments = splitPath(path);
  for (let end = segments.length - 1; end > 0; end -= 1) {
    const ancestorPath = joinPath(segments.slice(0, end));
    if (declared.has(ancestorPath)) {
      // Declared ancestor exists; since `declaredFields` only registers a
      // path with children when the schema had `properties`/`items`, an
      // ancestor present here without our path as a sibling means it had
      // no declared shape for this branch — i.e. opaque.
      return true;
    }
  }
  return false;
}

/** Split a dot/array path into segments, keeping `[]` markers attached to their field. */
function splitPath(path: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const ch of path) {
    if (ch === ".") {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out;
}

function joinPath(segments: readonly string[]): string {
  return segments.join(".");
}

// ─── Enum observation (needs the declared enum, so done post-hoc) ───────

/** Re-scan records for enum violations now that we know which paths declare an enum. */
function collectEnumViolations(
  records: readonly unknown[],
  declared: Map<string, DeclaredField>,
  fields: Map<string, FieldObservation>
): void {
  const enumPaths = [...declared.entries()].filter(([, d]) => d.enumValues);
  if (enumPaths.length === 0) {
    return;
  }
  for (const [path, decl] of enumPaths) {
    const allowed = new Set((decl.enumValues ?? []).map((v) => JSON.stringify(v)));
    const observation = fields.get(path);
    if (!observation) {
      continue;
    }
    for (const record of records) {
      for (const value of valuesAtPath(record, path)) {
        const key = JSON.stringify(value);
        if (!allowed.has(key)) {
          observation.enumViolations.add(key);
        }
      }
    }
  }
}

/** Resolve every value reachable at a dot/array path within one record (0, 1, or many for arrays). */
function valuesAtPath(record: unknown, path: string): unknown[] {
  const segments = splitPath(path);
  let current: unknown[] = [record];
  for (const segment of segments) {
    const isArrayElement = segment.endsWith("[]");
    const key = isArrayElement ? segment.slice(0, -2) : segment;
    const next: unknown[] = [];
    for (const item of current) {
      if (item === null || typeof item !== "object" || Array.isArray(item)) {
        continue;
      }
      const value = (item as Record<string, unknown>)[key];
      if (isArrayElement) {
        if (Array.isArray(value)) {
          next.push(...value);
        }
        continue;
      }
      next.push(value);
    }
    current = next;
  }
  return current;
}

// ─── Report rendering ────────────────────────────────────────────────────

function presencePct(count: number, total: number): string {
  if (total === 0) {
    return "0%";
  }
  return `${Math.round((count / total) * 100)}%`;
}

function renderFieldTable(fields: Map<string, FieldObservation>, sampleCount: number): string {
  const lines: string[] = [];
  const sortedPaths = [...fields.keys()].sort();
  const pathWidth = Math.max(24, ...sortedPaths.map((p) => p.length));
  lines.push(`  ${"field".padEnd(pathWidth)}  ${"type(s)".padEnd(24)}  presence`);
  for (const path of sortedPaths) {
    const obs = fields.get(path);
    if (!obs) {
      continue;
    }
    const types = [...obs.types].sort().join("|");
    lines.push(`  ${path.padEnd(pathWidth)}  ${types.padEnd(24)}  ${presencePct(obs.count, sampleCount)}`);
  }
  return lines.join("\n");
}

function renderDivergences(divergences: readonly Divergence[]): string {
  if (divergences.length === 0) {
    return "  (none)";
  }
  const order: Record<Divergence["kind"], string> = {
    "undeclared-field": "OBSERVED-BUT-UNDECLARED",
    "unobserved-field": "DECLARED-BUT-NEVER-OBSERVED",
    "type-mismatch": "TYPE-MISMATCH",
    "enum-violation": "ENUM-VIOLATION",
    "no-samples": "NO-SAMPLES",
  };
  return divergences.map((d) => `  [${order[d.kind]}] ${d.path}: ${d.detail}`).join("\n");
}

// ─── Main ────────────────────────────────────────────────────────────────

function printStreamReport(
  streamName: string,
  records: readonly unknown[],
  declaredSchema: JsonSchema | undefined
): number {
  console.log(`\n── stream: ${streamName} ${"─".repeat(Math.max(0, 50 - streamName.length))}`);
  if (records.length === 0) {
    // A declared stream with ZERO observed samples is itself a divergence,
    // not a silent skip: a schema this tool never actually checked against
    // any real data is exactly as unverified as a schema with every field
    // wrong — "no records found" used to fall out of the report entirely
    // (0 divergences, no signal), which let a stream go completely
    // unobserved forever without ever showing up in the `divergences: N`
    // total anyone actually looks at.
    console.log("  no records found for this stream");
    const noSamplesDivergence: Divergence = {
      kind: "no-samples",
      path: "$stream",
      detail: `declared stream "${streamName}" has zero observed samples — schema conformance was never checked against any real data`,
    };
    console.log("\n  DIVERGENCES:");
    console.log(renderDivergences([noSamplesDivergence]));
    return 1;
  }
  console.log(`  samples: ${records.length}${records.length >= SAMPLE_CAP ? " (capped)" : ""}`);

  const fields = observeRecords(records);
  const declared = declaredFields(declaredSchema);
  collectEnumViolations(records, declared, fields);

  console.log("\n  Field table:");
  console.log(renderFieldTable(fields, records.length));

  const divergences = computeDivergences(fields, declared);
  console.log("\n  DIVERGENCES:");
  console.log(renderDivergences(divergences));

  return divergences.length;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const manifest = readManifest(args.connector, args.manifestPath);
  const streams = manifest.streams ?? [];
  if (streams.length === 0) {
    console.log(`[observe-schema] connector "${args.connector}" declares no streams in its manifest`);
    console.log("divergences: 0");
    return;
  }

  const sources = args.recordSources.length > 0 ? args.recordSources : [defaultRecordsDir(args.connector)];
  const streamNames = streams.map((s) => s.name);
  const streamFiles = resolveStreamFiles(streamNames, sources);

  console.log(`observe-schema: ${args.connector}`);
  console.log(`manifest: ${args.manifestPath ?? join(MANIFEST_DIR, `${args.connector}.json`)}`);
  console.log(`record sources: ${sources.join(", ")}`);

  let totalDivergences = 0;
  for (const stream of streams) {
    const files = streamFiles.get(stream.name) ?? [];
    const records: unknown[] = [];
    for (const file of files) {
      if (records.length >= SAMPLE_CAP) {
        break;
      }
      records.push(...loadJsonlRecords(file, SAMPLE_CAP - records.length));
    }
    totalDivergences += printStreamReport(stream.name, records, stream.schema);
  }

  console.log(`\ndivergences: ${totalDivergences}`);
}

try {
  main();
} catch (err: unknown) {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`[observe-schema] FATAL: ${message}\n`);
  process.exitCode = 1;
}
