// Compile AJV validators from route manifests and expose a thin helper for
// request validation inside the Express server (W2) and later Fastify (W6).
//
// Common schemas like UriSchema declare `$id` so they can be referenced from
// generated OpenAPI. Sharing those across many route manifests through a
// single ajv instance causes `$id` collisions ("resolves to more than one
// schema"). We therefore compile each schema in its own isolated ajv
// instance — cheap at package-init time, safe at runtime.

// AJV and ajv-formats both ship as CJS with `module.exports = thing`
// plus a redundant `exports.default = thing`. Their published .d.ts
// files declare `export default` (ESM-shape) rather than `export =`
// (CJS-shape), so under `module: NodeNext` + `verbatimModuleSyntax`
// neither `import x from '...'` nor `import * as x` produces a
// callable binding at the type level — even though the runtime shape
// IS callable. We avoid the type-system gap by going through Node's
// own CJS resolver (`createRequire`), which returns the real plugin
// constructors with their callable types intact. This is import-time
// only (called once at module load), matches the original .js
// runtime behavior, and doesn't smuggle `any` or `as unknown as` into
// the surface.
import { createRequire } from "node:module";
// biome-ignore lint/correctness/noUnresolvedImports: ajv is declared in package.json; Biome's resolver doesn't follow its CJS conditional exports
import type { Ajv as AjvClass, AnySchema, ErrorObject, Plugin, ValidateFunction } from "ajv";
// biome-ignore lint/correctness/noUnresolvedImports: ajv-formats is declared in package.json; Biome's resolver doesn't follow its CJS conditional exports
import type { FormatsPluginOptions } from "ajv-formats";
import type { JsonSchema, RouteManifest } from "./common/index.ts";
// The public / reference modules are still JS; their arrays structurally
// match RouteManifest[] and Node type-stripping loads them as untyped
// bindings. We cast once at import and rely on runtime tests (see
// test/surface.test.js) to catch drift until those modules migrate.
import { publicManifests as publicManifestsRaw } from "./public/index.js";
import { referenceManifests as referenceManifestsRaw } from "./reference/index.js";

const requireCjs = createRequire(import.meta.url);
// The CJS .d.ts entry points expose ESM defaults that aren't callable
// under `verbatimModuleSyntax`. Pulling the real exports through Node's
// own CJS resolver gives us the runtime-correct, type-correct objects.
const Ajv = requireCjs("ajv") as { new (opts?: Record<string, unknown>): AjvClass };
const addFormats = requireCjs("ajv-formats") as Plugin<FormatsPluginOptions>;

const publicManifests = publicManifestsRaw as readonly RouteManifest[];
const referenceManifests = referenceManifestsRaw as readonly RouteManifest[];

const allManifests: readonly RouteManifest[] = [...publicManifests, ...referenceManifests];

interface AjvOptions {
  coerceTypes: boolean;
}

function makeAjv({ coerceTypes }: AjvOptions): AjvClass {
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    useDefaults: false,
    coerceTypes,
  });
  addFormats(ajv);
  return ajv;
}

// Recursively clone a schema while dropping `$id` keys. Common schemas
// (like `pdpp/common/Uri`) carry `$id` for OpenAPI emission, but the same
// `$id` may be inlined multiple times within one request/response schema.
// AJV rejects those as ambiguous `$id` declarations. Stripping `$id`
// before compile preserves shape validation and lets OpenAPI still see
// `$id` on the source.
function stripIds(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => stripIds(item));
  }
  if (node !== null && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === "$id") {
        continue;
      }
      out[key] = stripIds(value);
    }
    return out;
  }
  return node;
}

function compilePart(schema: JsonSchema | undefined, options: AjvOptions): ValidateFunction | null {
  if (!schema) {
    return null;
  }
  // stripIds is recursive over arbitrary JSON; the result is the same
  // structural shape as the input, with `$id` removed. AJV's `compile`
  // accepts AnySchema, which is `boolean | SchemaObject` — our schemas
  // are always object schemas, so the assertion is honest.
  const cleaned = stripIds(schema) as AnySchema;
  try {
    return makeAjv(options).compile(cleaned);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const tag = schema.$id ? ` ${schema.$id}` : "";
    const tagged = new Error(`Failed to compile schema${tag}: ${message}`);
    if (err instanceof Error) {
      tagged.cause = err;
    }
    throw tagged;
  }
}

interface ValidatorEntry {
  body: ValidateFunction | null;
  headers: ValidateFunction | null;
  manifest: RouteManifest;
  params: ValidateFunction | null;
  query: ValidateFunction | null;
}

const validators = new Map<string, ValidatorEntry>();

for (const manifest of allManifests) {
  validators.set(manifest.id, {
    manifest,
    params: compilePart(manifest.request?.params, { coerceTypes: false }),
    query: compilePart(manifest.request?.query, { coerceTypes: true }),
    body: manifest.request?.body ? compilePart(manifest.request.body.schema, { coerceTypes: false }) : null,
    headers: compilePart(manifest.request?.headers, { coerceTypes: false }),
  });
}

export interface ValidateRequestInput {
  body?: unknown;
  headers?: unknown;
  params?: unknown;
  query?: unknown;
}

export interface ValidationFailure extends ErrorObject {
  where: "params" | "query" | "body" | "headers";
}

export type ValidationResult = { ok: true } | { ok: false; errors: Array<ValidationFailure | { message: string }> };

/**
 * Validate an incoming request against the declared contract for an
 * operation.
 *
 * Returns `{ ok: true }` on success, or `{ ok: false, errors: [...] }` on
 * validation failures. Errors carry AJV's shape (instancePath, message,
 * params) plus a `where` field identifying the request part that failed.
 */
export function validateRequest(operationId: string, input: ValidateRequestInput = {}): ValidationResult {
  const entry = validators.get(operationId);
  if (!entry) {
    return { ok: false, errors: [{ message: `Unknown operation id: ${operationId}` }] };
  }
  const { params, query, body, headers } = input;
  const errors: ValidationFailure[] = [];
  const check = (fn: ValidateFunction | null, value: unknown, label: ValidationFailure["where"]): void => {
    if (!fn || value == null) {
      return;
    }
    if (!fn(value)) {
      for (const e of fn.errors ?? []) {
        errors.push({ ...e, where: label });
      }
    }
  };
  check(entry.params, params, "params");
  check(entry.query, query, "query");
  check(entry.body, body, "body");
  check(entry.headers, headers, "headers");
  return errors.length ? { ok: false, errors } : { ok: true };
}

export interface OperationSummary {
  id: string;
  method: string;
  path: string;
  surface: "public" | "reference";
  tags: readonly string[] | undefined;
}

export function listOperations(): OperationSummary[] {
  return allManifests.map((m) => ({
    id: m.id,
    method: m.method,
    path: m.path,
    surface: m.surface,
    tags: m.tags,
  }));
}
