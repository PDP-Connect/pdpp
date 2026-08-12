// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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
// biome-ignore lint/performance/noBarrelFile: ./common is the package's named entry point for shared schema helpers.
export {
  type CanonicalTerminalFactInput,
  canonicalTerminalRunCommitEnvelope,
  canonicalTerminalRunCommitJson,
  type TerminalRunCommitEnvelopeInput,
} from "./terminal-run-commit.ts";

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
  // Emitted as OpenAPI `requestBody.required`. Defaults to `true` when
  // omitted; set `false` for routes whose body is optional.
  required?: boolean;
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
  maxLength: 256,
  minLength: 1,
  type: "string",
};

export const UriSchema: JsonSchema = {
  format: "uri",
  type: "string",
};

export const CursorSchema: JsonSchema = {
  $id: "pdpp/common/Cursor",
  description: "Opaque logical pagination cursor. Encodes (cursor_field, primary_key) position.",
  type: "string",
};

export const ChangesSinceSchema: JsonSchema = {
  $id: "pdpp/common/ChangesSince",
  description:
    "`beginning` for initial sync, or an opaque changes-since token from next_changes_since. Distinct from list-page cursors.",
  type: "string",
};

export const OrderSchema: JsonSchema = {
  $id: "pdpp/common/Order",
  enum: ["asc", "desc"],
  type: "string",
};

export const FreshnessStatusSchema: JsonSchema = {
  $id: "pdpp/common/FreshnessStatus",
  enum: ["current", "stale", "unknown"],
  type: "string",
};

export const FreshnessSchema: JsonSchema = {
  $id: "pdpp/common/Freshness",
  additionalProperties: false,
  properties: {
    captured_at: { format: "date-time", type: "string" },
    last_attempted_at: { format: "date-time", type: "string" },
    status: FreshnessStatusSchema,
  },
  required: ["status"],
  type: "object",
};

// Disambiguation summary carried in an ambiguity error's `available_connections`
// list. When an owner-agent control action is requested with `connector_id`
// only and more than one configured connection matches, the typed error names
// every candidate by stable `connection_id` plus owner-meaningful identity
// (`connector_id`/`connector_key`, `display_name`, `label_status`) so the agent
// can re-issue the request against one concrete connection rather than guessing.
// Mirrors the owner-connection listing's identity fields; secret-free.
export const ErrorAvailableConnectionSchema: JsonSchema = {
  $id: "pdpp/common/ErrorAvailableConnection",
  additionalProperties: false,
  properties: {
    connection_id: { type: "string" },
    connector_id: { type: "string" },
    connector_key: { type: "string" },
    display_name: { type: ["string", "null"] },
    label_status: { enum: ["owner_set", "fallback"], type: "string" },
  },
  required: ["connection_id"],
  type: "object",
};

export const ErrorObjectSchema: JsonSchema = {
  $id: "pdpp/common/PdppError",
  additionalProperties: false,
  properties: {
    error: {
      additionalProperties: false,
      properties: {
        // Optional ambiguity-resolution hints. Emitted when an owner-agent
        // control action is rejected because a connector-only target matches
        // more than one configured connection: `available_connections` lists
        // every candidate's stable identity and `retry_with` names the field to
        // resubmit (e.g. `connection_id`). Absent on unambiguous errors.
        available_connections: { items: ErrorAvailableConnectionSchema, type: "array" },
        code: { type: "string" },
        message: { type: "string" },
        next_step: { type: "string" },
        param: { type: "string" },
        request_id: { type: "string" },
        // Optional 401-only hints already emitted by `pdppError`: where to read
        // protected-resource metadata and what to do next.
        resource_metadata: { type: "string" },
        retry_with: { type: "string" },
        type: { type: "string" },
      },
      required: ["type", "code", "message", "request_id"],
      type: "object",
    },
  },
  required: ["error"],
  type: "object",
};

export const OAuthErrorSchema: JsonSchema = {
  $id: "pdpp/common/OAuthError",
  additionalProperties: false,
  properties: {
    error: { type: "string" },
    error_description: { type: "string" },
    request_id: { type: "string" },
  },
  required: ["error", "request_id"],
  type: "object",
};

export const ListEnvelopeSchema = (itemSchema: JsonSchema): JsonSchema => ({
  additionalProperties: false,
  properties: {
    data: { items: itemSchema, type: "array" },
    has_more: { type: "boolean" },
    next_cursor: { type: "string" },
    object: { const: "list" },
  },
  required: ["object", "data", "has_more"],
  type: "object",
});

export const PaginationQuerySchema: JsonSchema = {
  additionalProperties: false,
  properties: {
    cursor: CursorSchema,
    limit: { maximum: 500, minimum: 1, type: "integer" },
    order: OrderSchema,
  },
  type: "object",
};

// Canonical public read contract primitives — envelope, warnings, counts,
// and shared read-input parameters. Lives in ./canonical.ts to keep the
// legacy helpers in this file undisturbed during the migration window.
// See openspec/changes/canonicalize-public-read-contract/.
export * from "./canonical.ts";
