// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Public PDPP route manifests.
//
// Every manifest has shape:
//   {
//     id: string               // operation id, matches OpenAPI operationId
//     method: string           // uppercase HTTP method
//     path: string             // path template with {params}
//     surface: 'public'        // public-facing PDPP API
//     tags: string[]
//     summary: string
//     request: { params?, query?, body?, headers? }
//     responses: { [code]: { schema?, contentType?, description? } }
//   }

import {
  ChangesSinceSchema,
  CursorSchema,
  ErrorObjectSchema,
  FreshnessSchema,
  ListEnvelopeSchema,
  MetaSchema,
  OAuthErrorSchema,
  OrderSchema,
  UriSchema,
} from "../common/index.ts";

const NonEmptyStringSchema = {
  minLength: 1,
  type: "string",
};

export const BATCH_CONSENT_STAGED_ENTRY_SOFT_CAP = 8;
export const BATCH_CONSENT_STAGED_ENTRY_WARNING_THRESHOLD = 6;

// Canonical public/operator/LLM-facing connection identity. `connection_id`
// is the canonical field name; `connector_instance_id` is supported as a
// deprecated wire alias during the migration window defined by
// `openspec/changes/expose-connection-identity-on-public-read`. Both fields
// carry the same opaque value when emitted on response envelopes; clients
// SHOULD prefer `connection_id` and the operator-meaningful `display_name`.
const ConnectionIdSchema = {
  description:
    "Canonical public identifier for a connection (one owner-configured account/device/profile). Prefer this over the deprecated `connector_instance_id` alias.",
  minLength: 1,
  type: "string",
};

const ConnectionDisplayNameSchema = {
  description:
    "Owner-meaningful label for the connection. Never the storage-layer placeholder (`legacy`, `default_account`); falls back to `<connector> · account N` when the owner has not renamed the connection.",
  minLength: 1,
  type: "string",
};

const ConnectorInstanceIdAliasSchema = {
  description:
    "Deprecated wire alias for `connection_id`. Emitted alongside `connection_id` during the migration window. New clients SHOULD ignore this field and read `connection_id` instead.",
  minLength: 1,
  type: "string",
};

const AvailableConnectionSchema = {
  additionalProperties: false,
  properties: {
    connection_id: ConnectionIdSchema,
    display_name: ConnectionDisplayNameSchema,
  },
  required: ["connection_id", "display_name"],
  type: "object",
};

// Per-stream entry on `GET /v1/schema` advertising one connection the caller
// may use as a `connection_id` filter on subsequent reads. `display_name` is
// omitted (not faked) when the owner has never renamed the connection — the
// runtime treats storage placeholders (`legacy`, `default_account`, the
// connector id) as absent labels rather than wire content.
const GrantedConnectionSchema = {
  additionalProperties: false,
  properties: {
    connection_id: ConnectionIdSchema,
    display_name: ConnectionDisplayNameSchema,
  },
  required: ["connection_id"],
  type: "object",
};

const CapabilityFlagSchema = {
  additionalProperties: false,
  properties: {
    declared: { type: "boolean" },
    reason: { type: "string" },
    usable: { type: "boolean" },
  },
  required: ["declared", "usable"],
  type: "object",
};

const PreRegisteredPublicClientSchema = {
  additionalProperties: false,
  properties: {
    client_id: NonEmptyStringSchema,
    client_name: NonEmptyStringSchema,
    token_endpoint_auth_method: { const: "none" },
  },
  required: ["client_id", "client_name", "token_endpoint_auth_method"],
  type: "object",
};

const RetrievalScoreSchema = {
  additionalProperties: false,
  properties: {
    kind: { enum: ["bm25", "semantic_distance"], type: "string" },
    order: { enum: ["higher_is_better", "lower_is_better"], type: "string" },
    value: { type: "number" },
  },
  required: ["kind", "value", "order"],
  type: "object",
};

const SearchMatchWindowSchema = {
  additionalProperties: true,
  properties: {
    complete: { type: "boolean" },
    field_path: NonEmptyStringSchema,
    read: {
      additionalProperties: true,
      properties: {
        args: { additionalProperties: true, type: "object" },
        tool: NonEmptyStringSchema,
      },
      required: ["tool", "args"],
      type: "object",
    },
    resource_uri: UriSchema,
    text: { type: "string" },
  },
  required: ["field_path", "text", "complete"],
  type: "object",
};

const StreamNamePathSchema = {
  additionalProperties: false,
  properties: { stream: NonEmptyStringSchema },
  required: ["stream"],
  type: "object",
};

const RecordIdPathSchema = {
  additionalProperties: false,
  properties: {
    id: NonEmptyStringSchema,
    stream: NonEmptyStringSchema,
  },
  required: ["stream", "id"],
  type: "object",
};

const GrantIdPathSchema = {
  additionalProperties: false,
  properties: { grantId: NonEmptyStringSchema },
  required: ["grantId"],
  type: "object",
};

const ListRecordsQuerySchema = {
  additionalProperties: false,
  properties: {
    changes_since: ChangesSinceSchema,
    connection_id: ConnectionIdSchema,
    connector_id: { type: "string" },
    connector_instance_id: ConnectorInstanceIdAliasSchema,
    cursor: CursorSchema,
    expand: { items: NonEmptyStringSchema, type: "array" },
    expand_limit: { type: "object" },
    fields: { type: "string" },
    filter: {
      description:
        "Per-field filter map. Exact: `filter[field]=value`. Range: `filter[field][op]=value` where `op` is one of the declared `field_capabilities.range_filter.operators` from `GET /v1/schema`.",
      type: "object",
    },
    limit: { maximum: 100, minimum: 1, type: "integer" },
    order: OrderSchema,
    subject_id: { type: "string" },
    view: { type: "string" },
    // Bounded-window opt-in. `exact` ⇒ the server MAY return `meta.window`
    // (`total` + logical `earliest_at`/`latest_at`) over the filtered,
    // grant-scoped corpus; absent / `none` ⇒ omitted. Not supported with
    // `changes_since`. Spec: complete-explorer-slvp-ideal.
    window: { enum: ["none", "exact"], type: "string" },
  },
  type: "object",
};

// Calendar `date_trunc` granularity set for `group_by_time`. Calendar-aware
// (weeks start Monday); see
//   openspec/changes/add-aggregate-time-buckets-and-distinct
const AGGREGATE_GRANULARITIES = ["minute", "hour", "day", "week", "month", "quarter", "year"];

const AggregateQuerySchema = {
  additionalProperties: false,
  properties: {
    connection_id: ConnectionIdSchema,
    connector_id: { type: "string" },
    connector_instance_id: ConnectorInstanceIdAliasSchema,
    field: { type: "string" },
    filter: { type: "object" },
    granularity: {
      description:
        "Calendar `date_trunc` unit for `group_by_time`. Required when `group_by_time` is present and forbidden otherwise.",
      enum: AGGREGATE_GRANULARITIES,
      type: "string",
    },
    // Exactly one grouping dimension in v1: `group_by` XOR `group_by_time`.
    // The resource server rejects supplying both with `invalid_request`.
    group_by: { type: "string" },
    group_by_time: {
      description:
        "Group counts into calendar time buckets over a declared date/date-time field. Mutually exclusive with `group_by`. Requires `granularity`.",
      type: "string",
    },
    limit: { maximum: 100, minimum: 1, type: "integer" },
    metric: { enum: ["count", "sum", "min", "max", "count_distinct"], type: "string" },
    subject_id: { type: "string" },
    time_zone: {
      description:
        "IANA time zone used to compute `group_by_time` bucket boundaries. Defaults to `UTC`; the response echoes the effective zone.",
      type: "string",
    },
  },
  required: ["metric"],
  type: "object",
};

const UploadBlobQuerySchema = {
  additionalProperties: false,
  properties: {
    connector_id: NonEmptyStringSchema,
    record_key: NonEmptyStringSchema,
    stream: NonEmptyStringSchema,
  },
  required: ["connector_id", "stream", "record_key"],
  type: "object",
};

const BlobObjectSchema = {
  additionalProperties: false,
  properties: {
    blob_id: NonEmptyStringSchema,
    mime_type: NonEmptyStringSchema,
    object: { const: "blob" },
    sha256: {
      pattern: "^[a-f0-9]{64}$",
      type: "string",
    },
    size_bytes: { minimum: 0, type: "integer" },
  },
  required: ["object", "blob_id", "sha256", "size_bytes", "mime_type"],
  type: "object",
};

const ClientDisplaySchema = {
  additionalProperties: false,
  properties: {
    logo_uri: UriSchema,
    name: NonEmptyStringSchema,
    policy_uri: UriSchema,
    tos_uri: UriSchema,
    uri: UriSchema,
  },
  type: "object",
};

const RetentionSchema = {
  additionalProperties: false,
  properties: {
    max_duration: NonEmptyStringSchema,
    on_expiry: NonEmptyStringSchema,
  },
  required: ["max_duration", "on_expiry"],
  type: "object",
};

const TimeRangeSchema = {
  additionalProperties: false,
  properties: {
    since: NonEmptyStringSchema,
    until: NonEmptyStringSchema,
  },
  type: "object",
};

const StreamSelectionSchema = {
  additionalProperties: false,
  properties: {
    client_claims: { additionalProperties: true, type: "object" },
    // Optional per-stream connection constraint. Absent means cross-connection
    // (fan-in) read semantics; present constrains disclosure to records,
    // hits, or blobs from the named connection. Owned by
    //   openspec/changes/expose-connection-identity-on-public-read.
    connection_id: ConnectionIdSchema,
    fields: { items: NonEmptyStringSchema, minItems: 1, type: "array" },
    name: NonEmptyStringSchema,
    necessity: { enum: ["required", "optional"], type: "string" },
    resources: { items: NonEmptyStringSchema, type: "array" },
    time_range: TimeRangeSchema,
    view: NonEmptyStringSchema,
  },
  required: ["name"],
  type: "object",
};

export const SourceObjectSchema = {
  additionalProperties: false,
  properties: {
    id: NonEmptyStringSchema,
    kind: { enum: ["connector", "provider_native"], type: "string" },
  },
  required: ["kind", "id"],
  type: "object",
};

const AuthorizationDetailBaseSchema = {
  additionalProperties: false,
  properties: {
    access_mode: { enum: ["single_use", "continuous"], type: "string" },
    purpose_code: NonEmptyStringSchema,
    purpose_description: NonEmptyStringSchema,
    retention: RetentionSchema,
    source: SourceObjectSchema,
    streams: { items: StreamSelectionSchema, minItems: 1, type: "array" },
    type: { const: "https://pdpp.org/data-access" },
  },
  required: ["type", "source", "purpose_code", "access_mode", "streams"],
  type: "object",
};

