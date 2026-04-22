// Compile AJV validators from route manifests and expose a thin helper for
// request validation inside the Express server (W2) and later Fastify (W6).
//
// Common schemas like UriSchema declare `$id` so they can be referenced from
// generated OpenAPI. Sharing those across many route manifests through a
// single ajv instance causes `$id` collisions ("resolves to more than one
// schema"). We therefore compile each schema in its own isolated ajv instance
// — cheap at package-init time, safe at runtime.

import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { publicManifests } from './public/index.js';
import { referenceManifests } from './reference/index.js';

const allManifests = [...publicManifests, ...referenceManifests];

function makeAjv({ coerceTypes }) {
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    useDefaults: false,
    coerceTypes,
  });
  addFormats(ajv);
  return ajv;
}

const validators = new Map();

// Recursively clone a schema while dropping `$id` keys. Common schemas (like
// `pdpp/common/Uri`) carry `$id` for OpenAPI emission, but the same `$id` may
// be inlined multiple times within one request/response schema. Ajv rejects
// those as ambiguous `$id` declarations. Stripping `$id` before compile
// preserves shape validation and lets OpenAPI still see `$id` on the source.
function stripIds(node) {
  if (Array.isArray(node)) {
    return node.map((item) => stripIds(item));
  }
  if (node && typeof node === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === '$id') continue;
      out[key] = stripIds(value);
    }
    return out;
  }
  return node;
}

function compilePart(schema, { coerceTypes }) {
  if (!schema) return null;
  const cleaned = stripIds(schema);
  try {
    return makeAjv({ coerceTypes }).compile(cleaned);
  } catch (err) {
    const tagged = new Error(`Failed to compile schema${schema.$id ? ' ' + schema.$id : ''}: ${err.message}`);
    tagged.cause = err;
    throw tagged;
  }
}

for (const manifest of allManifests) {
  validators.set(manifest.id, {
    manifest,
    params: compilePart(manifest.request?.params, { coerceTypes: false }),
    query: compilePart(manifest.request?.query, { coerceTypes: true }),
    body: manifest.request?.body ? compilePart(manifest.request.body.schema, { coerceTypes: false }) : null,
    headers: compilePart(manifest.request?.headers, { coerceTypes: false }),
  });
}

/**
 * Validate an incoming request against the declared contract for an operation.
 *
 * Returns `{ ok: true }` on success, or `{ ok: false, errors: [...] }` on
 * validation failures. Errors carry ajv's shape (instancePath, message, params).
 */
export function validateRequest(operationId, { params, query, body, headers } = {}) {
  const entry = validators.get(operationId);
  if (!entry) {
    return { ok: false, errors: [{ message: `Unknown operation id: ${operationId}` }] };
  }
  const errors = [];
  const check = (fn, value, label) => {
    if (!fn || value == null) return;
    if (!fn(value)) {
      for (const e of fn.errors || []) {
        errors.push({ ...e, where: label });
      }
    }
  };
  check(entry.params, params, 'params');
  check(entry.query, query, 'query');
  check(entry.body, body, 'body');
  check(entry.headers, headers, 'headers');
  return errors.length ? { ok: false, errors } : { ok: true };
}

export function listOperations() {
  return allManifests.map((m) => ({
    id: m.id,
    method: m.method,
    path: m.path,
    surface: m.surface,
    tags: m.tags,
  }));
}
