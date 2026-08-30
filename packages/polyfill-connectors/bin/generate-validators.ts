#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * SPIKE: manifest → zod validator generator.
 *
 * Hand-written `connectors/<c>/schemas.ts` files restate the JSON Schema
 * that already lives in `manifests/<c>.json` (`streams[].schema`). This
 * generator proves that the JSON Schema can be compiled straight into zod
 * validator source, so that duplication becomes generatable rather than
 * hand-maintained.
 *
 * Usage:
 *   pnpm exec tsx bin/generate-validators.ts <connector> [connector...]
 *
 * Reads `manifests/<connector>.json`, compiles every `streams[].schema`
 * into a zod schema, and writes `generated/<connector>.schemas.gen.ts`.
 *
 * Scope (spike, not general JSON Schema): this generator supports ONLY the
 * subset of JSON Schema actually present in the target manifests —
 * object/required/properties, string (+ enum, format passthrough via
 * .describe()), number/integer, boolean, null-via-type-array, array/items,
 * and nested objects (including property-less "open" objects, which map to
 * `z.record(z.string(), z.unknown())`). Any other construct (oneOf/anyOf/
 * allOf/$ref/const/pattern/additionalProperties/tuple-items/etc.) is a hard
 * error — this spike does not attempt to guess a lossy mapping.
 *
 * Output carries a DO-NOT-EDIT header with the source manifest's content
 * digest and a generator version tag, so drift between manifest and
 * generated file is mechanically detectable (re-run and diff).
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const GENERATOR_VERSION = "validator-gen/1";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, "..");
const MANIFESTS_DIR = join(PKG_ROOT, "manifests");
const OUT_DIR = join(PKG_ROOT, "generated");

// ─── JSON Schema (manifest subset) types ────────────────────────────────

type JsonSchemaType = "object" | "string" | "number" | "integer" | "boolean" | "array" | "null";

interface JsonSchema {
  enum?: unknown[];
  format?: string;
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  type?: JsonSchemaType | JsonSchemaType[];
  // x_pdpp_role and other x_-prefixed keys are manifest-only annotations;
  // the generator ignores unknown keys that start with "x_" everywhere.
  [key: string]: unknown;
}

interface ManifestStream {
  name: string;
  schema: JsonSchema;
}

interface Manifest {
  connector_key?: string;
  streams: ManifestStream[];
}

// ─── Unsupported-construct detection ────────────────────────────────────

const SUPPORTED_SCHEMA_KEYS = new Set([
  "type",
  "properties",
  "required",
  "enum",
  "format",
  "items",
  // Manifest metadata we intentionally ignore rather than reject:
  "x_pdpp_role",
  "description",
]);

const UNSUPPORTED_JSON_SCHEMA_KEYWORDS = [
  "oneOf",
  "anyOf",
  "allOf",
  "not",
  "$ref",
  "const",
  "pattern",
  "additionalProperties",
  "patternProperties",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "multipleOf",
  "uniqueItems",
  "prefixItems",
];

function assertSupported(schema: JsonSchema, path: string): void {
  for (const key of Object.keys(schema)) {
    if (key.startsWith("x_")) {
      continue;
    }
    if (UNSUPPORTED_JSON_SCHEMA_KEYWORDS.includes(key)) {
      throw new Error(
        `unsupported JSON Schema construct "${key}" at ${path}: this spike generator ` +
          "only supports the subset actually present in the target manifests " +
          "(object/required/properties, string[+enum,format], number, integer, " +
          "boolean, null-via-type-array, array/items, nested objects). Extend the " +
          "generator deliberately rather than silently ignoring this."
      );
    }
    if (!SUPPORTED_SCHEMA_KEYS.has(key)) {
      throw new Error(
        `unrecognized JSON Schema keyword "${key}" at ${path}: not in the supported ` +
          "subset and not a known-unsupported keyword either — inspect it by hand " +
          "before deciding how (or whether) to support it."
      );
    }
  }
}

// ─── Type normalization ─────────────────────────────────────────────────

interface NormalizedType {
  nullable: boolean;
  primary: JsonSchemaType;
}