const AuthorizationDetailSchema = AuthorizationDetailBaseSchema;

const GrantSchema = {
  additionalProperties: false,
  properties: {
    access_mode: { enum: ["single_use", "continuous"], type: "string" },
    client: {
      additionalProperties: false,
      properties: {
        client_display: ClientDisplaySchema,
        client_id: NonEmptyStringSchema,
      },
      required: ["client_id"],
      type: "object",
    },
    expires_at: { format: "date-time", type: ["string", "null"] },
    grant_id: NonEmptyStringSchema,
    issued_at: { format: "date-time", type: "string" },
    manifest_version: NonEmptyStringSchema,
    purpose_code: NonEmptyStringSchema,
    purpose_description: NonEmptyStringSchema,
    retention: RetentionSchema,
    source: SourceObjectSchema,
    streams: { items: StreamSelectionSchema, minItems: 1, type: "array" },
    subject: {
      additionalProperties: false,
      properties: {
        id: NonEmptyStringSchema,
      },
      required: ["id"],
      type: "object",
    },
    version: NonEmptyStringSchema,
  },
  required: [
    "version",
    "grant_id",
    "issued_at",
    "subject",
    "client",
    "source",
    "manifest_version",
    "purpose_code",
    "access_mode",
    "streams",
  ],
  type: "object",
};

const AuthorizationServerMetadataSchema = {
  additionalProperties: false,
  properties: {
    agent_connect_endpoint: UriSchema,
    client_id_metadata_document_supported: { const: true },
    device_authorization_endpoint: UriSchema,
    grant_types_supported: {
      items: { const: "urn:ietf:params:oauth:grant-type:device_code" },
      minItems: 1,
      type: "array",
    },
    introspection_endpoint: UriSchema,
    issuer: UriSchema,
    pdpp_authorization_details_types_supported: {
      items: { const: "https://pdpp.org/data-access" },
      minItems: 1,
      type: "array",
    },
    pdpp_pre_registered_public_clients: {
      items: PreRegisteredPublicClientSchema,
      minItems: 1,
      type: "array",
    },
    pdpp_provider_connect_capabilities: {
      items: NonEmptyStringSchema,
      minItems: 1,
      type: "array",
    },
    pdpp_registration_modes_supported: {
      items: { enum: ["dynamic", "pre_registered_public", "client_id_metadata_document"], type: "string" },
      minItems: 1,
      type: "array",
    },
    pushed_authorization_request_endpoint: UriSchema,
    registration_endpoint: UriSchema,
    token_endpoint: UriSchema,
    token_endpoint_auth_methods_supported: {
      items: { const: "none" },
      minItems: 1,
      type: "array",
    },
  },
  required: [
    "issuer",
    "introspection_endpoint",
    "pushed_authorization_request_endpoint",
    "pdpp_provider_connect_capabilities",
    "pdpp_registration_modes_supported",
    "pdpp_pre_registered_public_clients",
    "pdpp_authorization_details_types_supported",
    "token_endpoint",
    "token_endpoint_auth_methods_supported",
    "device_authorization_endpoint",
    "agent_connect_endpoint",
    "grant_types_supported",
  ],
  type: "object",
};

// `capabilities` is the layered server-level capability layer. v1 carries
// the optional `lexical_retrieval` and `semantic_retrieval` extensions.
// additionalProperties: true so future extensions can add their own keys
// without a contract bump.
const ServerCapabilitiesSchema = {
  additionalProperties: true,
  properties: {
    hybrid_retrieval: {
      additionalProperties: false,
      properties: {
        cross_stream: { type: "boolean" },
        cursor_supported: { type: "boolean" },
        default_limit: { minimum: 1, type: "integer" },
        endpoint: NonEmptyStringSchema,
        max_limit: { minimum: 1, type: "integer" },
        sources: {
          items: { enum: ["lexical", "semantic"], type: "string" },
          minItems: 2,
          type: "array",
        },
        stability: { enum: ["experimental"], type: "string" },
        supported: { type: "boolean" },
      },
      required: ["supported"],
      type: "object",
    },
    lexical_retrieval: {
      additionalProperties: false,
      properties: {
        cross_stream: { type: "boolean" },
        default_limit: { minimum: 1, type: "integer" },
        endpoint: NonEmptyStringSchema,
        max_limit: { minimum: 1, type: "integer" },
        score: {
          additionalProperties: false,
          properties: {
            kind: { const: "bm25" },
            order: { const: "lower_is_better" },
            supported: { const: true },
            value_semantics: { const: "implementation_relative" },
          },
          required: ["supported", "kind", "order", "value_semantics"],
          type: "object",
        },
        snippets: { type: "boolean" },
        supported: { type: "boolean" },
      },
      required: ["supported"],
      type: "object",
    },
    semantic_retrieval: {
      additionalProperties: false,
      properties: {
        cross_stream: { type: "boolean" },
        default_limit: { minimum: 1, type: "integer" },
        dimensions: { minimum: 1, type: "integer" },
        distance_metric: NonEmptyStringSchema,
        endpoint: NonEmptyStringSchema,
        index_state: { enum: ["built", "building", "stale"], type: "string" },
        language_bias: {
          additionalProperties: false,
          properties: {
            note: NonEmptyStringSchema,
            primary: NonEmptyStringSchema,
          },
          required: ["primary"],
          type: "object",
        },
        lexical_blending: { type: "boolean" },
        max_limit: { minimum: 1, type: "integer" },
        model: NonEmptyStringSchema,
        query_input: { const: "text" },
        score: {
          additionalProperties: false,
          properties: {
            comparable_with: {
              additionalProperties: false,
              properties: {
                backend_identity: NonEmptyStringSchema,
                dimensions: { minimum: 1, type: "integer" },
                distance_metric: NonEmptyStringSchema,
                dtype: NonEmptyStringSchema,
                model: NonEmptyStringSchema,
                profile_id: NonEmptyStringSchema,
              },
              required: ["backend_identity", "model", "dimensions", "distance_metric"],
              type: "object",
            },
            kind: { const: "semantic_distance" },
            order: { const: "lower_is_better" },
            supported: { const: true },
            value_semantics: { const: "distance" },
          },
          required: ["supported", "kind", "order", "value_semantics", "comparable_with"],
          type: "object",
        },
        snippets: { type: "boolean" },
        stability: { enum: ["experimental"], type: "string" },
        supported: { type: "boolean" },
      },
      required: [
        "supported",
        "stability",
        "endpoint",
        "cross_stream",
        "query_input",
        "snippets",
        "lexical_blending",
        "model",
        "dimensions",
        "distance_metric",
        "default_limit",
        "max_limit",
        "index_state",
      ],
      type: "object",
    },
  },
  type: "object",
};

// Discovery hints describe the canonical first-call shapes a caller needs
// after reading the protected-resource metadata document. The block is
// derived from runtime state so it cannot drift from live behavior. See:
//   openspec/changes/polish-reference-api-discovery-seams/specs/reference-implementation-architecture/spec.md
const ProtectedResourceDiscoveryHintsSchema = {
  additionalProperties: false,
  properties: {
    aggregate: {
      additionalProperties: false,
      properties: {
        endpoint_template: NonEmptyStringSchema,
      },
      required: ["endpoint_template"],
      type: "object",
    },
    blob_indirection: NonEmptyStringSchema,
    changes_since_bootstrap: NonEmptyStringSchema,
    connectors_endpoint: NonEmptyStringSchema,
    hybrid_pagination_supported: { type: "boolean" },
    owner_polyfill_requires_source_kind_connector: { type: "boolean" },
    query_base: NonEmptyStringSchema,
    schema_endpoint: NonEmptyStringSchema,
    search: {
      additionalProperties: false,
      properties: {
        endpoint: NonEmptyStringSchema,
        filter_requires_single_stream: { type: "boolean" },
        scope_param: NonEmptyStringSchema,
      },
      required: ["endpoint", "scope_param", "filter_requires_single_stream"],
      type: "object",
    },
    streams_endpoint_template: NonEmptyStringSchema,
  },
  required: [
    "schema_endpoint",
    "query_base",
    "changes_since_bootstrap",
    "blob_indirection",
    "connectors_endpoint",
    "streams_endpoint_template",
  ],
  type: "object",
};

const ProtectedResourceAgentDiscoverySchema = {
  additionalProperties: false,
  properties: {
    advisory: { const: true },
    llms_full_txt: UriSchema,
    llms_txt: UriSchema,
    recommended_flow: { const: "pdpp agent" },
    skill: UriSchema,
    skill_catalog: UriSchema,
    skill_name: { const: "pdpp-data-access" },
  },
  required: ["advisory", "skill_name", "recommended_flow", "skill_catalog", "skill", "llms_txt", "llms_full_txt"],
  type: "object",
};

// Advisory trusted-owner-agent onboarding block. Emitted on `GET /` and
// `GET /.well-known/oauth-protected-resource` only when the deployment can
// support owner-agent onboarding safely (a configured public/browser origin;
// never advertised from a direct ephemeral test server even when ambient
// public-origin env vars leak in). This is non-normative reference metadata,
// NOT a PDPP Core requirement: it names the owner-level REST automation
// profile and the surfaces a trusted local owner agent needs for onboarding
// and ongoing sync, and it states that `/mcp` is not the owner-agent
// transport. See:
//   openspec/changes/add-trusted-owner-agent-onboarding/specs/reference-implementation-architecture/spec.md
// Advisory owner-agent control-surface discovery hint carried inside the
// onboarding block. Names the bearer-authed control entrypoint and the action
// families this build supports vs. defers to owner mediation / leaves
// unsupported. Reference-only vocabulary; not promoted to PDPP Core. The live
// `GET /v1/owner/control` capability document is projected from the same builder
// so discovery and the document agree. See
// openspec/changes/add-owner-agent-control-surface.
const ProtectedResourceOwnerAgentControlActionSchema = {
  additionalProperties: false,
  properties: {
    family: NonEmptyStringSchema,
    method: { type: ["string", "null"] },
    reason: NonEmptyStringSchema,
    status: { enum: ["supported", "owner_mediated", "unsupported"], type: "string" },
    url: { type: ["string", "null"] },
  },
  required: ["family", "status", "method", "url", "reason"],
  type: "object",
};

const ProtectedResourceOwnerAgentControlSurfaceSchema = {
  additionalProperties: false,
  properties: {
    actions: { items: ProtectedResourceOwnerAgentControlActionSchema, type: "array" },
    entrypoint: UriSchema,
    mcp_owner_bearer_rejected: { const: true },
    object: { const: "owner_agent_control_surface" },
    scope: { const: "reference_implementation" },
  },
  required: ["object", "entrypoint", "scope", "mcp_owner_bearer_rejected", "actions"],
  type: "object",
};

