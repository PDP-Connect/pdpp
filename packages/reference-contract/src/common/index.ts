// Common schemas reused by public and reference-only route manifests.
//
// Each exported schema is a plain JSON-Schema (Draft-07 compatible) object
// so it can be fed directly into AJV and emitted directly into OpenAPI 3.1
// documents. We intentionally use structural types here rather than
// importing from a JSON-Schema type package: the shipped schemas are hand
// authored and the shape we care about (emitted to AJV / OpenAPI) is
// narrow. A structural `JsonSchema` captures that without pulling in a
// dependency and keeps the surface inspectable at the call site.

// The structural JsonSchema type lives in its own module so canonical.ts
// can depend on the type alone without pulling in this file's runtime
// values (which would create a value-level cycle now that this module
// re-exports from canonical.ts).
export type { JsonSchema } from "./json-schema.ts";

import type { JsonSchema } from "./json-schema.ts";

// Shared shape of a route manifest. Every entry in `publicManifests` and
// `referenceManifests` conforms to this. Request / response schemas are
// JSON-Schema objects; bodies optionally carry a content type.
//
// The reference implementation (reference-implementation/server/*) relies
// on this shape for validation wiring and for mapping manifests onto live
// routes, so the fields here match what that server actually reads. When
// a new keyword is needed (e.g. operator-only hints), add it here and the
// type will propagate through validate.ts and downstream consumers.
export interface RouteSchemaBody {
  contentType?: string;
  schema?: JsonSchema;
}

export interface RouteRequest {
  body?: RouteSchemaBody;
  headers?: JsonSchema;
  params?: JsonSchema;
  query?: JsonSchema;
}

export interface RouteResponse {
  contentType?: string;
  description?: string;
  schema?: JsonSchema;
}

export interface RouteManifest {
  id: string;
  method: string;
  path: string;
  request?: RouteRequest;
  responses?: Record<string, RouteResponse>;
  summary?: string;
  surface: "public" | "reference";
  tags?: readonly string[];
}

export const IdSchema: JsonSchema = {
  $id: "pdpp/common/Id",
  type: "string",
  minLength: 1,
  maxLength: 256,
};

export const UriSchema: JsonSchema = {
  type: "string",
  format: "uri",
};

export const CursorSchema: JsonSchema = {
  $id: "pdpp/common/Cursor",
  type: "string",
  description: "Opaque logical pagination cursor. Encodes (cursor_field, primary_key) position.",
};

export const ChangesSinceSchema: JsonSchema = {
  $id: "pdpp/common/ChangesSince",
  type: "string",
  description:
    "`beginning` for initial sync, or an opaque changes-since token from next_changes_since. Distinct from list-page cursors.",
};

export const OrderSchema: JsonSchema = {
  $id: "pdpp/common/Order",
  type: "string",
  enum: ["asc", "desc"],
};

export const FreshnessStatusSchema: JsonSchema = {
  $id: "pdpp/common/FreshnessStatus",
  type: "string",
  enum: ["current", "stale", "unknown"],
};

export const FreshnessSchema: JsonSchema = {
  $id: "pdpp/common/Freshness",
  type: "object",
  additionalProperties: false,
  properties: {
    status: FreshnessStatusSchema,
    captured_at: { type: "string", format: "date-time" },
    last_attempted_at: { type: "string", format: "date-time" },
  },
  required: ["status"],
};

export const ErrorObjectSchema: JsonSchema = {
  $id: "pdpp/common/PdppError",
  type: "object",
  additionalProperties: false,
  properties: {
    error: {
      type: "object",
      additionalProperties: false,
      properties: {
        type: { type: "string" },
        code: { type: "string" },
        message: { type: "string" },
        param: { type: "string" },
        request_id: { type: "string" },
      },
      required: ["type", "code", "message", "request_id"],
    },
  },
  required: ["error"],
};

export const OAuthErrorSchema: JsonSchema = {
  $id: "pdpp/common/OAuthError",
  type: "object",
  additionalProperties: false,
  properties: {
    error: { type: "string" },
    error_description: { type: "string" },
    request_id: { type: "string" },
  },
  required: ["error", "request_id"],
};

export const ListEnvelopeSchema = (itemSchema: JsonSchema): JsonSchema => ({
  type: "object",
  additionalProperties: false,
  properties: {
    object: { const: "list" },
    data: { type: "array", items: itemSchema },
    has_more: { type: "boolean" },
    next_cursor: { type: "string" },
  },
  required: ["object", "data", "has_more"],
});

export const PaginationQuerySchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    limit: { type: "integer", minimum: 1, maximum: 500 },
    cursor: CursorSchema,
    order: OrderSchema,
  },
};

// Canonical public read contract primitives — envelope, warnings, counts,
// and shared read-input parameters. Lives in ./canonical.ts to keep the
// legacy helpers in this file undisturbed during the migration window.
// See openspec/changes/canonicalize-public-read-contract/.
// biome-ignore lint/performance/noBarrelFile: ./common is the package's named entry point for shared schema helpers — call sites import members by name; the canonical primitives live in a sibling module to keep this file's legacy helpers untouched during the migration window.
export * from "./canonical.ts";