function normalizeType(schema: JsonSchema, path: string): NormalizedType {
  const { type } = schema;
  if (type === undefined) {
    throw new Error(`missing "type" at ${path}: every schema node in the supported subset must declare a type`);
  }
  const types = Array.isArray(type) ? type : [type];
  if (types.length === 0) {
    throw new Error(`empty "type" array at ${path}`);
  }
  const nullable = types.includes("null");
  const nonNull = types.filter((t) => t !== "null");
  if (nonNull.length === 0) {
    throw new Error(`"type" at ${path} is only ["null"] — no non-null type to validate against`);
  }
  if (nonNull.length > 1) {
    throw new Error(
      `unsupported multi-type union (excluding null) at ${path}: [${nonNull.join(", ")}]. ` +
        "This spike only supports a single non-null type optionally unioned with null " +
        '(JSON Schema\'s ["T", "null"] idiom for nullable fields), not arbitrary unions.'
    );
  }
  const [primary] = nonNull;
  if (primary === undefined) {
    throw new Error(`unreachable: empty non-null type at ${path}`);
  }
  return { primary, nullable };
}

// ─── Identifier / literal helpers ───────────────────────────────────────

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const CAMEL_SPLIT_RE = /[_\-\s]+/;

function propKey(name: string): string {
  return IDENT_RE.test(name) ? name : JSON.stringify(name);
}

function camelCase(input: string): string {
  return input
    .split(CAMEL_SPLIT_RE)
    .filter(Boolean)
    .map((part, i) => (i === 0 ? part.toLowerCase() : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()))
    .join("");
}

// ─── Core compiler: JSON Schema node → zod expression source ───────────

function applyNullable(expr: string, nullable: boolean): string {
  return nullable ? `${expr}.nullable()` : expr;
}

function compileNode(schema: JsonSchema, path: string): string {
  assertSupported(schema, path);

  // enum: value vocabulary check. Manifests express enum on string-typed
  // fields only in the corpus this generator targets; keep that assumption
  // explicit rather than silently handling enum-of-any-type.
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0) {
      throw new Error(`"enum" at ${path} must be a non-empty array`);
    }
    // An enum whose vocabulary itself includes `null` as a literal member
    // (e.g. venmo's `audience: {"type": ["string","null"], "enum": [...,
    // null]}`) is a JSON Schema idiom this spike does not support: it mixes
    // "null means absent" (type array) with "null is a modeled vocabulary
    // value" (enum member) in one field, and z.enum() cannot hold `null` as
    // a member. Fail loudly rather than silently dropping the null member
    // or guessing which meaning was intended.
    const hasNullMember = schema.enum.includes(null);
    const nonNullMembers = schema.enum.filter((v) => v !== null);
    if (hasNullMember) {
      throw new Error(
        `unsupported "enum" at ${path}: contains a literal null member alongside ` +
          "string values. This spike does not support enum-includes-null " +
          '(distinct from the ["T","null"] nullable-type idiom) — z.enum() cannot ' +
          "model null as a vocabulary member; decide by hand whether this means " +
          "z.enum([...]).nullable() or something else."
      );
    }
    const allStrings = nonNullMembers.every((v) => typeof v === "string");
    if (!allStrings) {
      throw new Error(
        `unsupported "enum" at ${path}: contains a non-string member. This spike ` +
          "only supports string enums (the shape found in the target manifests)."
      );
    }
    const { nullable } = normalizeType(schema, path);
    const literals = (nonNullMembers as string[]).map((v) => JSON.stringify(v)).join(", ");
    return applyNullable(`z.enum([${literals}])`, nullable);
  }

  const { primary, nullable } = normalizeType(schema, path);

  switch (primary) {
    case "string": {
      let expr = "z.string()";
      if (schema.format !== undefined) {
        if (typeof schema.format !== "string") {
          throw new Error(`"format" at ${path} must be a string`);
        }
        // format passthrough: not enforced as a runtime constraint (the
        // manifest corpus uses "date" / "date-time" loosely — e.g. Oura's
        // bedtime fields are full datetimes but typed as bare "string" with
        // no format, while jellyfin's fetched_at is format:"date-time" but
        // real API values are not always strict RFC3339). We record the
        // format as a `.describe()` annotation so it is visible without
        // being a silent behavior expansion beyond what hand-written
        // schemas.ts files do today (they mostly use permissive regexes).
        expr = `z.string().describe(${JSON.stringify(`format:${schema.format}`)})`;
      }
      return applyNullable(expr, nullable);
    }
    case "integer":
      return applyNullable("z.number().int()", nullable);
    case "number":
      return applyNullable("z.number()", nullable);
    case "boolean":
      return applyNullable("z.boolean()", nullable);
    case "array": {
      if (!schema.items) {
        throw new Error(`array at ${path} has no "items": this spike requires typed array items`);
      }
      const itemExpr = compileNode(schema.items, `${path}[]`);
      return applyNullable(`z.array(${itemExpr})`, nullable);
    }
    case "object":
      return applyNullable(compileObject(schema, path), nullable);
    default:
      throw new Error(`unsupported type "${String(primary)}" at ${path}`);
  }
}