const ProtectedResourceOwnerAgentOnboardingSchema = {
  additionalProperties: false,
  properties: {
    advisory: { const: true },
    // AS issuer + RS resource origins the agent should treat as authoritative.
    authorization_server: UriSchema,
    // Owner-agent control entrypoint + action-family catalog.
    control_surface: ProtectedResourceOwnerAgentControlSurfaceSchema,
    // AS owner-credential bootstrap surfaces.
    device_authorization_endpoint: UriSchema,
    event_subscriptions_endpoint: UriSchema,
    introspection_endpoint: UriSchema,
    // The route boundary: owner bearers are REST/control-plane credentials and
    // `/mcp` rejects them. Grant-scoped MCP remains the external-client path.
    mcp_owner_bearer_rejected: { const: true },
    // Owner approval happens in a browser/dashboard context, not a token paste.
    owner_approval_url: UriSchema,
    pdpp_token_kind: { const: "owner" },
    profile: { const: "trusted_owner_agent" },
    query_base: UriSchema,
    registration_endpoint: UriSchema,
    resource: UriSchema,
    // RFC 7592 client-delete handle for the issued owner-agent credential.
    revocation_path_template: NonEmptyStringSchema,
    // Token-efficient schema view for agent discovery. The full schema remains
    // available at `schema_endpoint`; owner agents should prefer this compact
    // URL for routine metadata refreshes.
    schema_compact_endpoint: UriSchema,
    // RS discovery + ongoing-sync surfaces.
    schema_endpoint: UriSchema,
    streams_endpoint: UriSchema,
    token_endpoint: UriSchema,
    // Plain-language reminder that this credential is owner-level local
    // automation, not a grant-scoped external client.
    warning: NonEmptyStringSchema,
  },
  required: [
    "advisory",
    "profile",
    "warning",
    "authorization_server",
    "resource",
    "owner_approval_url",
    "device_authorization_endpoint",
    "token_endpoint",
    "introspection_endpoint",
    "revocation_path_template",
    "schema_endpoint",
    "schema_compact_endpoint",
    "streams_endpoint",
    "query_base",
    "mcp_owner_bearer_rejected",
    "pdpp_token_kind",
    "control_surface",
  ],
  type: "object",
};

const ProtectedResourceMetadataSchema = {
  additionalProperties: false,
  properties: {
    authorization_servers: {
      items: UriSchema,
      minItems: 1,
      type: "array",
    },
    bearer_methods_supported: {
      items: { const: "header" },
      minItems: 1,
      type: "array",
    },
    capabilities: ServerCapabilitiesSchema,
    pdpp_agent_discovery: ProtectedResourceAgentDiscoverySchema,
    pdpp_core_query_base: UriSchema,
    pdpp_discovery_hints: ProtectedResourceDiscoveryHintsSchema,
    pdpp_owner_agent_onboarding: ProtectedResourceOwnerAgentOnboardingSchema,
    pdpp_provider_connect_version: NonEmptyStringSchema,
    pdpp_self_export_supported: { type: "boolean" },
    pdpp_token_kinds_supported: {
      items: { enum: ["owner", "client"], type: "string" },
      minItems: 1,
      type: "array",
    },
    resource: UriSchema,
    resource_name: NonEmptyStringSchema,
  },
  required: [
    "resource",
    "resource_name",
    "authorization_servers",
    "bearer_methods_supported",
    "pdpp_provider_connect_version",
    "pdpp_self_export_supported",
    "pdpp_token_kinds_supported",
    "pdpp_core_query_base",
  ],
  type: "object",
};

// Cold-start discovery index. Unauthenticated `GET /` on AS and RS returns
// a tiny pointer at the next hop. See:
//   openspec/changes/polish-reference-api-discovery-seams
const DiscoveryIndexResponseSchema = {
  additionalProperties: false,
  properties: {
    links: {
      additionalProperties: false,
      properties: {
        connectors: NonEmptyStringSchema,
        core_query_base: NonEmptyStringSchema,
        schema: NonEmptyStringSchema,
        well_known: NonEmptyStringSchema,
        well_known_authorization_server: NonEmptyStringSchema,
      },
      type: "object",
    },
    object: { const: "pdpp_discovery_index" },
    // Advisory trusted-owner-agent onboarding pointer, emitted on the RS root
    // only when owner-agent onboarding is safely configured. Same advisory
    // block carried in protected-resource metadata, surfaced at the cold-start
    // root so a local owner agent can derive the flow from the entrypoint URL.
    pdpp_owner_agent_onboarding: ProtectedResourceOwnerAgentOnboardingSchema,
    reference_revision: NonEmptyStringSchema,
    resource_name: NonEmptyStringSchema,
    role: { enum: ["authorization_server", "resource_server"], type: "string" },
  },
  required: ["object", "role", "resource_name", "links", "reference_revision"],
  type: "object",
};

const DynamicClientRegistrationRequestSchema = {
  additionalProperties: false,
  properties: {
    application_type: NonEmptyStringSchema,
    client_name: NonEmptyStringSchema,
    client_uri: UriSchema,
    grant_types: { items: NonEmptyStringSchema, type: "array" },
    logo_uri: UriSchema,
    policy_uri: UriSchema,
    redirect_uris: { items: UriSchema, type: "array" },
    response_types: { items: NonEmptyStringSchema, type: "array" },
    token_endpoint_auth_method: { enum: ["none"], type: "string" },
    tos_uri: UriSchema,
  },
  type: "object",
};

const DynamicClientRegistrationResponseSchema = {
  additionalProperties: false,
  properties: {
    client_id: NonEmptyStringSchema,
    client_id_issued_at: { minimum: 0, type: "integer" },
    client_name: { type: ["string", "null"] },
    client_uri: UriSchema,
    grant_types: { items: NonEmptyStringSchema, type: "array" },
    logo_uri: UriSchema,
    policy_uri: UriSchema,
    redirect_uris: { items: UriSchema, type: "array" },
    response_types: { items: NonEmptyStringSchema, type: "array" },
    token_endpoint_auth_method: { const: "none" },
    tos_uri: UriSchema,
  },
  required: ["client_id", "client_id_issued_at", "token_endpoint_auth_method", "client_name"],
  type: "object",
};

const GrantInitiationRequestSchema = {
  additionalProperties: false,
  properties: {
    authorization_details: {
      items: AuthorizationDetailSchema,
      minItems: 1,
      type: "array",
      "x-pdpp-soft-cap": BATCH_CONSENT_STAGED_ENTRY_SOFT_CAP,
      "x-pdpp-warning-threshold": BATCH_CONSENT_STAGED_ENTRY_WARNING_THRESHOLD,
    },
    client_display: ClientDisplaySchema,
    client_id: NonEmptyStringSchema,
    scenario_id: NonEmptyStringSchema,
  },
  required: ["client_id", "authorization_details"],
  type: "object",
};

const GrantInitiationResponseSchema = {
  additionalProperties: false,
  properties: {
    authorization_url: UriSchema,
    expires_in: { minimum: 1, type: "integer" },
    request_uri: {
      pattern: "^urn:pdpp:pending-consent:",
      type: "string",
    },
  },
  required: ["request_uri", "authorization_url", "expires_in"],
  type: "object",
};

const OwnerDeviceAuthorizationRequestSchema = {
  additionalProperties: true,
  properties: {
    client_id: NonEmptyStringSchema,
  },
  required: ["client_id"],
  type: "object",
};

const OwnerDeviceAuthorizationResponseSchema = {
  additionalProperties: false,
  properties: {
    device_code: NonEmptyStringSchema,
    expires_in: { minimum: 1, type: "integer" },
    interval: { minimum: 1, type: "integer" },
    user_code: NonEmptyStringSchema,
    verification_uri: UriSchema,
    verification_uri_complete: UriSchema,
  },
  required: ["device_code", "user_code", "verification_uri", "verification_uri_complete", "expires_in", "interval"],
  type: "object",
};

const OwnerDeviceTokenRequestSchema = {
  additionalProperties: false,
  properties: {
    client_id: NonEmptyStringSchema,
    device_code: NonEmptyStringSchema,
    grant_type: { const: "urn:ietf:params:oauth:grant-type:device_code" },
  },
  required: ["grant_type", "device_code", "client_id"],
  type: "object",
};

const AuthorizationCodeTokenRequestSchema = {
  additionalProperties: false,
  properties: {
    client_id: NonEmptyStringSchema,
    code: NonEmptyStringSchema,
    code_verifier: NonEmptyStringSchema,
    grant_type: { const: "authorization_code" },
    redirect_uri: UriSchema,
  },
  required: ["grant_type", "code", "client_id", "redirect_uri", "code_verifier"],
  type: "object",
};

const RefreshTokenRequestSchema = {
  additionalProperties: false,
  properties: {
    client_id: NonEmptyStringSchema,
    grant_type: { const: "refresh_token" },
    refresh_token: NonEmptyStringSchema,
  },
  required: ["grant_type", "refresh_token", "client_id"],
  type: "object",
};

const OAuthTokenRequestSchema = {
  oneOf: [OwnerDeviceTokenRequestSchema, AuthorizationCodeTokenRequestSchema, RefreshTokenRequestSchema],
};

const AccessTokenResponseSchema = {
  additionalProperties: false,
  properties: {
    access_token: NonEmptyStringSchema,
    expires_in: { minimum: 0, type: "integer" },
    token_type: { const: "Bearer" },
  },
  required: ["access_token", "token_type", "expires_in"],
  type: "object",
};

const HostedMcpTokenResponseSchema = {
  additionalProperties: false,
  properties: {
    access_token: NonEmptyStringSchema,
    grant_id: NonEmptyStringSchema,
    refresh_token: NonEmptyStringSchema,
    token_type: { const: "Bearer" },
  },
  required: ["access_token", "token_type", "grant_id"],
  type: "object",
};

const OAuthTokenResponseSchema = {
  oneOf: [AccessTokenResponseSchema, HostedMcpTokenResponseSchema],
};

const IntrospectionRequestSchema = {
  additionalProperties: false,
  properties: {
    token: NonEmptyStringSchema,
  },
  required: ["token"],
  type: "object",
};

const IntrospectionResponseSchema = {
  additionalProperties: true,
  properties: {
    active: { type: "boolean" },
    client_id: NonEmptyStringSchema,
    exp: { type: ["integer", "null"] },
    grant: GrantSchema,
    grant_id: NonEmptyStringSchema,
    inactive_reason: NonEmptyStringSchema,
    pdpp_token_kind: {
      description:
        'Core defines "owner" and "client". Deployments MAY introduce additional token kinds in companion profiles (the reference emits "mcp_package"). A resource server that receives a pdpp_token_kind value it does not recognize MUST treat the token as unauthorized for all operations defined in Core.',
      type: "string",
    },
    scenario_id: NonEmptyStringSchema,
    subject_id: { type: "string" },
    trace_id: NonEmptyStringSchema,
  },
  required: ["active"],
  type: "object",
};

