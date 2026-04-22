// Common schemas reused by public and reference-only route manifests.
//
// Each exported schema is a plain JSON-Schema (Draft-07 compatible) object so
// it can be fed directly into ajv and emitted directly into OpenAPI 3.1 docs.

export const IdSchema = {
  $id: 'pdpp/common/Id',
  type: 'string',
  minLength: 1,
  maxLength: 256,
};

export const UriSchema = {
  type: 'string',
  format: 'uri',
};

export const CursorSchema = {
  $id: 'pdpp/common/Cursor',
  type: 'string',
  description: 'Opaque logical pagination cursor. Encodes (cursor_field, primary_key) position.',
};

export const ChangesSinceSchema = {
  $id: 'pdpp/common/ChangesSince',
  type: 'string',
  description: 'Opaque changes-since token. Distinct from list-page cursors.',
};

export const OrderSchema = {
  $id: 'pdpp/common/Order',
  type: 'string',
  enum: ['asc', 'desc'],
};

export const FreshnessStatusSchema = {
  $id: 'pdpp/common/FreshnessStatus',
  type: 'string',
  enum: ['current', 'stale', 'unknown'],
};

export const FreshnessSchema = {
  $id: 'pdpp/common/Freshness',
  type: 'object',
  additionalProperties: false,
  properties: {
    status: FreshnessStatusSchema,
    captured_at: { type: 'string', format: 'date-time' },
    last_attempted_at: { type: 'string', format: 'date-time' },
  },
  required: ['status'],
};

export const ErrorObjectSchema = {
  $id: 'pdpp/common/PdppError',
  type: 'object',
  additionalProperties: false,
  properties: {
    error: {
      type: 'object',
      additionalProperties: false,
      properties: {
        type: { type: 'string' },
        code: { type: 'string' },
        message: { type: 'string' },
        param: { type: 'string' },
        request_id: { type: 'string' },
      },
      required: ['type', 'code', 'message', 'request_id'],
    },
  },
  required: ['error'],
};

export const OAuthErrorSchema = {
  $id: 'pdpp/common/OAuthError',
  type: 'object',
  additionalProperties: false,
  properties: {
    error: { type: 'string' },
    error_description: { type: 'string' },
  },
  required: ['error'],
};

export const ListEnvelopeSchema = (itemSchema) => ({
  type: 'object',
  additionalProperties: false,
  properties: {
    object: { const: 'list' },
    data: { type: 'array', items: itemSchema },
    has_more: { type: 'boolean' },
    next_cursor: { type: 'string' },
  },
  required: ['object', 'data', 'has_more'],
});

export const PaginationQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 500 },
    cursor: CursorSchema,
    order: OrderSchema,
  },
};