function compileObject(schema: JsonSchema, path: string): string {
  if (!schema.properties) {
    // Property-less object: an intentionally open/opaque map (e.g. Oura's
    // `contributors`, Jellyfin's `provider_ids`). Manifests in this corpus
    // never declare additionalProperties, so there is no signal for value
    // type beyond "provider-controlled JSON object" — model as an unknown
    // value record rather than guessing a narrower shape.
    return "z.record(z.string(), z.unknown())";
  }
  const required = new Set(schema.required ?? []);
  const lines: string[] = [];
  for (const [key, propSchema] of Object.entries(schema.properties)) {
    const propPath = `${path}.${key}`;
    let fieldExpr = compileNode(propSchema, propPath);
    if (!required.has(key)) {
      fieldExpr = `${fieldExpr}.optional()`;
    }
    lines.push(`  ${propKey(key)}: ${fieldExpr},`);
  }
  return `z.object({\n${lines.join("\n")}\n})`;
}

// ─── Manifest digest + file assembly ────────────────────────────────────

function manifestDigest(raw: string): string {
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

function generateForConnector(connector: string): void {
  const manifestPath = join(MANIFESTS_DIR, `${connector}.json`);
  const raw = readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(raw) as Manifest;

  if (!Array.isArray(manifest.streams) || manifest.streams.length === 0) {
    throw new Error(`${manifestPath}: manifest has no streams`);
  }

  const digest = manifestDigest(raw);
  const streamBlocks: string[] = [];
  const registryLines: string[] = [];

  for (const stream of manifest.streams) {
    if (typeof stream.name !== "string" || stream.name.length === 0) {
      throw new Error(`${manifestPath}: a stream is missing a non-empty "name"`);
    }
    if (!stream.schema) {
      throw new Error(`${manifestPath}: stream "${stream.name}" has no "schema"`);
    }
    const schemaTypes = Array.isArray(stream.schema.type) ? stream.schema.type : [stream.schema.type];
    if (!schemaTypes.includes("object")) {
      throw new Error(`${manifestPath}: stream "${stream.name}" schema root must be type "object"`);
    }
    const varName = `${camelCase(stream.name)}Schema`;
    const expr = compileObject(stream.schema, stream.name);
    streamBlocks.push(`export const ${varName} = ${expr};`);
    registryLines.push(`  ${propKey(stream.name)}: ${varName},`);
  }

  const header = `// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// ─────────────────────────────────────────────────────────────────────────
// GENERATED FILE — DO NOT EDIT.
//
// Source manifest: manifests/${connector}.json
// Manifest digest (sha256, first 16 hex chars): ${digest}
// Generator: ${GENERATOR_VERSION} (bin/generate-validators.ts)
//
// Regenerate with:
//   pnpm exec tsx bin/generate-validators.ts ${connector}
//
// If this file is stale relative to the manifest, the digest above will not
// match a fresh hash of manifests/${connector}.json — regenerate rather than
// hand-editing.
// ─────────────────────────────────────────────────────────────────────────

import { z } from "zod";
`;

  const body = `
${streamBlocks.join("\n\n")}

export const SCHEMAS: Record<string, z.ZodTypeAny> = {
${registryLines.join("\n")}
};
`;

  mkdirSync(OUT_DIR, { recursive: true });
  const outPath = join(OUT_DIR, `${connector}.schemas.gen.ts`);
  writeFileSync(outPath, header + body);
  console.log(`wrote ${outPath} (${manifest.streams.length} stream schema(s), digest ${digest})`);
}

// ─── Entry point ─────────────────────────────────────────────────────────

const connectors = process.argv.slice(2);
if (connectors.length === 0) {
  console.error("usage: tsx bin/generate-validators.ts <connector> [connector...]");
  process.exit(2);
}

for (const connector of connectors) {
  generateForConnector(connector);
}