const GrantApprovalResponseSchema = {
  additionalProperties: false,
  properties: {
    grant: GrantSchema,
    grant_id: NonEmptyStringSchema,
    token: NonEmptyStringSchema,
  },
  required: ["grant_id", "token", "grant"],
  type: "object",
};

const RevokeGrantResponseSchema = {
  additionalProperties: false,
  properties: {
    revoked: { const: true },
  },
  required: ["revoked"],
  type: "object",
};

const RecordSchema = {
  additionalProperties: true,
  properties: {
    connection_id: ConnectionIdSchema,
    connector_instance_id: ConnectorInstanceIdAliasSchema,
    data: { additionalProperties: true, type: "object" },
    deleted: { type: "boolean" },
    deleted_at: { type: "string" },
    display_name: ConnectionDisplayNameSchema,
    emitted_at: { type: "string" },
    expanded: { additionalProperties: true, type: "object" },
    id: { type: "string" },
    object: { const: "record" },
    // Logical byte length of this record's current `record_json`. Only
    // populated on the single-record-detail read (`GET .../records/{id}`) —
    // list responses do not carry this field. Absent, never `0`, when
    // unmeasured.
    record_json_bytes: { minimum: 0, type: "integer" },
    stream: { type: "string" },
  },
  required: ["object", "id", "stream"],
  type: "object",
};

const RecordsListResponseSchema = {
  additionalProperties: true,
  properties: {
    ...ListEnvelopeSchema(RecordSchema).properties,
    freshness: FreshnessSchema,
    // Canonical envelope meta block: opt-in `count`, opt-in bounded `window`
    // (`total` + logical `earliest_at`/`latest_at`), and structured
    // `warnings`. Declared explicitly so the additive `meta.window` shape is
    // part of the published contract rather than riding unvalidated on
    // `additionalProperties: true`. Spec:
    //   openspec/changes/complete-explorer-slvp-ideal/specs/
    //   reference-implementation-architecture/spec.md.
    meta: MetaSchema,
    next_changes_since: { type: "string" },
    url: { type: "string" },
  },
  required: ["object", "data", "has_more"],
  type: "object",
};

const AggregationResponseSchema = {
  additionalProperties: false,
  properties: {
    // `true` only when an accelerated path estimates the metric (e.g. a future
    // HyperLogLog `count_distinct`). The reference floor is exact and reports
    // `false`.
    approximate: { type: "boolean" },
    field: { type: ["string", "null"] },
    filtered_record_count: { minimum: 0, type: "integer" },
    granularity: { enum: [...AGGREGATE_GRANULARITIES, null], type: ["string", "null"] },
    group_by: { type: ["string", "null"] },
    // Additive time-bucket fields. `null` for non-time aggregations so
    // existing payloads stay compatible. See:
    //   openspec/changes/add-aggregate-time-buckets-and-distinct
    group_by_time: { type: ["string", "null"] },
    groups: {
      items: {
        additionalProperties: false,
        properties: {
          count: { minimum: 0, type: "integer" },
          key: { type: ["string", "number", "integer", "boolean", "null"] },
        },
        required: ["key", "count"],
        type: "object",
      },
      type: "array",
    },
    limit: { maximum: 100, minimum: 1, type: "integer" },
    metric: { enum: ["count", "sum", "min", "max", "count_distinct"], type: "string" },
    object: { const: "aggregation" },
    // Sum of counts for groups/buckets truncated by `limit`. Emitted whenever
    // a grouped response is returned (zero when all groups fit; present but 0
    // is explicit confirmation that no records were dropped). Omitted for
    // ungrouped aggregations. See:
    //   openspec/changes/add-aggregate-other-rollup
    other_count: { minimum: 0, type: "integer" },
    stream: { type: "string" },
    time_zone: { type: ["string", "null"] },
    value: { type: ["number", "integer", "string", "null"] },
  },
  required: ["object", "stream", "metric", "filtered_record_count"],
  type: "object",
};

const StreamListResponseSchema = {
  additionalProperties: true,
  properties: {
    data: {
      items: {
        additionalProperties: true,
        properties: {
          connection_id: ConnectionIdSchema,
          connector_instance_id: ConnectorInstanceIdAliasSchema,
          display_name: ConnectionDisplayNameSchema,
          freshness: FreshnessSchema,
          last_updated: { type: ["string", "null"] },
          name: { type: "string" },
          object: { const: "stream" },
          record_count: { type: "integer" },
        },
        required: ["object", "name"],
        type: "object",
      },
      type: "array",
    },
    object: { const: "list" },
  },
  required: ["object", "data"],
  type: "object",
};

const ConnectorListResponseSchema = {
  additionalProperties: true,
  properties: {
    data: {
      items: {
        additionalProperties: true,
        properties: {
          connector_id: { type: "string" },
          object: { const: "connector" },
          source: { additionalProperties: true, type: "object" },
          stream_count: { type: "integer" },
          streams: {
            items: {
              additionalProperties: true,
              properties: {
                capabilities: { additionalProperties: true, type: "object" },
                freshness: FreshnessSchema,
                last_updated: { type: ["string", "null"] },
                name: { type: "string" },
                object: { const: "stream" },
                record_count: { type: "integer" },
              },
              required: ["object", "name"],
              type: "object",
            },
            type: "array",
          },
        },
        required: ["object", "source", "stream_count", "streams"],
        type: "object",
      },
      type: "array",
    },
    object: { const: "list" },
  },
  required: ["object", "data"],
  type: "object",
};

const CompactFieldCapabilityFlagsSchema = {
  description:
    "Compact schema-view capability flags. Comma-separated tokens preserve declared type, grant status, and usable exact/range/lexical/semantic/aggregation capabilities without embedding the full per-field JSON Schema.",
  minLength: 1,
  type: "string",
};

const StreamMetadataResponseSchema = {
  additionalProperties: true,
  properties: {
    consent_time_field: { type: ["string", "null"] },
    cursor_field: { type: ["string", "null"] },
    expand_capabilities: {
      items: {
        additionalProperties: false,
        properties: {
          cardinality: { enum: ["has_one", "has_many"], type: "string" },
          // The field on the child (target) record whose value holds the parent
          // record's key — the field the server filters on as
          // `WHERE child.<field> = <parent record key>` during hydration. This is
          // the same field the manifest declares as `foreign_key`; it is NOT the
          // child's own record key. Required.
          child_parent_key_field: NonEmptyStringSchema,
          default_limit: { minimum: 1, type: "integer" },
          // Back-compat alias for `child_parent_key_field`, carrying the identical
          // value. New readers SHOULD prefer `child_parent_key_field`.
          foreign_key: NonEmptyStringSchema,
          granted: { type: "boolean" },
          max_limit: { minimum: 1, type: "integer" },
          name: NonEmptyStringSchema,
          // Present on `usable: false` entries. Enumerated reasons a declared
          // relation is not usable under the current request:
          //   - `related_stream_not_granted` — target stream outside the grant
          //     (the value the server already emits today);
          //   - `related_stream_unknown` — target stream absent from the loaded
          //     manifest;
          //   - `related_stream_not_loaded` — target stream declared but not
          //     loaded at request time.
          // Additive: a future grant/projection failure mode may add an enum
          // member without breaking existing readers.
          reason: {
            enum: ["related_stream_not_granted", "related_stream_unknown", "related_stream_not_loaded"],
            type: "string",
          },
          relation: NonEmptyStringSchema,
          // `stream` is the historical name for the related child stream. It is
          // retained for back-compat and carries the same value as
          // `target_stream`.
          stream: NonEmptyStringSchema,
          // The related child stream the forward relation points at. Required so
          // a reader never has to infer "is `stream` the parent or the child?".
          target_stream: NonEmptyStringSchema,
          usable: { type: "boolean" },
        },
        required: ["name", "stream", "target_stream", "cardinality", "child_parent_key_field", "granted", "usable"],
        type: "object",
      },
      type: "array",
    },
    field_capabilities: {
      additionalProperties: {
        oneOf: [
          CompactFieldCapabilityFlagsSchema,
          {
            additionalProperties: false,
            properties: {
              aggregation: {
                additionalProperties: false,
                properties: {
                  count_distinct: CapabilityFlagSchema,
                  group_by: CapabilityFlagSchema,
                  group_by_time: CapabilityFlagSchema,
                  max: CapabilityFlagSchema,
                  min: CapabilityFlagSchema,
                  sum: CapabilityFlagSchema,
                },
                required: ["sum", "min", "max", "group_by", "group_by_time", "count_distinct"],
                type: "object",
              },
              exact_filter: CapabilityFlagSchema,
              granted: { type: "boolean" },
              lexical_search: CapabilityFlagSchema,
              range_filter: {
                additionalProperties: false,
                properties: {
                  declared: { type: "boolean" },
                  operators: { items: NonEmptyStringSchema, type: "array" },
                  reason: { type: "string" },
                  usable: { type: "boolean" },
                },
                required: ["declared", "usable"],
                type: "object",
              },
              // Optional declared presentation ROLE (which CARD SLOT this field
              // fills), sourced from the manifest JSON Schema extension
              // (`schema.properties[field].x_pdpp_role`). Distinct from `type`
              // (which gates formatting): a `text` field is the title ONLY when its
              // role is declared `primary-title`. Additive, optional, presentation-
              // only — it SHALL NOT influence filter, search, aggregation, grant,
              // projection, identity, cursor, ingestion, or retrieval. Absence =
              // "no declared role" → the consumer renders the honest generic
              // fallback, never a field-name guess.
              role: { minLength: 1, type: "string" },
              schema: { additionalProperties: true, type: "object" },
              semantic_search: CapabilityFlagSchema,
              // Optional declared presentation type sourced from the stream
              // manifest. Implementations may declare it as a JSON Schema
              // extension (`schema.properties[field].x_pdpp_type`) or through
              // the sandbox-shaped field declaration array (`fields[]` or
              // `schema.fields[]` with `{ name, type, semantic_class }`).
              // Additive and optional: omitted when the manifest does not
              // declare it, and a consumer SHALL treat the absence as "not
              // declared". This is a presentation/dispatch hint only; it is
              // never client-writable or grantable.
              type: { minLength: 1, type: "string" },
            },
            required: [
              "schema",
              "granted",
              "exact_filter",
              "range_filter",
              "lexical_search",
              "semantic_search",
              "aggregation",
            ],
            type: "object",
          },
        ],
      },
      type: "object",
    },
    freshness: FreshnessSchema,
    granted_connections: {
      description:
        "Connections the caller's grant authorizes for this stream under the addressed connector. Clients MAY pass any `connection_id` here on a subsequent read to scope without trial-and-error. Omitted for provider-native sources where connection identity does not apply.",
      items: GrantedConnectionSchema,
      type: "array",
    },
    name: { type: "string" },
    object: { const: "stream_metadata" },
    primary_key: { items: { type: "string" }, type: "array" },
    query: {
      additionalProperties: false,
      properties: {
        aggregations: {
          additionalProperties: false,
          properties: {
            count: { const: true },
            count_distinct: { items: { type: "string" }, type: "array" },
            group_by: { items: { type: "string" }, type: "array" },
            // Declared date/date-time fields the stream supports for
            // `group_by_time` calendar bucketing, and declared scalar fields
            // it supports for `count_distinct`. See:
            //   openspec/changes/add-aggregate-time-buckets-and-distinct
            group_by_time: { items: { type: "string" }, type: "array" },
            max: { items: { type: "string" }, type: "array" },
            min: { items: { type: "string" }, type: "array" },
            sum: { items: { type: "string" }, type: "array" },
          },
          type: "object",
        },
        expand: { type: "array" },
        range_filters: { type: "object" },
      },
      type: "object",
    },
    relationships: { type: "array" },
    schema: { type: "object" },
    selection: { type: "object" },
    views: { type: "array" },
  },
  required: ["object", "name", "field_capabilities", "expand_capabilities"],
  type: "object",
};

