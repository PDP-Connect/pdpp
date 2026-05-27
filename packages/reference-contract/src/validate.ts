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
import { publicManifests as publicManifestsRaw } from "./public/index.ts";
import { referenceManifests as referenceManifestsRaw } from "./reference/index.ts";

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
  // Response validators compile lazily per HTTP status code: most call sites
  // only ever look at one response status, and lazy compile lets us share
  // the per-route ajv discipline (`coerceTypes: false`, `$id` stripped)
  // without paying for unused statuses at module-init time.
  responsesByStatus: Map<string, ValidateFunction | null>;
}

const validators = new Map<string, ValidatorEntry>();

// Body content types where the wire shape is opaque bytes and the
// manifest's `schema: { type: "string", format: "binary" }` is a
// contract-design hint, not a runtime check. AJV cannot meaningfully
// validate a Buffer against a string schema, so skip body validation
// for these content types. Request validation for these routes still
// covers params / query / headers, which carry the addressing
// information.
const OPAQUE_BODY_CONTENT_TYPES = new Set(["application/octet-stream", "application/x-ndjson"]);

function shouldCompileBodyValidator(manifest: RouteManifest): boolean {
  const body = manifest.request?.body;
  if (!body) return false;
  if (!body.schema) return false;
  const contentType = body.contentType?.toLowerCase();
  if (contentType && OPAQUE_BODY_CONTENT_TYPES.has(contentType)) return false;
  return true;
}

for (const manifest of allManifests) {
  validators.set(manifest.id, {
    manifest,
    params: compilePart(manifest.request?.params, { coerceTypes: false }),
    query: compilePart(manifest.request?.query, { coerceTypes: true }),
    body: shouldCompileBodyValidator(manifest)
      ? compilePart(manifest.request?.body?.schema, { coerceTypes: false })
      : null,
    headers: compilePart(manifest.request?.headers, { coerceTypes: false }),
    responsesByStatus: new Map<string, ValidateFunction | null>(),
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

export interface ValidateResponseInput {
  body?: unknown;
  status: number;
}

export type ResponseValidationResult =
  | { ok: true; skipped: false }
  | {
      // `skipped` is intentional: an operation may legitimately have no
      // response schema for a given status (e.g. 204 no-content, redirects,
      // binary bodies, or a status not enumerated in the manifest). Callers
      // can use the `reason` to decide whether the skip is itself a bug.
      ok: true;
      skipped: true;
      reason: "unknown_operation_id" | "no_schema_for_status";
    }
  | {
      ok: false;
      errors: Array<{ instancePath?: string; message: string; params?: unknown }>;
    };

/**
 * Validate the JSON body of an outgoing response against the declared
 * contract for an operation + HTTP status.
 *
 * Returns `{ ok: true, skipped: false }` when the manifest has a response
 * schema for the given status and the body matches. Returns
 * `{ ok: true, skipped: true, reason }` when no schema exists for the
 * operation id or for the given status. Returns `{ ok: false, errors }`
 * when validation fails.
 *
 * The function is intentionally non-mutating: it never serializes, strips,
 * coerces, or transforms the response body. Callers must continue to send
 * the original body when validation passes.
 */
export function validateResponse(operationId: string, input: ValidateResponseInput): ResponseValidationResult {
  const entry = validators.get(operationId);
  if (!entry) {
    return { ok: true, skipped: true, reason: "unknown_operation_id" };
  }
  const statusKey = String(input.status);
  let validator = entry.responsesByStatus.get(statusKey);
  if (validator === undefined) {
    const responses = entry.manifest.responses ?? {};
    const responseSpec = responses[statusKey];
    const schema = responseSpec?.schema;
    validator = schema ? compilePart(schema, { coerceTypes: false }) : null;
    entry.responsesByStatus.set(statusKey, validator);
  }
  if (!validator) {
    return { ok: true, skipped: true, reason: "no_schema_for_status" };
  }
  if (validator(input.body)) {
    return { ok: true, skipped: false };
  }
  const errors = (validator.errors ?? []).map((e: ErrorObject) => ({
    instancePath: e.instancePath,
    message: e.message ?? "validation failed",
    params: e.params,
  }));
  return { ok: false, errors };
}

/**
 * Report whether `@pdpp/reference-contract` has a declared response schema
 * for `(operationId, status)`. Lets the transport allowlist verify at
 * registration time that an enrolled route actually has a response schema
 * to validate against, without forcing a validator compile during request
 * handling.
 */
export function hasResponseSchema(operationId: string, status: number): boolean {
  const entry = validators.get(operationId);
  if (!entry) {
    return false;
  }
  const responses = entry.manifest.responses ?? {};
  return Boolean(responses[String(status)]?.schema);
}

/**
 * Look up the manifest for an operation id. Returns `null` when the id is
 * not exported by the package. Used by the transport adapter to read the
 * declared 400 response schema and pick OAuth-shaped vs PDPP-shaped error
 * envelopes for allowlisted request-validation failures.
 */
export function getManifest(operationId: string): RouteManifest | null {
  const entry = validators.get(operationId);
  return entry ? entry.manifest : null;
}
