// Common schemas reused by public and reference-only route manifests.
//
// Each exported schema is a plain JSON-Schema (Draft-07 compatible) object
// so it can be fed directly into AJV and emitted directly into OpenAPI 3.1
// documents. We intentionally use structural types here rather than
// importing from a JSON-Schema type package: the shipped schemas are hand
// authored and the shape we care about (emitted to AJV / OpenAPI) is
// narrow. A structural `JsonSchema` captures that without pulling in a
// dependency and keeps the surface inspectable at the call site.

// Every known JSON-Schema keyword we actually use. Anything not listed is
// still permitted via the index signature, which is how schemas with
// vendor extensions (`x-...`) continue to pass through untouched.
export interface JsonSchema {
  $id?: string;
  additionalProperties?: boolean | JsonSchema;
  allOf?: readonly JsonSchema[];
  anyOf?: readonly JsonSchema[];
  const?: unknown;
  description?: string;
  enum?: readonly unknown[];
  format?: string;
  items?: JsonSchema;
  maximum?: number;
  maxLength?: number;
  minimum?: number;
  minLength?: number;
  oneOf?: readonly JsonSchema[];
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  type?: string | string[];
  [extension: string]: unknown;
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
  description: "Opaque changes-since token. Distinct from list-page cursors.",
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
  },
  required: ["error"],
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