const SchemaResponseSchema = {
  additionalProperties: false,
  properties: {
    bearer: {
      additionalProperties: false,
      properties: {
        client_id: { type: "string" },
        grant_id: { type: "string" },
        scope: { enum: ["owner", "grant"], type: "string" },
        token_kind: { enum: ["owner", "client"], type: "string" },
      },
      required: ["token_kind", "scope"],
      type: "object",
    },
    connectors: {
      items: {
        additionalProperties: false,
        properties: {
          connector_id: { type: "string" },
          object: { const: "connector" },
          source: { additionalProperties: true, type: "object" },
          stream_count: { minimum: 0, type: "integer" },
          streams: {
            items: StreamMetadataResponseSchema,
            type: "array",
          },
        },
        required: ["object", "source", "stream_count", "streams"],
        type: "object",
      },
      type: "array",
    },
    detail: {
      description: "Present only when `GET /v1/schema?view=compact` returned the compact projection.",
      enum: ["compact"],
      type: "string",
    },
    object: { const: "schema" },
  },
  required: ["object", "bearer", "connectors"],
  type: "object",
};

const SchemaQuerySchema = {
  // Existing schema callers may pass legacy owner polyfill selectors such as
  // `connector_id`; keep request validation permissive while documenting the
  // token-efficient selector names agents should prefer.
  additionalProperties: true,
  properties: {
    connector_id: {
      description: "Optional owner-polyfill source hint for runtimes that expose multiple connector templates.",
      type: "string",
    },
    stream: {
      description:
        "When used with `view=compact`, narrows the schema document to connectors that contribute this stream.",
      type: "string",
    },
    view: {
      description:
        "Set `view=compact` to return the token-efficient schema projection. Omitted or any other value returns the full schema body.",
      type: "string",
    },
  },
  type: "object",
};

const AuthHeaderSchema = {
  additionalProperties: true,
  properties: {
    authorization: { pattern: "^Bearer ", type: "string" },
  },
  required: ["authorization"],
  type: "object",
};

// Typed `ambiguous_connection` error envelope. Emitted by `getRecord` and
// `getBlob` when the addressed record or blob identifier resolves to more
// than one connection under the caller's grant and the client did not pass
// `connection_id`. The envelope lists the candidate connections inline so
// the client can retry without an extra round trip. List/search operations
// never raise this error — they fan in instead.
const AmbiguousConnectionErrorSchema = {
  additionalProperties: false,
  properties: {
    error: {
      additionalProperties: false,
      properties: {
        available_connections: {
          items: AvailableConnectionSchema,
          minItems: 2,
          type: "array",
        },
        code: { const: "ambiguous_connection" },
        message: { type: "string" },
        param: { type: "string" },
        request_id: { type: "string" },
        retry_with: {
          additionalProperties: false,
          properties: {
            field: { const: "connection_id" },
            guidance: { type: "string" },
          },
          required: ["field", "guidance"],
          type: "object",
        },
        type: { type: "string" },
      },
      required: ["type", "code", "message", "request_id", "available_connections", "retry_with"],
      type: "object",
    },
  },
  required: ["error"],
  type: "object",
};

const ProtectedReadErrors = {
  400: { description: "Invalid request", schema: ErrorObjectSchema },
  401: { description: "Missing or invalid access token", schema: ErrorObjectSchema },
  403: { description: "Grant does not permit this request", schema: ErrorObjectSchema },
  404: { description: "Stream or record not found", schema: ErrorObjectSchema },
};

const ProtectedReadWithAmbiguityErrors = {
  ...ProtectedReadErrors,
  409: {
    description:
      "Identifier resolves to more than one connection under the caller's grant. Retry with the `connection_id` listed in `error.available_connections`.",
    schema: AmbiguousConnectionErrorSchema,
  },
};

const ListRecordErrors = {
  ...ProtectedReadErrors,
  410: { description: "Cursor expired", schema: ErrorObjectSchema },
};

const OAuthFlowErrors = {
  400: { description: "OAuth request rejected", schema: OAuthErrorSchema },
};

// Client event-subscription management. A reference-implementation extension
// (discoverable via `pdpp_provider_connect_capabilities` /
// `capabilities.event_subscriptions`) letting an active client subscribe its
// callback URL to CloudEvents-shaped, Standard-Webhooks-signed delivery of
// record changes scoped to its grant. See:
//   openspec/specs/reference-implementation-architecture/spec.md
//   openspec/changes/archive/2026-05-28-add-client-event-subscription-management
const EventSubscriptionStatusSchema = {
  enum: ["pending_verification", "active", "disabled", "disabled_failure", "disabled_revoked", "deleted"],
  type: "string",
};

const EventSubscriptionIdPathSchema = {
  additionalProperties: false,
  properties: { subscription_id: NonEmptyStringSchema },
  required: ["subscription_id"],
  type: "object",
};

// The grant-resolved scope echoed back on read. `streams` is the resolved set
// of grant-scoped stream targets; `filters` echoes the caller-supplied stream
// filter when present.
const EventSubscriptionScopeSchema = {
  additionalProperties: false,
  properties: {
    filters: {
      additionalProperties: false,
      properties: {
        streams: { items: NonEmptyStringSchema, type: "array" },
      },
      type: "object",
    },
    streams: {
      items: {
        additionalProperties: false,
        properties: {
          connection_id: { type: "string" },
          name: NonEmptyStringSchema,
        },
        required: ["name"],
        type: "object",
      },
      type: "array",
    },
  },
  required: ["streams"],
  type: "object",
};

// Client-facing projection of a subscription. Never carries the signing
// secret; the secret is returned only inline on create and secret rotation.
const EventSubscriptionSchema = {
  additionalProperties: false,
  properties: {
    callback_url: { format: "uri", type: "string" },
    client_id: NonEmptyStringSchema,
    created_at: { format: "date-time", type: "string" },
    disabled_reason: { type: ["string", "null"] },
    grant_id: NonEmptyStringSchema,
    scope: EventSubscriptionScopeSchema,
    status: EventSubscriptionStatusSchema,
    subscription_id: NonEmptyStringSchema,
    updated_at: { format: "date-time", type: "string" },
  },
  required: [
    "subscription_id",
    "grant_id",
    "client_id",
    "callback_url",
    "status",
    "scope",
    "created_at",
    "updated_at",
    "disabled_reason",
  ],
  type: "object",
};

const CreateEventSubscriptionBodySchema = {
  additionalProperties: false,
  properties: {
    callback_url: {
      description:
        "HTTPS endpoint that will receive CloudEvents 1.0 structured-mode JSON POST requests signed with Standard Webhooks headers. `http://localhost` is accepted for development.",
      format: "uri",
      maxLength: 2048,
      type: "string",
    },
    filters: {
      additionalProperties: false,
      properties: {
        streams: {
          description:
            "Subset of grant-scoped stream names to subscribe to. Omit to subscribe to all streams in the grant.",
          items: NonEmptyStringSchema,
          type: "array",
        },
      },
      type: "object",
    },
  },
  required: ["callback_url"],
  type: "object",
};

const CreateEventSubscriptionResponseSchema = {
  additionalProperties: false,
  properties: {
    callback_url: { format: "uri", type: "string" },
    created_at: { format: "date-time", type: "string" },
    secret: {
      description:
        "Standard Webhooks HMAC signing secret (`whsec_<base64>`). Store securely; returned only on creation and on secret rotation.",
      type: "string",
    },
    status: EventSubscriptionStatusSchema,
    subscription_id: NonEmptyStringSchema,
  },
  required: ["subscription_id", "secret", "status", "callback_url", "created_at"],
  type: "object",
};

const ListEventSubscriptionsResponseSchema = {
  additionalProperties: false,
  properties: {
    data: { items: EventSubscriptionSchema, type: "array" },
  },
  required: ["data"],
  type: "object",
};

const UpdateEventSubscriptionBodySchema = {
  additionalProperties: false,
  properties: {
    enabled: {
      description:
        "Set to `false` to disable delivery; `true` to re-enable a `disabled` or `disabled_failure` subscription. Cannot re-enable a `disabled_revoked` subscription.",
      type: "boolean",
    },
    rotate_secret: {
      description:
        "Generate a new `whsec_*` signing secret. The new secret is returned in the response body. The old secret is immediately invalid.",
      type: "boolean",
    },
  },
  type: "object",
};

const UpdateEventSubscriptionResponseSchema = {
  additionalProperties: false,
  properties: {
    secret: {
      description:
        "New Standard Webhooks signing secret (`whsec_<base64>`). Present only when `rotate_secret` was `true`.",
      type: "string",
    },
    subscription: EventSubscriptionSchema,
  },
  required: ["subscription"],
  type: "object",
};

const SendTestEventResponseSchema = {
  additionalProperties: false,
  properties: {
    event_id: NonEmptyStringSchema,
  },
  required: ["event_id"],
  type: "object",
};

// Event subscriptions require an explicit subscription authority: either a
// client_grant bearer for an active grant or a registered trusted_owner_agent
// bearer. Unregistered owner bearers are rejected.
const EventSubscriptionAuthErrors = {
  401: { description: "Bearer token missing or invalid", schema: ErrorObjectSchema },
  403: {
    description:
      "Bearer token is authenticated but is neither a `client_grant` authority for an active grant nor a registered `trusted_owner_agent` authority; unregistered owner bearers are rejected.",
    schema: ErrorObjectSchema,
  },
};

const EventSubscriptionNotFoundError = {
  404: { description: "Subscription not found or not owned by the bearer", schema: ErrorObjectSchema },
};

export const publicManifests = [
  {
    id: "getRsDiscoveryIndex",
    method: "GET",
    path: "/",
    responses: {
      200: { schema: DiscoveryIndexResponseSchema },
    },
    summary:
      "Unauthenticated cold-start pointer at the resource server root. Names the well-known endpoint, the `/v1/schema` capability discovery surface, the core query base, and the running reference revision so a probe learns the next hop without trial-and-error.",
    surface: "public",
    tags: ["metadata"],
  },
  {
    // The AS exposes the same discovery shape on its own root with a smaller
    // link set (well_known_authorization_server only). We register a
    // distinct manifest id for the AS surface so the contract registry
    // maintains a 1:1 map between operation ids and route bindings; the
    // generated OpenAPI document deduplicates the two `GET /` entries to
    // avoid a path collision (see openapi/generate.ts).
    id: "getAsDiscoveryIndex",
    method: "GET",
    path: "/",
    responses: {
      200: { schema: DiscoveryIndexResponseSchema },
    },
    summary:
      "Unauthenticated cold-start pointer at the authorization server root. Names the AS well-known endpoint and the running reference revision so a probe learns the next hop without trial-and-error.",
    surface: "public",
    tags: ["metadata"],
  },
  {
    id: "getAuthorizationServerMetadata",
    method: "GET",
    path: "/.well-known/oauth-authorization-server",
    responses: {
      200: { schema: AuthorizationServerMetadataSchema },
    },
    summary: "Return RFC 8414 authorization-server metadata with the reference provider-connect capability extensions.",
    surface: "public",
    tags: ["metadata", "oauth"],
  },
  {
    id: "getProtectedResourceMetadata",
    method: "GET",
    path: "/.well-known/oauth-protected-resource",
    responses: {
      200: { schema: ProtectedResourceMetadataSchema },
    },
    summary:
      "Return RFC 9728 protected-resource metadata advertising the PDPP query base, owner-self-export, advisory `pdpp_agent_discovery` / `pdpp_owner_agent_onboarding` when safely configured, and capabilities such as `client_event_subscriptions`.",
    surface: "public",
    tags: ["metadata"],
  },
  {
    id: "getMcpProtectedResourceMetadata",
    method: "GET",
    path: "/.well-known/oauth-protected-resource/mcp",
    responses: {
      200: { schema: ProtectedResourceMetadataSchema },
    },
    summary: "Return RFC 9728 protected-resource metadata for the hosted MCP endpoint.",
    surface: "public",
    tags: ["metadata", "mcp", "oauth"],
  },
  {
    id: "registerDynamicClient",
    method: "POST",
    path: "/oauth/register",
    request: {
      body: {
        contentType: "application/json",
        schema: DynamicClientRegistrationRequestSchema,
      },
    },
    responses: {
      201: { description: "Client registered", schema: DynamicClientRegistrationResponseSchema },
      400: { description: "Invalid client metadata", schema: OAuthErrorSchema },
      401: { description: "Missing or invalid initial access token", schema: OAuthErrorSchema },
      404: { description: "Dynamic client registration is disabled", schema: OAuthErrorSchema },
    },
    summary: "Register a public client through the reference dynamic client registration profile.",
    surface: "public",
    tags: ["oauth"],
  },
  {
    id: "createPushedAuthorizationRequest",
    method: "POST",
    path: "/oauth/par",
    request: {
      body: {
        contentType: "application/json",
        schema: GrantInitiationRequestSchema,
      },
    },
    responses: {
      201: { description: "Pending consent request created", schema: GrantInitiationResponseSchema },
      400: { description: "Invalid request", schema: ErrorObjectSchema },
      403: {
        description: "Request rejected because the resolved grant contract is invalid",
        schema: ErrorObjectSchema,
      },
    },
    summary: "Stage a PDPP data-access request and receive a pending-consent request_uri plus authorization URL.",
    surface: "public",
    tags: ["grants"],
  },
  {
    id: "approveConsent",
    method: "POST",
    path: "/consent/approve",
    request: {
      body: {
        contentType: "application/json",
        schema: {
          additionalProperties: false,
          properties: {
            ai_training_consented: { type: "boolean" },
            approved_source_indexes: {
              oneOf: [
                { minimum: 0, type: "integer" },
                { pattern: "^[0-9]+$", type: "string" },
                {
                  items: {
                    oneOf: [
                      { minimum: 0, type: "integer" },
                      { pattern: "^[0-9]+$", type: "string" },
                    ],
                  },
                  type: "array",
                },
              ],
            },
            confirm_approve_all: {
              oneOf: [{ type: "boolean" }, { enum: ["true", "1", "on"], type: "string" }],
            },
            request_uri: NonEmptyStringSchema,
            subject_id: NonEmptyStringSchema,
          },
          required: ["request_uri"],
          type: "object",
        },
      },
    },
    responses: {
      200: { description: "Grant approved and client token issued", schema: GrantApprovalResponseSchema },
      400: { description: "Invalid request", schema: ErrorObjectSchema },
      403: { description: "Grant is malformed or no longer valid", schema: ErrorObjectSchema },
      404: { description: "Pending consent request not found", schema: ErrorObjectSchema },
    },
    summary: "Approve a pending data-access request through the JSON consent surface used by tests and automation.",
    surface: "public",
    tags: ["grants"],
  },
  {
    id: "exchangeConsentCode",
    method: "POST",
    path: "/consent/exchange",
    request: {
      body: {
        contentType: "application/json",
        schema: {
          additionalProperties: false,
          properties: {
            code: NonEmptyStringSchema,
          },
          required: ["code"],
          type: "object",
        },
      },
    },
    responses: {
      200: { description: "Exchange code redeemed and client token issued", schema: GrantApprovalResponseSchema },
      400: { description: "Invalid request", schema: ErrorObjectSchema },
      404: { description: "Unknown exchange code", schema: ErrorObjectSchema },
      410: { description: "Exchange code expired or already redeemed", schema: ErrorObjectSchema },
    },
    summary:
      "Redeem a short-lived single-use consent exchange code from the hosted HTML consent flow for the client token.",
    surface: "public",
    tags: ["grants"],
  },
  {
    id: "startOwnerDeviceAuthorization",
    method: "POST",
    path: "/oauth/device_authorization",
    request: {
      body: {
        contentType: "application/x-www-form-urlencoded",
        schema: OwnerDeviceAuthorizationRequestSchema,
      },
    },
    responses: {
      200: { schema: OwnerDeviceAuthorizationResponseSchema },
      ...OAuthFlowErrors,
    },
    summary: "Start the owner device flow used for owner-self-export and dashboard bootstrap.",
    surface: "public",
    tags: ["oauth"],
  },
  {
    id: "exchangeOwnerDeviceToken",
    method: "POST",
    path: "/oauth/token",
    request: {
      body: {
        contentType: "application/x-www-form-urlencoded",
        schema: OAuthTokenRequestSchema,
      },
    },
    responses: {
      200: { schema: OAuthTokenResponseSchema },
      ...OAuthFlowErrors,
      500: { description: "Server error while exchanging the device code", schema: OAuthErrorSchema },
    },
    summary: "Exchange an OAuth device code, authorization code, or refresh token for a bearer token.",
    surface: "public",
    tags: ["oauth"],
  },
  {
    id: "introspectToken",
    method: "POST",
    path: "/introspect",
    request: {
      body: {
        contentType: "application/x-www-form-urlencoded",
        schema: IntrospectionRequestSchema,
      },
    },
    responses: {
      200: { schema: IntrospectionResponseSchema },
      400: { description: "Missing token parameter", schema: ErrorObjectSchema },
    },
    summary: "Inspect token activity and, for active client tokens, the bound grant projection.",
    surface: "public",
    tags: ["oauth"],
  },
  {
    id: "revokeGrant",
    method: "POST",
    path: "/grants/{grantId}/revoke",
    request: {
      params: GrantIdPathSchema,
    },
    responses: {
      200: { schema: RevokeGrantResponseSchema },
      403: { description: "Grant is malformed or no longer valid", schema: ErrorObjectSchema },
    },
    summary: "Revoke a grant and all tokens minted from it.",
    surface: "public",
    tags: ["grants"],
  },
  {
    id: "listConnectors",
    method: "GET",
    path: "/v1/connectors",
    request: {
      headers: AuthHeaderSchema,
    },
    responses: {
      200: { schema: ConnectorListResponseSchema },
      ...ProtectedReadErrors,
    },
    summary:
      "List connector or source boundaries visible under the bearer token, with stream summaries and coarse capability hints.",
    surface: "public",
    tags: ["records"],
  },
  {
    id: "getSchema",
    method: "GET",
    path: "/v1/schema",
    request: {
      headers: AuthHeaderSchema,
      query: SchemaQuerySchema,
    },
    responses: {
      200: { schema: SchemaResponseSchema },
      ...ProtectedReadErrors,
    },
    summary:
      "Return the caller-visible source/stream capability graph. Use `view=compact` and optional `stream=<name>` for a token-efficient agent discovery step; omitted `view` returns the full schema, query declarations, field capabilities, expand capabilities, and freshness.",
    surface: "public",
    tags: ["records"],
  },
  {
    id: "listStreams",
    method: "GET",
    path: "/v1/streams",
    request: {
      headers: AuthHeaderSchema,
      query: {
        additionalProperties: false,
        properties: {
          connection_id: ConnectionIdSchema,
          connector_id: { type: "string" },
          connector_instance_id: ConnectorInstanceIdAliasSchema,
          subject_id: { type: "string" },
        },
        type: "object",
      },
    },
    responses: {
      200: { schema: StreamListResponseSchema },
      ...ProtectedReadErrors,
    },
    summary:
      "List streams available under the current grant or owner scope. Returns stream-level totals only; for per-field filter capabilities (exact, range operators, aggregation) call `GET /v1/schema` first and consult `field_capabilities` per stream before issuing `filter[...]` queries on `/v1/streams/{stream}/records`. Multi-connection deployments emit one entry per (stream, connection_id); each entry carries `connection_id` and a `display_name` so callers can attribute and disambiguate.",
    surface: "public",
    tags: ["records"],
  },
  {
    id: "getStreamMetadata",
    method: "GET",
    path: "/v1/streams/{stream}",
    request: {
      headers: AuthHeaderSchema,
      params: StreamNamePathSchema,
      query: {
        additionalProperties: false,
        properties: {
          connection_id: ConnectionIdSchema,
          connector_id: { type: "string" },
          connector_instance_id: ConnectorInstanceIdAliasSchema,
          subject_id: { type: "string" },
        },
        type: "object",
      },
    },
    responses: {
      200: { schema: StreamMetadataResponseSchema },
      ...ProtectedReadErrors,
    },
    summary:
      "Return stream metadata including declared query capabilities and advisory freshness. For per-field filter capabilities on this stream (exact, range operators, aggregation), prefer `GET /v1/schema` first and read `field_capabilities` rather than guessing `filter[...]` shapes against the records endpoint. Pass `connection_id` (or the deprecated `connector_instance_id` alias) to restrict to a single connection; omitted, the response aggregates across the connections the grant authorizes.",
    surface: "public",
    tags: ["records"],
  },
  {
    id: "listRecords",
    method: "GET",
    path: "/v1/streams/{stream}/records",
    request: {
      headers: AuthHeaderSchema,
      params: StreamNamePathSchema,
      query: ListRecordsQuerySchema,
    },
    responses: {
      200: { schema: RecordsListResponseSchema },
      ...ListRecordErrors,
    },
    summary:
      "List records in a stream under grant enforcement. Supports logical-cursor pagination, exact and declared range filters, declared one-hop expansion, and changes_since. Per-field filter operators, sortable fields, expandable relations, projection, search modes, and count support are advertised by `GET /v1/schema` (`field_capabilities`, `expand_capabilities`); consult it before issuing `filter[...]`, `expand[]`, or `fields=` shapes to avoid 400 errors. Pass `connection_id` to restrict to one connection; the deprecated `connector_instance_id` alias is accepted for compatibility but new clients SHOULD use `connection_id`.",
    surface: "public",
    tags: ["records"],
  },
  {
    id: "aggregateStream",
    method: "GET",
    path: "/v1/streams/{stream}/aggregate",
    request: {
      headers: AuthHeaderSchema,
      params: StreamNamePathSchema,
      query: AggregateQuerySchema,
    },
    responses: {
      200: { schema: AggregationResponseSchema },
      ...ProtectedReadErrors,
    },
    summary:
      "Compute a single-stream grant-safe aggregation. Supports count, numeric sum, numeric/date min/max, exact count_distinct, scalar grouped counts (`group_by`), calendar time-bucket counts (`group_by_time`+`granularity`, optional `time_zone` defaulting to UTC), and existing exact/range filters over declared fields. Exactly one grouping dimension per call: `group_by` XOR `group_by_time`. Grouped responses include `other_count` (sum of counts for groups/buckets beyond `limit`) so callers can detect truncation without a second round trip.",
    surface: "public",
    tags: ["records"],
  },
  {
    id: "getRecord",
    method: "GET",
    path: "/v1/streams/{stream}/records/{id}",
    request: {
      headers: AuthHeaderSchema,
      params: RecordIdPathSchema,
      query: {
        additionalProperties: false,
        properties: {
          connection_id: ConnectionIdSchema,
          connector_id: { type: "string" },
          connector_instance_id: ConnectorInstanceIdAliasSchema,
          expand: { items: { type: "string" }, type: "array" },
          expand_limit: { type: "object" },
          subject_id: { type: "string" },
        },
        type: "object",
      },
    },
    responses: {
      200: { schema: RecordSchema },
      ...ProtectedReadWithAmbiguityErrors,
    },
    summary:
      "Fetch a single record by primary key under grant enforcement, with optional declared one-hop expansion. Expandable relations and the per-relation `expand_limit` ceiling are advertised by `GET /v1/schema` (`expand_capabilities`); requesting an unadvertised relation is rejected rather than silently ignored. When the identifier resolves to more than one connection under the caller's grant and `connection_id` is omitted, returns a typed `ambiguous_connection` (409) error with `available_connections` and retry guidance instead of silently picking one. The deprecated `connector_instance_id` alias is accepted for compatibility but new clients SHOULD use `connection_id`.",
    surface: "public",
    tags: ["records"],
  },
  {
    id: "searchRecordsLexical",
    method: "GET",
    path: "/v1/search",
    request: {
      headers: AuthHeaderSchema,
      // additionalProperties: false locks the v1 param allowlist at the schema
      // layer in addition to the runtime check in search.js. connector_id is
      // intentionally NOT in the allowlist — owner-mode search is
      // cross-connector with no public connector-scope param. See:
      //   openspec/changes/add-lexical-retrieval-extension/specs/lexical-retrieval/spec.md
      // `connection_id` (and the deprecated `connector_instance_id` alias)
      // are additive optional filters under
      //   openspec/changes/expose-connection-identity-on-public-read.
      // Omitted, results fan in across all connections the grant authorizes
      // for each named stream; each hit carries `connection_id` for
      // attribution.
      query: {
        additionalProperties: false,
        properties: {
          connection_id: ConnectionIdSchema,
          connector_instance_id: ConnectorInstanceIdAliasSchema,
          cursor: CursorSchema,
          filter: {
            additionalProperties: true,
            type: "object",
          },
          limit: { maximum: 100, minimum: 1, type: "integer" },
          q: NonEmptyStringSchema,
          streams: {
            anyOf: [NonEmptyStringSchema, { items: NonEmptyStringSchema, minItems: 1, type: "array" }],
          },
        },
        required: ["q"],
        type: "object",
      },
    },
    responses: {
      200: {
        schema: {
          additionalProperties: true,
          properties: {
            data: {
              items: {
                additionalProperties: true,
                properties: {
                  connection_id: ConnectionIdSchema,
                  connector_id: NonEmptyStringSchema,
                  connector_instance_id: ConnectorInstanceIdAliasSchema,
                  display_name: ConnectionDisplayNameSchema,
                  emitted_at: NonEmptyStringSchema,
                  match_windows: {
                    items: SearchMatchWindowSchema,
                    type: "array",
                  },
                  matched_fields: {
                    items: NonEmptyStringSchema,
                    minItems: 1,
                    type: "array",
                  },
                  object: { const: "search_result" },
                  record_key: NonEmptyStringSchema,
                  record_url: { type: "string" },
                  score: RetrievalScoreSchema,
                  snippet: {
                    additionalProperties: false,
                    properties: {
                      field: NonEmptyStringSchema,
                      text: { type: "string" },
                    },
                    required: ["field", "text"],
                    type: "object",
                  },
                  stream: NonEmptyStringSchema,
                },
                required: ["object", "stream", "record_key", "connector_id", "emitted_at", "matched_fields"],
                type: "object",
              },
              type: "array",
            },
            has_more: { type: "boolean" },
            next_cursor: { type: "string" },
            object: { const: "list" },
            url: { type: "string" },
          },
          required: ["object", "data", "has_more"],
          type: "object",
        },
      },
      400: {
        description: "Invalid request (e.g. unsupported v1 query parameter, missing q)",
        schema: ErrorObjectSchema,
      },
      401: { description: "Missing or invalid access token", schema: ErrorObjectSchema },
      403: { description: "Grant does not permit a named stream (client tokens only)", schema: ErrorObjectSchema },
      410: { description: "Cursor expired or refers to an unknown snapshot", schema: ErrorObjectSchema },
    },
    summary:
      "Optional lexical retrieval extension: search records across authorized streams by text. Search modes, per-mode cursor support, and field-level `lexical_search`/`semantic_search` capabilities are advertised by `GET /v1/schema`; `filter[...]` operators applied to a single named stream must come from that stream's `field_capabilities`. Hits carry `connection_id` for attribution; the deprecated `connector_instance_id` alias is emitted alongside for compatibility but new clients SHOULD read `connection_id`.",
    surface: "public",
    tags: ["records", "lexical-retrieval"],
  },
  {
    id: "searchRecordsSemantic",
    method: "GET",
    path: "/v1/search/semantic",
    request: {
      headers: AuthHeaderSchema,
      // additionalProperties: false locks the v1 param allowlist at the schema
      // layer in addition to the runtime check in search-semantic.js. Raw
      // vectors, client-supplied embeddings, model selectors, and ranking
      // knobs are intentionally NOT in the allowlist.
      // `connection_id` / `connector_instance_id` are additive optional
      // filters per `expose-connection-identity-on-public-read`.
      query: {
        additionalProperties: false,
        properties: {
          connection_id: ConnectionIdSchema,
          connector_instance_id: ConnectorInstanceIdAliasSchema,
          cursor: CursorSchema,
          filter: {
            additionalProperties: true,
            type: "object",
          },
          limit: { maximum: 100, minimum: 1, type: "integer" },
          q: NonEmptyStringSchema,
          streams: {
            anyOf: [NonEmptyStringSchema, { items: NonEmptyStringSchema, minItems: 1, type: "array" }],
          },
        },
        required: ["q"],
        type: "object",
      },
    },
    responses: {
      200: {
        schema: {
          additionalProperties: true,
          properties: {
            data: {
              items: {
                additionalProperties: true,
                properties: {
                  connection_id: ConnectionIdSchema,
                  connector_id: NonEmptyStringSchema,
                  connector_instance_id: ConnectorInstanceIdAliasSchema,
                  display_name: ConnectionDisplayNameSchema,
                  emitted_at: NonEmptyStringSchema,
                  matched_fields: {
                    items: NonEmptyStringSchema,
                    type: "array",
                  },
                  object: { const: "search_result" },
                  record_key: NonEmptyStringSchema,
                  record_url: { type: "string" },
                  retrieval_mode: {
                    enum: ["semantic", "hybrid"],
                    type: "string",
                  },
                  score: RetrievalScoreSchema,
                  snippet: {
                    additionalProperties: false,
                    properties: {
                      field: NonEmptyStringSchema,
                      text: { type: "string" },
                    },
                    required: ["field", "text"],
                    type: "object",
                  },
                  stream: NonEmptyStringSchema,
                },
                required: [
                  "object",
                  "stream",
                  "record_key",
                  "connector_id",
                  "emitted_at",
                  "matched_fields",
                  "retrieval_mode",
                ],
                type: "object",
              },
              type: "array",
            },
            has_more: { type: "boolean" },
            next_cursor: { type: "string" },
            object: { const: "list" },
            url: { type: "string" },
          },
          required: ["object", "data", "has_more"],
          type: "object",
        },
      },
      400: {
        description: "Invalid request (e.g. unsupported v1 query parameter, missing q)",
        schema: ErrorObjectSchema,
      },
      401: { description: "Missing or invalid access token", schema: ErrorObjectSchema },
      403: { description: "Grant does not permit a named stream (client tokens only)", schema: ErrorObjectSchema },
      410: { description: "Cursor expired or refers to an unknown snapshot", schema: ErrorObjectSchema },
    },
    summary:
      "Experimental optional extension: semantic retrieval across authorized streams by text. See the semantic-retrieval capability spec. Unstable in v1. Per-stream semantic capability and pagination support are advertised by `GET /v1/schema` and the `capabilities.semantic_retrieval` block in protected-resource metadata; consult them before relying on cursors or filters. Hits carry `connection_id` for attribution; the deprecated `connector_instance_id` alias is emitted for compatibility only.",
    surface: "public",
    tags: ["records", "semantic-retrieval"],
  },
  {
    id: "searchRecordsHybrid",
    method: "GET",
    path: "/v1/search/hybrid",
    request: {
      headers: AuthHeaderSchema,
      // Mirrors the lexical + semantic allowlists. v1 intentionally omits
      // cursor/pagination knobs (see the hybrid-retrieval spec: first-tranche
      // servers either encode snapshot-honest cursors or omit cursor support
      // entirely). The reference rejects cursor to keep pagination honest.
      // `connection_id` / `connector_instance_id` are additive optional
      // filters per `expose-connection-identity-on-public-read`.
      query: {
        additionalProperties: false,
        properties: {
          connection_id: ConnectionIdSchema,
          connector_instance_id: ConnectorInstanceIdAliasSchema,
          filter: {
            additionalProperties: true,
            type: "object",
          },
          limit: { maximum: 100, minimum: 1, type: "integer" },
          q: NonEmptyStringSchema,
          streams: {
            anyOf: [NonEmptyStringSchema, { items: NonEmptyStringSchema, minItems: 1, type: "array" }],
          },
        },
        required: ["q"],
        type: "object",
      },
    },
    responses: {
      200: {
        schema: {
          additionalProperties: true,
          properties: {
            data: {
              items: {
                additionalProperties: true,
                properties: {
                  connection_id: ConnectionIdSchema,
                  connector_id: NonEmptyStringSchema,
                  connector_instance_id: ConnectorInstanceIdAliasSchema,
                  display_name: ConnectionDisplayNameSchema,
                  emitted_at: NonEmptyStringSchema,
                  matched_fields: {
                    items: NonEmptyStringSchema,
                    type: "array",
                  },
                  object: { const: "search_result" },
                  record_key: NonEmptyStringSchema,
                  record_url: { type: "string" },
                  retrieval_mode: { const: "hybrid" },
                  retrieval_sources: {
                    items: { enum: ["lexical", "semantic"], type: "string" },
                    minItems: 1,
                    type: "array",
                  },
                  scores: {
                    additionalProperties: false,
                    properties: {
                      lexical: RetrievalScoreSchema,
                      semantic: RetrievalScoreSchema,
                    },
                    type: "object",
                  },
                  snippet: {
                    additionalProperties: false,
                    properties: {
                      field: NonEmptyStringSchema,
                      text: { type: "string" },
                    },
                    required: ["field", "text"],
                    type: "object",
                  },
                  stream: NonEmptyStringSchema,
                },
                required: [
                  "object",
                  "stream",
                  "record_key",
                  "connector_id",
                  "emitted_at",
                  "matched_fields",
                  "retrieval_mode",
                  "retrieval_sources",
                ],
                type: "object",
              },
              type: "array",
            },
            has_more: { type: "boolean" },
            object: { const: "list" },
            url: { type: "string" },
          },
          required: ["object", "data", "has_more"],
          type: "object",
        },
      },
      400: {
        description: "Invalid request (e.g. unsupported v1 query parameter, missing q, cursor parameter)",
        schema: ErrorObjectSchema,
      },
      401: { description: "Missing or invalid access token", schema: ErrorObjectSchema },
      403: { description: "Grant does not permit a named stream (client tokens only)", schema: ErrorObjectSchema },
      404: { description: "Hybrid retrieval not advertised on this server", schema: ErrorObjectSchema },
    },
    summary:
      "Experimental optional extension: hybrid retrieval blending lexical and semantic recall under one grant-safe result list. See the hybrid-retrieval capability spec. Hybrid does NOT support cursor pagination on this reference; check `pdpp_discovery_hints.hybrid_pagination_supported` in the protected-resource metadata and, when it is `false` or absent, fall back to `GET /v1/search` (lexical) which supports `cursor`.",
    surface: "public",
    tags: ["records", "hybrid-retrieval"],
  },
  {
    id: "uploadBlob",
    method: "POST",
    path: "/v1/blobs",
    request: {
      body: {
        contentType: "application/octet-stream",
        schema: { format: "binary", type: "string" },
      },
      headers: AuthHeaderSchema,
      query: UploadBlobQuerySchema,
    },
    responses: {
      200: {
        description: "Canonical content-addressed blob identity for the uploaded bytes",
        schema: BlobObjectSchema,
      },
      400: { description: "Invalid upload request", schema: ErrorObjectSchema },
      401: { description: "Missing or invalid access token", schema: ErrorObjectSchema },
      403: { description: "Owner/runtime authority required", schema: ErrorObjectSchema },
      404: { description: "Unknown connector or stream", schema: ErrorObjectSchema },
    },
    summary: "Upload connector/runtime-owned blob bytes for a bound record.",
    surface: "public",
    tags: ["records"],
  },
  {
    id: "getBlob",
    method: "GET",
    path: "/v1/blobs/{blob_id}",
    request: {
      headers: AuthHeaderSchema,
      params: {
        additionalProperties: false,
        properties: { blob_id: { minLength: 1, type: "string" } },
        required: ["blob_id"],
        type: "object",
      },
      query: {
        additionalProperties: false,
        properties: {
          connection_id: ConnectionIdSchema,
          connector_instance_id: ConnectorInstanceIdAliasSchema,
        },
        type: "object",
      },
    },
    responses: {
      200: { contentType: "application/octet-stream", description: "Blob bytes" },
      ...ProtectedReadWithAmbiguityErrors,
    },
    summary:
      "Fetch blob bytes authorized by the caller having discovered the referencing record under grant. When the blob identifier resolves to more than one connection under the caller's grant and `connection_id` is omitted, returns a typed `ambiguous_connection` (409) error with `available_connections` and retry guidance instead of silently picking one. The deprecated `connector_instance_id` alias is accepted for compatibility but new clients SHOULD use `connection_id`.",
    surface: "public",
    tags: ["records"],
  },
  {
    id: "createEventSubscription",
    method: "POST",
    path: "/v1/event-subscriptions",
    request: {
      body: { contentType: "application/json", schema: CreateEventSubscriptionBodySchema },
    },
    responses: {
      201: {
        description:
          "Subscription created. The `secret` field is the Standard Webhooks signing key (`whsec_<base64>`) and is returned only on creation.",
        schema: CreateEventSubscriptionResponseSchema,
      },
      400: {
        description: "Invalid request (callback URL malformed, filters not in grant, etc.)",
        schema: ErrorObjectSchema,
      },
      ...EventSubscriptionAuthErrors,
    },
    summary:
      "Create an event subscription for the bearer's explicit authority (`client_grant` or registered `trusted_owner_agent`). Immediately enqueues a `pdpp.subscription.verify` event to the callback URL. The subscription stays in `pending_verification` until the receiver echoes the `challenge` value. Returns the per-subscription HMAC signing secret (`whsec_*`) once; it cannot be retrieved again.",
    surface: "public",
    tags: ["event-subscriptions"],
  },
  {
    id: "listEventSubscriptions",
    method: "GET",
    path: "/v1/event-subscriptions",
    responses: {
      200: { schema: ListEventSubscriptionsResponseSchema },
      ...EventSubscriptionAuthErrors,
    },
    summary:
      "List all non-deleted event subscriptions for the bearer's authority tuple (`authority_kind`, `client_id`, `subject_id`, and `grant_id` when `client_grant`).",
    surface: "public",
    tags: ["event-subscriptions"],
  },
  {
    id: "getEventSubscription",
    method: "GET",
    path: "/v1/event-subscriptions/{subscription_id}",
    request: { params: EventSubscriptionIdPathSchema },
    responses: {
      200: { schema: EventSubscriptionSchema },
      ...EventSubscriptionAuthErrors,
      ...EventSubscriptionNotFoundError,
    },
    summary: "Get a single event subscription owned by the bearer.",
    surface: "public",
    tags: ["event-subscriptions"],
  },
  {
    id: "updateEventSubscription",
    method: "PATCH",
    path: "/v1/event-subscriptions/{subscription_id}",
    request: {
      body: { contentType: "application/json", schema: UpdateEventSubscriptionBodySchema },
      params: EventSubscriptionIdPathSchema,
    },
    responses: {
      200: {
        description: "Updated subscription. `secret` is only present when `rotate_secret` was `true`.",
        schema: UpdateEventSubscriptionResponseSchema,
      },
      400: { description: "Invalid update (e.g. re-enabling a revoked subscription)", schema: ErrorObjectSchema },
      ...EventSubscriptionAuthErrors,
      ...EventSubscriptionNotFoundError,
      409: {
        description: "State conflict (e.g. re-enabling a `disabled_revoked` subscription)",
        schema: ErrorObjectSchema,
      },
    },
    summary:
      "Update an event subscription. Toggle `enabled` to disable or re-enable delivery. Set `rotate_secret` to true to generate a new signing secret (returned in the response body; old secret is immediately invalid).",
    surface: "public",
    tags: ["event-subscriptions"],
  },
  {
    id: "deleteEventSubscription",
    method: "DELETE",
    path: "/v1/event-subscriptions/{subscription_id}",
    request: { params: EventSubscriptionIdPathSchema },
    responses: {
      204: { description: "Subscription deleted." },
      ...EventSubscriptionAuthErrors,
      ...EventSubscriptionNotFoundError,
    },
    summary:
      "Delete an event subscription. Queued undelivered events are dropped. Idempotent for the caller's authority tuple (`authority_kind`, `client_id`, `subject_id`, and `grant_id` when `client_grant`).",
    surface: "public",
    tags: ["event-subscriptions"],
  },
  {
    id: "sendTestEvent",
    method: "POST",
    path: "/v1/event-subscriptions/{subscription_id}/test-event",
    request: { params: EventSubscriptionIdPathSchema },
    responses: {
      202: { description: "Test event accepted for delivery.", schema: SendTestEventResponseSchema },
      ...EventSubscriptionAuthErrors,
      ...EventSubscriptionNotFoundError,
      409: {
        description:
          "Subscription is not in a state that accepts test events (must be `active` or `pending_verification`)",
        schema: ErrorObjectSchema,
      },
    },
    summary:
      "Enqueue a `pdpp.subscription.test` event for asynchronous delivery to the subscription's callback URL. Accepted for `active` and `pending_verification` subscriptions. Returns the enqueued event ID.",
    surface: "public",
    tags: ["event-subscriptions"],
  },
];
