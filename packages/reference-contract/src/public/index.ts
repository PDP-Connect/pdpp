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
  type: "string",
  minLength: 1,
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
  type: "string",
  minLength: 1,
  description:
    "Canonical public identifier for a connection (one owner-configured account/device/profile). Prefer this over the deprecated `connector_instance_id` alias.",
};

const ConnectionDisplayNameSchema = {
  type: "string",
  minLength: 1,
  description:
    "Owner-meaningful label for the connection. Never the storage-layer placeholder (`legacy`, `default_account`); falls back to `<connector> · account N` when the owner has not renamed the connection.",
};

const ConnectorInstanceIdAliasSchema = {
  type: "string",
  minLength: 1,
  description:
    "Deprecated wire alias for `connection_id`. Emitted alongside `connection_id` during the migration window. New clients SHOULD ignore this field and read `connection_id` instead.",
};

const AvailableConnectionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    connection_id: ConnectionIdSchema,
    display_name: ConnectionDisplayNameSchema,
  },
  required: ["connection_id", "display_name"],
};

// Per-stream entry on `GET /v1/schema` advertising one connection the caller
// may use as a `connection_id` filter on subsequent reads. `display_name` is
// omitted (not faked) when the owner has never renamed the connection — the
// runtime treats storage placeholders (`legacy`, `default_account`, the
// connector id) as absent labels rather than wire content.
const GrantedConnectionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    connection_id: ConnectionIdSchema,
    display_name: ConnectionDisplayNameSchema,
  },
  required: ["connection_id"],
};

const CapabilityFlagSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    declared: { type: "boolean" },
    usable: { type: "boolean" },
    reason: { type: "string" },
  },
  required: ["declared", "usable"],
};

const PreRegisteredPublicClientSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    client_id: NonEmptyStringSchema,
    client_name: NonEmptyStringSchema,
    token_endpoint_auth_method: { const: "none" },
  },
  required: ["client_id", "client_name", "token_endpoint_auth_method"],
};

const RetrievalScoreSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: { type: "string", enum: ["bm25", "semantic_distance"] },
    value: { type: "number" },
    order: { type: "string", enum: ["higher_is_better", "lower_is_better"] },
  },
  required: ["kind", "value", "order"],
};

const StreamNamePathSchema = {
  type: "object",
  additionalProperties: false,
  properties: { stream: NonEmptyStringSchema },
  required: ["stream"],
};

const RecordIdPathSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    stream: NonEmptyStringSchema,
    id: NonEmptyStringSchema,
  },
  required: ["stream", "id"],
};

const GrantIdPathSchema = {
  type: "object",
  additionalProperties: false,
  properties: { grantId: NonEmptyStringSchema },
  required: ["grantId"],
};

const ListRecordsQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    limit: { type: "integer", minimum: 1, maximum: 100 },
    cursor: CursorSchema,
    order: OrderSchema,
    changes_since: ChangesSinceSchema,
    fields: { type: "string" },
    view: { type: "string" },
    filter: {
      type: "object",
      description:
        "Per-field filter map. Exact: `filter[field]=value`. Range: `filter[field][op]=value` where `op` is one of the declared `field_capabilities.range_filter.operators` from `GET /v1/schema`.",
    },
    expand: { type: "array", items: NonEmptyStringSchema },
    expand_limit: { type: "object" },
    connector_id: { type: "string" },
    subject_id: { type: "string" },
    connection_id: ConnectionIdSchema,
    connector_instance_id: ConnectorInstanceIdAliasSchema,
    // Bounded-window opt-in. `exact` ⇒ the server MAY return `meta.window`
    // (`total` + logical `earliest_at`/`latest_at`) over the filtered,
    // grant-scoped corpus; absent / `none` ⇒ omitted. Not supported with
    // `changes_since`. Spec: complete-explorer-slvp-ideal.
    window: { type: "string", enum: ["none", "exact"] },
  },
};

// Calendar `date_trunc` granularity set for `group_by_time`. Calendar-aware
// (weeks start Monday); see
//   openspec/changes/add-aggregate-time-buckets-and-distinct
const AGGREGATE_GRANULARITIES = ["minute", "hour", "day", "week", "month", "quarter", "year"];

const AggregateQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    metric: { type: "string", enum: ["count", "sum", "min", "max", "count_distinct"] },
    field: { type: "string" },
    // Exactly one grouping dimension in v1: `group_by` XOR `group_by_time`.
    // The resource server rejects supplying both with `invalid_request`.
    group_by: { type: "string" },
    group_by_time: {
      type: "string",
      description:
        "Group counts into calendar time buckets over a declared date/date-time field. Mutually exclusive with `group_by`. Requires `granularity`.",
    },
    granularity: {
      type: "string",
      enum: AGGREGATE_GRANULARITIES,
      description:
        "Calendar `date_trunc` unit for `group_by_time`. Required when `group_by_time` is present and forbidden otherwise.",
    },
    time_zone: {
      type: "string",
      description:
        "IANA time zone used to compute `group_by_time` bucket boundaries. Defaults to `UTC`; the response echoes the effective zone.",
    },
    limit: { type: "integer", minimum: 1, maximum: 100 },
    filter: { type: "object" },
    connector_id: { type: "string" },
    subject_id: { type: "string" },
    connection_id: ConnectionIdSchema,
    connector_instance_id: ConnectorInstanceIdAliasSchema,
  },
  required: ["metric"],
};

const UploadBlobQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    connector_id: NonEmptyStringSchema,
    stream: NonEmptyStringSchema,
    record_key: NonEmptyStringSchema,
  },
  required: ["connector_id", "stream", "record_key"],
};

const BlobObjectSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    object: { const: "blob" },
    blob_id: NonEmptyStringSchema,
    sha256: {
      type: "string",
      pattern: "^[a-f0-9]{64}$",
    },
    size_bytes: { type: "integer", minimum: 0 },
    mime_type: NonEmptyStringSchema,
  },
  required: ["object", "blob_id", "sha256", "size_bytes", "mime_type"],
};

const ClientDisplaySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: NonEmptyStringSchema,
    uri: UriSchema,
    logo_uri: UriSchema,
    policy_uri: UriSchema,
    tos_uri: UriSchema,
  },
};

const RetentionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    max_duration: NonEmptyStringSchema,
    on_expiry: NonEmptyStringSchema,
  },
  required: ["max_duration", "on_expiry"],
};

const TimeRangeSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    since: NonEmptyStringSchema,
    until: NonEmptyStringSchema,
  },
};

const StreamSelectionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: NonEmptyStringSchema,
    necessity: { type: "string", enum: ["required", "optional"] },
    view: NonEmptyStringSchema,
    fields: { type: "array", minItems: 1, items: NonEmptyStringSchema },
    time_range: TimeRangeSchema,
    resources: { type: "array", items: NonEmptyStringSchema },
    client_claims: { type: "object", additionalProperties: true },
    // Optional per-stream connection constraint. Absent means cross-connection
    // (fan-in) read semantics; present constrains disclosure to records,
    // hits, or blobs from the named connection. Owned by
    //   openspec/changes/expose-connection-identity-on-public-read.
    connection_id: ConnectionIdSchema,
  },
  required: ["name"],
};

export const SourceObjectSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: { type: "string", enum: ["connector", "provider_native"] },
    id: NonEmptyStringSchema,
  },
  required: ["kind", "id"],
};

const AuthorizationDetailBaseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    type: { const: "https://pdpp.org/data-access" },
    source: SourceObjectSchema,
    purpose_code: NonEmptyStringSchema,
    purpose_description: NonEmptyStringSchema,
    access_mode: { type: "string", enum: ["single_use", "continuous"] },
    retention: RetentionSchema,
    streams: { type: "array", minItems: 1, items: StreamSelectionSchema },
  },
  required: ["type", "source", "purpose_code", "access_mode", "streams"],
};

const AuthorizationDetailSchema = AuthorizationDetailBaseSchema;

const GrantSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    version: NonEmptyStringSchema,
    grant_id: NonEmptyStringSchema,
    issued_at: { type: "string", format: "date-time" },
    subject: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: NonEmptyStringSchema,
      },
      required: ["id"],
    },
    client: {
      type: "object",
      additionalProperties: false,
      properties: {
        client_id: NonEmptyStringSchema,
        client_display: ClientDisplaySchema,
      },
      required: ["client_id"],
    },
    source: SourceObjectSchema,
    manifest_version: NonEmptyStringSchema,
    purpose_code: NonEmptyStringSchema,
    purpose_description: NonEmptyStringSchema,
    access_mode: { type: "string", enum: ["single_use", "continuous"] },
    streams: { type: "array", minItems: 1, items: StreamSelectionSchema },
    retention: RetentionSchema,
    expires_at: { type: ["string", "null"], format: "date-time" },
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
};

const AuthorizationServerMetadataSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    issuer: UriSchema,
    introspection_endpoint: UriSchema,
    pushed_authorization_request_endpoint: UriSchema,
    registration_endpoint: UriSchema,
    pdpp_provider_connect_capabilities: {
      type: "array",
      items: NonEmptyStringSchema,
      minItems: 1,
    },
    pdpp_registration_modes_supported: {
      type: "array",
      items: { type: "string", enum: ["dynamic", "pre_registered_public"] },
      minItems: 1,
    },
    pdpp_pre_registered_public_clients: {
      type: "array",
      items: PreRegisteredPublicClientSchema,
      minItems: 1,
    },
    pdpp_authorization_details_types_supported: {
      type: "array",
      items: { const: "https://pdpp.org/data-access" },
      minItems: 1,
    },
    token_endpoint: UriSchema,
    token_endpoint_auth_methods_supported: {
      type: "array",
      items: { const: "none" },
      minItems: 1,
    },
    device_authorization_endpoint: UriSchema,
    agent_connect_endpoint: UriSchema,
    grant_types_supported: {
      type: "array",
      items: { const: "urn:ietf:params:oauth:grant-type:device_code" },
      minItems: 1,
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
};

// `capabilities` is the layered server-level capability layer. v1 carries
// the optional `lexical_retrieval` and `semantic_retrieval` extensions.
// additionalProperties: true so future extensions can add their own keys
// without a contract bump.
const ServerCapabilitiesSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    lexical_retrieval: {
      type: "object",
      additionalProperties: false,
      properties: {
        supported: { type: "boolean" },
        endpoint: NonEmptyStringSchema,
        cross_stream: { type: "boolean" },
        snippets: { type: "boolean" },
        default_limit: { type: "integer", minimum: 1 },
        max_limit: { type: "integer", minimum: 1 },
        score: {
          type: "object",
          additionalProperties: false,
          properties: {
            supported: { const: true },
            kind: { const: "bm25" },
            order: { const: "lower_is_better" },
            value_semantics: { const: "implementation_relative" },
          },
          required: ["supported", "kind", "order", "value_semantics"],
        },
      },
      required: ["supported"],
    },
    semantic_retrieval: {
      type: "object",
      additionalProperties: false,
      properties: {
        supported: { type: "boolean" },
        stability: { type: "string", enum: ["experimental"] },
        endpoint: NonEmptyStringSchema,
        cross_stream: { type: "boolean" },
        query_input: { const: "text" },
        snippets: { type: "boolean" },
        lexical_blending: { type: "boolean" },
        model: NonEmptyStringSchema,
        dimensions: { type: "integer", minimum: 1 },
        distance_metric: NonEmptyStringSchema,
        default_limit: { type: "integer", minimum: 1 },
        max_limit: { type: "integer", minimum: 1 },
        index_state: { type: "string", enum: ["built", "building", "stale"] },
        score: {
          type: "object",
          additionalProperties: false,
          properties: {
            supported: { const: true },
            kind: { const: "semantic_distance" },
            order: { const: "lower_is_better" },
            value_semantics: { const: "distance" },
            comparable_with: {
              type: "object",
              additionalProperties: false,
              properties: {
                backend_identity: NonEmptyStringSchema,
                model: NonEmptyStringSchema,
                dimensions: { type: "integer", minimum: 1 },
                distance_metric: NonEmptyStringSchema,
                profile_id: NonEmptyStringSchema,
                dtype: NonEmptyStringSchema,
              },
              required: ["backend_identity", "model", "dimensions", "distance_metric"],
            },
          },
          required: ["supported", "kind", "order", "value_semantics", "comparable_with"],
        },
        language_bias: {
          type: "object",
          additionalProperties: false,
          properties: {
            primary: NonEmptyStringSchema,
            note: NonEmptyStringSchema,
          },
          required: ["primary"],
        },
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
    },
    hybrid_retrieval: {
      type: "object",
      additionalProperties: false,
      properties: {
        supported: { type: "boolean" },
        stability: { type: "string", enum: ["experimental"] },
        endpoint: NonEmptyStringSchema,
        cross_stream: { type: "boolean" },
        default_limit: { type: "integer", minimum: 1 },
        max_limit: { type: "integer", minimum: 1 },
        cursor_supported: { type: "boolean" },
        sources: {
          type: "array",
          minItems: 2,
          items: { type: "string", enum: ["lexical", "semantic"] },
        },
      },
      required: ["supported"],
    },
  },
};

// Discovery hints describe the canonical first-call shapes a caller needs
// after reading the protected-resource metadata document. The block is
// derived from runtime state so it cannot drift from live behavior. See:
//   openspec/changes/polish-reference-api-discovery-seams/specs/reference-implementation-architecture/spec.md
const ProtectedResourceDiscoveryHintsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    schema_endpoint: NonEmptyStringSchema,
    query_base: NonEmptyStringSchema,
    search: {
      type: "object",
      additionalProperties: false,
      properties: {
        endpoint: NonEmptyStringSchema,
        scope_param: NonEmptyStringSchema,
        filter_requires_single_stream: { type: "boolean" },
      },
      required: ["endpoint", "scope_param", "filter_requires_single_stream"],
    },
    aggregate: {
      type: "object",
      additionalProperties: false,
      properties: {
        endpoint_template: NonEmptyStringSchema,
      },
      required: ["endpoint_template"],
    },
    changes_since_bootstrap: NonEmptyStringSchema,
    blob_indirection: NonEmptyStringSchema,
    hybrid_pagination_supported: { type: "boolean" },
    connectors_endpoint: NonEmptyStringSchema,
    streams_endpoint_template: NonEmptyStringSchema,
    owner_polyfill_requires_source_kind_connector: { type: "boolean" },
  },
  required: [
    "schema_endpoint",
    "query_base",
    "changes_since_bootstrap",
    "blob_indirection",
    "connectors_endpoint",
    "streams_endpoint_template",
  ],
};

const ProtectedResourceAgentDiscoverySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    advisory: { const: true },
    skill_name: { const: "pdpp-data-access" },
    recommended_flow: { const: "pdpp agent" },
    skill_catalog: UriSchema,
    skill: UriSchema,
    llms_txt: UriSchema,
    llms_full_txt: UriSchema,
  },
  required: ["advisory", "skill_name", "recommended_flow", "skill_catalog", "skill", "llms_txt", "llms_full_txt"],
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
  type: "object",
  additionalProperties: false,
  properties: {
    family: NonEmptyStringSchema,
    status: { type: "string", enum: ["supported", "owner_mediated", "unsupported"] },
    method: { type: ["string", "null"] },
    url: { type: ["string", "null"] },
    reason: NonEmptyStringSchema,
  },
  required: ["family", "status", "method", "url", "reason"],
};

const ProtectedResourceOwnerAgentControlSurfaceSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    object: { const: "owner_agent_control_surface" },
    entrypoint: UriSchema,
    scope: { const: "reference_implementation" },
    mcp_owner_bearer_rejected: { const: true },
    actions: { type: "array", items: ProtectedResourceOwnerAgentControlActionSchema },
  },
  required: ["object", "entrypoint", "scope", "mcp_owner_bearer_rejected", "actions"],
};

const ProtectedResourceOwnerAgentOnboardingSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    advisory: { const: true },
    profile: { const: "trusted_owner_agent" },
    // Plain-language reminder that this credential is owner-level local
    // automation, not a grant-scoped external client.
    warning: NonEmptyStringSchema,
    // AS issuer + RS resource origins the agent should treat as authoritative.
    authorization_server: UriSchema,
    resource: UriSchema,
    // Owner approval happens in a browser/dashboard context, not a token paste.
    owner_approval_url: UriSchema,
    // AS owner-credential bootstrap surfaces.
    device_authorization_endpoint: UriSchema,
    token_endpoint: UriSchema,
    introspection_endpoint: UriSchema,
    registration_endpoint: UriSchema,
    // RFC 7592 client-delete handle for the issued owner-agent credential.
    revocation_path_template: NonEmptyStringSchema,
    // RS discovery + ongoing-sync surfaces.
    schema_endpoint: UriSchema,
    // Token-efficient schema view for agent discovery. The full schema remains
    // available at `schema_endpoint`; owner agents should prefer this compact
    // URL for routine metadata refreshes.
    schema_compact_endpoint: UriSchema,
    streams_endpoint: UriSchema,
    query_base: UriSchema,
    event_subscriptions_endpoint: UriSchema,
    // The route boundary: owner bearers are REST/control-plane credentials and
    // `/mcp` rejects them. Grant-scoped MCP remains the external-client path.
    mcp_owner_bearer_rejected: { const: true },
    pdpp_token_kind: { const: "owner" },
    // Owner-agent control entrypoint + action-family catalog.
    control_surface: ProtectedResourceOwnerAgentControlSurfaceSchema,
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
};

const ProtectedResourceMetadataSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    resource: UriSchema,
    resource_name: NonEmptyStringSchema,
    authorization_servers: {
      type: "array",
      minItems: 1,
      items: UriSchema,
    },
    bearer_methods_supported: {
      type: "array",
      minItems: 1,
      items: { const: "header" },
    },
    pdpp_provider_connect_version: NonEmptyStringSchema,
    pdpp_self_export_supported: { type: "boolean" },
    pdpp_token_kinds_supported: {
      type: "array",
      minItems: 1,
      items: { type: "string", enum: ["owner", "client"] },
    },
    pdpp_core_query_base: UriSchema,
    pdpp_discovery_hints: ProtectedResourceDiscoveryHintsSchema,
    pdpp_agent_discovery: ProtectedResourceAgentDiscoverySchema,
    pdpp_owner_agent_onboarding: ProtectedResourceOwnerAgentOnboardingSchema,
    capabilities: ServerCapabilitiesSchema,
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
};

// Cold-start discovery index. Unauthenticated `GET /` on AS and RS returns
// a tiny pointer at the next hop. See:
//   openspec/changes/polish-reference-api-discovery-seams
const DiscoveryIndexResponseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    object: { const: "pdpp_discovery_index" },
    role: { type: "string", enum: ["authorization_server", "resource_server"] },
    resource_name: NonEmptyStringSchema,
    links: {
      type: "object",
      additionalProperties: false,
      properties: {
        well_known: NonEmptyStringSchema,
        well_known_authorization_server: NonEmptyStringSchema,
        schema: NonEmptyStringSchema,
        core_query_base: NonEmptyStringSchema,
        connectors: NonEmptyStringSchema,
      },
    },
    reference_revision: NonEmptyStringSchema,
    // Advisory trusted-owner-agent onboarding pointer, emitted on the RS root
    // only when owner-agent onboarding is safely configured. Same advisory
    // block carried in protected-resource metadata, surfaced at the cold-start
    // root so a local owner agent can derive the flow from the entrypoint URL.
    pdpp_owner_agent_onboarding: ProtectedResourceOwnerAgentOnboardingSchema,
  },
  required: ["object", "role", "resource_name", "links", "reference_revision"],
};

const DynamicClientRegistrationRequestSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    application_type: NonEmptyStringSchema,
    client_name: NonEmptyStringSchema,
    client_uri: UriSchema,
    grant_types: { type: "array", items: NonEmptyStringSchema },
    logo_uri: UriSchema,
    policy_uri: UriSchema,
    redirect_uris: { type: "array", items: UriSchema },
    response_types: { type: "array", items: NonEmptyStringSchema },
    token_endpoint_auth_method: { type: "string", enum: ["none"] },
    tos_uri: UriSchema,
  },
};

const DynamicClientRegistrationResponseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    client_id: NonEmptyStringSchema,
    client_id_issued_at: { type: "integer", minimum: 0 },
    token_endpoint_auth_method: { const: "none" },
    client_name: { type: ["string", "null"] },
    redirect_uris: { type: "array", items: UriSchema },
    grant_types: { type: "array", items: NonEmptyStringSchema },
    response_types: { type: "array", items: NonEmptyStringSchema },
    client_uri: UriSchema,
    logo_uri: UriSchema,
    policy_uri: UriSchema,
    tos_uri: UriSchema,
  },
  required: [
    "client_id",
    "client_id_issued_at",
    "token_endpoint_auth_method",
    "client_name",
  ],
};

const GrantInitiationRequestSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    client_id: NonEmptyStringSchema,
    client_display: ClientDisplaySchema,
    scenario_id: NonEmptyStringSchema,
    authorization_details: {
      type: "array",
      minItems: 1,
      "x-pdpp-soft-cap": BATCH_CONSENT_STAGED_ENTRY_SOFT_CAP,
      "x-pdpp-warning-threshold": BATCH_CONSENT_STAGED_ENTRY_WARNING_THRESHOLD,
      items: AuthorizationDetailSchema,
    },
  },
  required: ["client_id", "authorization_details"],
};

const GrantInitiationResponseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    request_uri: {
      type: "string",
      pattern: "^urn:pdpp:pending-consent:",
    },
    authorization_url: UriSchema,
    expires_in: { type: "integer", minimum: 1 },
  },
  required: ["request_uri", "authorization_url", "expires_in"],
};

const OwnerDeviceAuthorizationRequestSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    client_id: NonEmptyStringSchema,
  },
  required: ["client_id"],
};

const OwnerDeviceAuthorizationResponseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    device_code: NonEmptyStringSchema,
    user_code: NonEmptyStringSchema,
    verification_uri: UriSchema,
    verification_uri_complete: UriSchema,
    expires_in: { type: "integer", minimum: 1 },
    interval: { type: "integer", minimum: 1 },
  },
  required: ["device_code", "user_code", "verification_uri", "verification_uri_complete", "expires_in", "interval"],
};

const OwnerDeviceTokenRequestSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    grant_type: { const: "urn:ietf:params:oauth:grant-type:device_code" },
    device_code: NonEmptyStringSchema,
    client_id: NonEmptyStringSchema,
  },
  required: ["grant_type", "device_code", "client_id"],
};

const AuthorizationCodeTokenRequestSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    grant_type: { const: "authorization_code" },
    code: NonEmptyStringSchema,
    client_id: NonEmptyStringSchema,
    redirect_uri: UriSchema,
    code_verifier: NonEmptyStringSchema,
  },
  required: ["grant_type", "code", "client_id", "redirect_uri", "code_verifier"],
};

const RefreshTokenRequestSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    grant_type: { const: "refresh_token" },
    refresh_token: NonEmptyStringSchema,
    client_id: NonEmptyStringSchema,
  },
  required: ["grant_type", "refresh_token", "client_id"],
};

const OAuthTokenRequestSchema = {
  oneOf: [OwnerDeviceTokenRequestSchema, AuthorizationCodeTokenRequestSchema, RefreshTokenRequestSchema],
};

const AccessTokenResponseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    access_token: NonEmptyStringSchema,
    token_type: { const: "Bearer" },
    expires_in: { type: "integer", minimum: 0 },
  },
  required: ["access_token", "token_type", "expires_in"],
};

const HostedMcpTokenResponseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    access_token: NonEmptyStringSchema,
    token_type: { const: "Bearer" },
    refresh_token: NonEmptyStringSchema,
    grant_id: NonEmptyStringSchema,
  },
  required: ["access_token", "token_type", "grant_id"],
};

const OAuthTokenResponseSchema = {
  oneOf: [AccessTokenResponseSchema, HostedMcpTokenResponseSchema],
};

const IntrospectionRequestSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    token: NonEmptyStringSchema,
  },
  required: ["token"],
};

const IntrospectionResponseSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    active: { type: "boolean" },
    inactive_reason: NonEmptyStringSchema,
    pdpp_token_kind: { type: "string", enum: ["owner", "client"] },
    subject_id: { type: "string" },
    exp: { type: ["integer", "null"] },
    grant_id: NonEmptyStringSchema,
    client_id: NonEmptyStringSchema,
    grant: GrantSchema,
    trace_id: NonEmptyStringSchema,
    scenario_id: NonEmptyStringSchema,
  },
  required: ["active"],
};

const GrantApprovalResponseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    grant_id: NonEmptyStringSchema,
    token: NonEmptyStringSchema,
    grant: GrantSchema,
  },
  required: ["grant_id", "token", "grant"],
};

const RevokeGrantResponseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    revoked: { const: true },
  },
  required: ["revoked"],
};

const RecordSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    object: { const: "record" },
    id: { type: "string" },
    stream: { type: "string" },
    data: { type: "object", additionalProperties: true },
    emitted_at: { type: "string" },
    expanded: { type: "object", additionalProperties: true },
    deleted: { type: "boolean" },
    deleted_at: { type: "string" },
    connection_id: ConnectionIdSchema,
    display_name: ConnectionDisplayNameSchema,
    connector_instance_id: ConnectorInstanceIdAliasSchema,
  },
  required: ["object", "id", "stream"],
};

const RecordsListResponseSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    ...ListEnvelopeSchema(RecordSchema).properties,
    url: { type: "string" },
    next_changes_since: { type: "string" },
    freshness: FreshnessSchema,
    // Canonical envelope meta block: opt-in `count`, opt-in bounded `window`
    // (`total` + logical `earliest_at`/`latest_at`), and structured
    // `warnings`. Declared explicitly so the additive `meta.window` shape is
    // part of the published contract rather than riding unvalidated on
    // `additionalProperties: true`. Spec:
    //   openspec/changes/complete-explorer-slvp-ideal/specs/
    //   reference-implementation-architecture/spec.md.
    meta: MetaSchema,
  },
  required: ["object", "data", "has_more"],
};

const AggregationResponseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    object: { const: "aggregation" },
    stream: { type: "string" },
    metric: { type: "string", enum: ["count", "sum", "min", "max", "count_distinct"] },
    field: { type: ["string", "null"] },
    group_by: { type: ["string", "null"] },
    // Additive time-bucket fields. `null` for non-time aggregations so
    // existing payloads stay compatible. See:
    //   openspec/changes/add-aggregate-time-buckets-and-distinct
    group_by_time: { type: ["string", "null"] },
    granularity: { type: ["string", "null"], enum: [...AGGREGATE_GRANULARITIES, null] },
    time_zone: { type: ["string", "null"] },
    // `true` only when an accelerated path estimates the metric (e.g. a future
    // HyperLogLog `count_distinct`). The reference floor is exact and reports
    // `false`.
    approximate: { type: "boolean" },
    value: { type: ["number", "integer", "string", "null"] },
    filtered_record_count: { type: "integer", minimum: 0 },
    limit: { type: "integer", minimum: 1, maximum: 100 },
    groups: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          key: { type: ["string", "number", "integer", "boolean", "null"] },
          count: { type: "integer", minimum: 0 },
        },
        required: ["key", "count"],
      },
    },
  },
  required: ["object", "stream", "metric", "filtered_record_count"],
};

const StreamListResponseSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    object: { const: "list" },
    data: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        properties: {
          object: { const: "stream" },
          name: { type: "string" },
          record_count: { type: "integer" },
          last_updated: { type: ["string", "null"] },
          freshness: FreshnessSchema,
          connection_id: ConnectionIdSchema,
          display_name: ConnectionDisplayNameSchema,
          connector_instance_id: ConnectorInstanceIdAliasSchema,
        },
        required: ["object", "name"],
      },
    },
  },
  required: ["object", "data"],
};

const ConnectorListResponseSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    object: { const: "list" },
    data: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        properties: {
          object: { const: "connector" },
          connector_id: { type: "string" },
          source: { type: "object", additionalProperties: true },
          stream_count: { type: "integer" },
          streams: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: true,
              properties: {
                object: { const: "stream" },
                name: { type: "string" },
                record_count: { type: "integer" },
                last_updated: { type: ["string", "null"] },
                freshness: FreshnessSchema,
                capabilities: { type: "object", additionalProperties: true },
              },
              required: ["object", "name"],
            },
          },
        },
        required: ["object", "source", "stream_count", "streams"],
      },
    },
  },
  required: ["object", "data"],
};

const CompactFieldCapabilityFlagsSchema = {
  type: "string",
  minLength: 1,
  description:
    "Compact schema-view capability flags. Comma-separated tokens preserve declared type, grant status, and usable exact/range/lexical/semantic/aggregation capabilities without embedding the full per-field JSON Schema.",
};

const StreamMetadataResponseSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    object: { const: "stream_metadata" },
    name: { type: "string" },
    schema: { type: "object" },
    primary_key: { type: "array", items: { type: "string" } },
    cursor_field: { type: ["string", "null"] },
    consent_time_field: { type: ["string", "null"] },
    selection: { type: "object" },
    views: { type: "array" },
    relationships: { type: "array" },
    query: {
      type: "object",
      additionalProperties: false,
      properties: {
        range_filters: { type: "object" },
        expand: { type: "array" },
        aggregations: {
          type: "object",
          additionalProperties: false,
          properties: {
            count: { const: true },
            sum: { type: "array", items: { type: "string" } },
            min: { type: "array", items: { type: "string" } },
            max: { type: "array", items: { type: "string" } },
            group_by: { type: "array", items: { type: "string" } },
            // Declared date/date-time fields the stream supports for
            // `group_by_time` calendar bucketing, and declared scalar fields
            // it supports for `count_distinct`. See:
            //   openspec/changes/add-aggregate-time-buckets-and-distinct
            group_by_time: { type: "array", items: { type: "string" } },
            count_distinct: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
    field_capabilities: {
      type: "object",
      additionalProperties: {
        oneOf: [
          CompactFieldCapabilityFlagsSchema,
          {
            type: "object",
            additionalProperties: false,
            properties: {
              // Optional declared presentation type sourced from the stream
              // manifest. Implementations may declare it as a JSON Schema
              // extension (`schema.properties[field].x_pdpp_type`) or through
              // the sandbox-shaped field declaration array (`fields[]` or
              // `schema.fields[]` with `{ name, type, semantic_class }`).
              // Additive and optional: omitted when the manifest does not
              // declare it, and a consumer SHALL treat the absence as "not
              // declared". This is a presentation/dispatch hint only; it is
              // never client-writable or grantable.
              type: { type: "string", minLength: 1 },
              schema: { type: "object", additionalProperties: true },
              granted: { type: "boolean" },
              exact_filter: CapabilityFlagSchema,
              range_filter: {
                type: "object",
                additionalProperties: false,
                properties: {
                  declared: { type: "boolean" },
                  usable: { type: "boolean" },
                  operators: { type: "array", items: NonEmptyStringSchema },
                  reason: { type: "string" },
                },
                required: ["declared", "usable"],
              },
              lexical_search: CapabilityFlagSchema,
              semantic_search: CapabilityFlagSchema,
              aggregation: {
                type: "object",
                additionalProperties: false,
                properties: {
                  sum: CapabilityFlagSchema,
                  min: CapabilityFlagSchema,
                  max: CapabilityFlagSchema,
                  group_by: CapabilityFlagSchema,
                  group_by_time: CapabilityFlagSchema,
                  count_distinct: CapabilityFlagSchema,
                },
                required: ["sum", "min", "max", "group_by", "group_by_time", "count_distinct"],
              },
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
          },
        ],
      },
    },
    expand_capabilities: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: NonEmptyStringSchema,
          relation: NonEmptyStringSchema,
          // `stream` is the historical name for the related child stream. It is
          // retained for back-compat and carries the same value as
          // `target_stream`.
          stream: NonEmptyStringSchema,
          // The related child stream the forward relation points at. Required so
          // a reader never has to infer "is `stream` the parent or the child?".
          target_stream: NonEmptyStringSchema,
          cardinality: { type: "string", enum: ["has_one", "has_many"] },
          // The field on the child (target) record whose value holds the parent
          // record's key — the field the server filters on as
          // `WHERE child.<field> = <parent record key>` during hydration. This is
          // the same field the manifest declares as `foreign_key`; it is NOT the
          // child's own record key. Required.
          child_parent_key_field: NonEmptyStringSchema,
          // Back-compat alias for `child_parent_key_field`, carrying the identical
          // value. New readers SHOULD prefer `child_parent_key_field`.
          foreign_key: NonEmptyStringSchema,
          default_limit: { type: "integer", minimum: 1 },
          max_limit: { type: "integer", minimum: 1 },
          granted: { type: "boolean" },
          usable: { type: "boolean" },
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
            type: "string",
            enum: ["related_stream_not_granted", "related_stream_unknown", "related_stream_not_loaded"],
          },
        },
        required: ["name", "stream", "target_stream", "cardinality", "child_parent_key_field", "granted", "usable"],
      },
    },
    freshness: FreshnessSchema,
    granted_connections: {
      type: "array",
      description:
        "Connections the caller's grant authorizes for this stream under the addressed connector. Clients MAY pass any `connection_id` here on a subsequent read to scope without trial-and-error. Omitted for provider-native sources where connection identity does not apply.",
      items: GrantedConnectionSchema,
    },
  },
  required: ["object", "name", "field_capabilities", "expand_capabilities"],
};

const SchemaResponseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    object: { const: "schema" },
    detail: {
      type: "string",
      enum: ["compact"],
      description: "Present only when `GET /v1/schema?view=compact` returned the compact projection.",
    },
    bearer: {
      type: "object",
      additionalProperties: false,
      properties: {
        token_kind: { type: "string", enum: ["owner", "client"] },
        scope: { type: "string", enum: ["owner", "grant"] },
        grant_id: { type: "string" },
        client_id: { type: "string" },
      },
      required: ["token_kind", "scope"],
    },
    connectors: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          object: { const: "connector" },
          connector_id: { type: "string" },
          source: { type: "object", additionalProperties: true },
          stream_count: { type: "integer", minimum: 0 },
          streams: {
            type: "array",
            items: StreamMetadataResponseSchema,
          },
        },
        required: ["object", "source", "stream_count", "streams"],
      },
    },
  },
  required: ["object", "bearer", "connectors"],
};

const SchemaQuerySchema = {
  type: "object",
  // Existing schema callers may pass legacy owner polyfill selectors such as
  // `connector_id`; keep request validation permissive while documenting the
  // token-efficient selector names agents should prefer.
  additionalProperties: true,
  properties: {
    connector_id: {
      type: "string",
      description: "Optional owner-polyfill source hint for runtimes that expose multiple connector templates.",
    },
    view: {
      type: "string",
      description:
        "Set `view=compact` to return the token-efficient schema projection. Omitted or any other value returns the full schema body.",
    },
    stream: {
      type: "string",
      description:
        "When used with `view=compact`, narrows the schema document to connectors that contribute this stream.",
    },
  },
};

const AuthHeaderSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    authorization: { type: "string", pattern: "^Bearer " },
  },
  required: ["authorization"],
};

// Typed `ambiguous_connection` error envelope. Emitted by `getRecord` and
// `getBlob` when the addressed record or blob identifier resolves to more
// than one connection under the caller's grant and the client did not pass
// `connection_id`. The envelope lists the candidate connections inline so
// the client can retry without an extra round trip. List/search operations
// never raise this error — they fan in instead.
const AmbiguousConnectionErrorSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    error: {
      type: "object",
      additionalProperties: false,
      properties: {
        type: { type: "string" },
        code: { const: "ambiguous_connection" },
        message: { type: "string" },
        param: { type: "string" },
        request_id: { type: "string" },
        available_connections: {
          type: "array",
          minItems: 2,
          items: AvailableConnectionSchema,
        },
        retry_with: {
          type: "object",
          additionalProperties: false,
          properties: {
            field: { const: "connection_id" },
            guidance: { type: "string" },
          },
          required: ["field", "guidance"],
        },
      },
      required: ["type", "code", "message", "request_id", "available_connections", "retry_with"],
    },
  },
  required: ["error"],
};

const ProtectedReadErrors = {
  400: { schema: ErrorObjectSchema, description: "Invalid request" },
  401: { schema: ErrorObjectSchema, description: "Missing or invalid access token" },
  403: { schema: ErrorObjectSchema, description: "Grant does not permit this request" },
  404: { schema: ErrorObjectSchema, description: "Stream or record not found" },
};

const ProtectedReadWithAmbiguityErrors = {
  ...ProtectedReadErrors,
  409: {
    schema: AmbiguousConnectionErrorSchema,
    description:
      "Identifier resolves to more than one connection under the caller's grant. Retry with the `connection_id` listed in `error.available_connections`.",
  },
};

const ListRecordErrors = {
  ...ProtectedReadErrors,
  410: { schema: ErrorObjectSchema, description: "Cursor expired" },
};

const OAuthFlowErrors = {
  400: { schema: OAuthErrorSchema, description: "OAuth request rejected" },
};

// Client event-subscription management. A reference-implementation extension
// (discoverable via `pdpp_provider_connect_capabilities` /
// `capabilities.event_subscriptions`) letting an active client subscribe its
// callback URL to CloudEvents-shaped, Standard-Webhooks-signed delivery of
// record changes scoped to its grant. See:
//   openspec/specs/reference-implementation-architecture/spec.md
//   openspec/changes/archive/2026-05-28-add-client-event-subscription-management
const EventSubscriptionStatusSchema = {
  type: "string",
  enum: ["pending_verification", "active", "disabled", "disabled_failure", "disabled_revoked", "deleted"],
};

const EventSubscriptionIdPathSchema = {
  type: "object",
  additionalProperties: false,
  properties: { subscription_id: NonEmptyStringSchema },
  required: ["subscription_id"],
};

// The grant-resolved scope echoed back on read. `streams` is the resolved set
// of grant-scoped stream targets; `filters` echoes the caller-supplied stream
// filter when present.
const EventSubscriptionScopeSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    streams: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: NonEmptyStringSchema,
          connection_id: { type: "string" },
        },
        required: ["name"],
      },
    },
    filters: {
      type: "object",
      additionalProperties: false,
      properties: {
        streams: { type: "array", items: NonEmptyStringSchema },
      },
    },
  },
  required: ["streams"],
};

// Client-facing projection of a subscription. Never carries the signing
// secret; the secret is returned only inline on create and secret rotation.
const EventSubscriptionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    subscription_id: NonEmptyStringSchema,
    grant_id: NonEmptyStringSchema,
    client_id: NonEmptyStringSchema,
    callback_url: { type: "string", format: "uri" },
    status: EventSubscriptionStatusSchema,
    scope: EventSubscriptionScopeSchema,
    created_at: { type: "string", format: "date-time" },
    updated_at: { type: "string", format: "date-time" },
    disabled_reason: { type: ["string", "null"] },
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
};

const CreateEventSubscriptionBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    callback_url: {
      type: "string",
      format: "uri",
      maxLength: 2048,
      description:
        "HTTPS endpoint that will receive CloudEvents 1.0 structured-mode JSON POST requests signed with Standard Webhooks headers. `http://localhost` is accepted for development.",
    },
    filters: {
      type: "object",
      additionalProperties: false,
      properties: {
        streams: {
          type: "array",
          items: NonEmptyStringSchema,
          description:
            "Subset of grant-scoped stream names to subscribe to. Omit to subscribe to all streams in the grant.",
        },
      },
    },
  },
  required: ["callback_url"],
};

const CreateEventSubscriptionResponseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    subscription_id: NonEmptyStringSchema,
    secret: {
      type: "string",
      description:
        "Standard Webhooks HMAC signing secret (`whsec_<base64>`). Store securely; returned only on creation and on secret rotation.",
    },
    status: EventSubscriptionStatusSchema,
    callback_url: { type: "string", format: "uri" },
    created_at: { type: "string", format: "date-time" },
  },
  required: ["subscription_id", "secret", "status", "callback_url", "created_at"],
};

const ListEventSubscriptionsResponseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    data: { type: "array", items: EventSubscriptionSchema },
  },
  required: ["data"],
};

const UpdateEventSubscriptionBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    enabled: {
      type: "boolean",
      description:
        "Set to `false` to disable delivery; `true` to re-enable a `disabled` or `disabled_failure` subscription. Cannot re-enable a `disabled_revoked` subscription.",
    },
    rotate_secret: {
      type: "boolean",
      description:
        "Generate a new `whsec_*` signing secret. The new secret is returned in the response body. The old secret is immediately invalid.",
    },
  },
};

const UpdateEventSubscriptionResponseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    subscription: EventSubscriptionSchema,
    secret: {
      type: "string",
      description:
        "New Standard Webhooks signing secret (`whsec_<base64>`). Present only when `rotate_secret` was `true`.",
    },
  },
  required: ["subscription"],
};

const SendTestEventResponseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    event_id: NonEmptyStringSchema,
  },
  required: ["event_id"],
};

// Event subscriptions require an explicit subscription authority: either a
// client_grant bearer for an active grant or a registered trusted_owner_agent
// bearer. Unregistered owner bearers are rejected.
const EventSubscriptionAuthErrors = {
  401: { schema: ErrorObjectSchema, description: "Bearer token missing or invalid" },
  403: {
    schema: ErrorObjectSchema,
    description:
      "Bearer token is authenticated but is neither a `client_grant` authority for an active grant nor a registered `trusted_owner_agent` authority; unregistered owner bearers are rejected.",
  },
};

const EventSubscriptionNotFoundError = {
  404: { schema: ErrorObjectSchema, description: "Subscription not found or not owned by the bearer" },
};

export const publicManifests = [
  {
    id: "getRsDiscoveryIndex",
    method: "GET",
    path: "/",
    surface: "public",
    tags: ["metadata"],
    summary:
      "Unauthenticated cold-start pointer at the resource server root. Names the well-known endpoint, the `/v1/schema` capability discovery surface, the core query base, and the running reference revision so a probe learns the next hop without trial-and-error.",
    responses: {
      200: { schema: DiscoveryIndexResponseSchema },
    },
  },
  {
    // The AS exposes the same discovery shape on its own root with a smaller
    // link set (well_known_authorization_server only). We register a
    // distinct manifest id for the AS surface so the contract registry
    // maintains a 1:1 map between operation ids and route bindings; the
    // generated OpenAPI document deduplicates the two `GET /` entries to
    // avoid a path collision (see openapi/generate.js).
    id: "getAsDiscoveryIndex",
    method: "GET",
    path: "/",
    surface: "public",
    tags: ["metadata"],
    summary:
      "Unauthenticated cold-start pointer at the authorization server root. Names the AS well-known endpoint and the running reference revision so a probe learns the next hop without trial-and-error.",
    responses: {
      200: { schema: DiscoveryIndexResponseSchema },
    },
  },
  {
    id: "getAuthorizationServerMetadata",
    method: "GET",
    path: "/.well-known/oauth-authorization-server",
    surface: "public",
    tags: ["metadata", "oauth"],
    summary: "Return RFC 8414 authorization-server metadata with the reference provider-connect capability extensions.",
    responses: {
      200: { schema: AuthorizationServerMetadataSchema },
    },
  },
  {
    id: "getProtectedResourceMetadata",
    method: "GET",
    path: "/.well-known/oauth-protected-resource",
    surface: "public",
    tags: ["metadata"],
    summary:
      "Return RFC 9728 protected-resource metadata advertising the PDPP query base, owner-self-export, advisory `pdpp_agent_discovery` / `pdpp_owner_agent_onboarding` when safely configured, and capabilities such as `client_event_subscriptions`.",
    responses: {
      200: { schema: ProtectedResourceMetadataSchema },
    },
  },
  {
    id: "getMcpProtectedResourceMetadata",
    method: "GET",
    path: "/.well-known/oauth-protected-resource/mcp",
    surface: "public",
    tags: ["metadata", "mcp", "oauth"],
    summary: "Return RFC 9728 protected-resource metadata for the hosted MCP endpoint.",
    responses: {
      200: { schema: ProtectedResourceMetadataSchema },
    },
  },
  {
    id: "registerDynamicClient",
    method: "POST",
    path: "/oauth/register",
    surface: "public",
    tags: ["oauth"],
    summary: "Register a public client through the reference dynamic client registration profile.",
    request: {
      body: {
        contentType: "application/json",
        schema: DynamicClientRegistrationRequestSchema,
      },
    },
    responses: {
      201: { schema: DynamicClientRegistrationResponseSchema, description: "Client registered" },
      400: { schema: OAuthErrorSchema, description: "Invalid client metadata" },
      401: { schema: OAuthErrorSchema, description: "Missing or invalid initial access token" },
      404: { schema: OAuthErrorSchema, description: "Dynamic client registration is disabled" },
    },
  },
  {
    id: "createPushedAuthorizationRequest",
    method: "POST",
    path: "/oauth/par",
    surface: "public",
    tags: ["grants"],
    summary: "Stage a PDPP data-access request and receive a pending-consent request_uri plus authorization URL.",
    request: {
      body: {
        contentType: "application/json",
        schema: GrantInitiationRequestSchema,
      },
    },
    responses: {
      201: { schema: GrantInitiationResponseSchema, description: "Pending consent request created" },
      400: { schema: ErrorObjectSchema, description: "Invalid request" },
      403: {
        schema: ErrorObjectSchema,
        description: "Request rejected because the resolved grant contract is invalid",
      },
    },
  },
  {
    id: "approveConsent",
    method: "POST",
    path: "/consent/approve",
    surface: "public",
    tags: ["grants"],
    summary: "Approve a pending data-access request through the JSON consent surface used by tests and automation.",
    request: {
      body: {
        contentType: "application/json",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            request_uri: NonEmptyStringSchema,
            subject_id: NonEmptyStringSchema,
            ai_training_consented: { type: "boolean" },
            approved_source_indexes: {
              oneOf: [
                { type: "integer", minimum: 0 },
                { type: "string", pattern: "^[0-9]+$" },
                {
                  type: "array",
                  items: {
                    oneOf: [
                      { type: "integer", minimum: 0 },
                      { type: "string", pattern: "^[0-9]+$" },
                    ],
                  },
                },
              ],
            },
            confirm_approve_all: {
              oneOf: [{ type: "boolean" }, { type: "string", enum: ["true", "1", "on"] }],
            },
          },
          required: ["request_uri"],
        },
      },
    },
    responses: {
      200: { schema: GrantApprovalResponseSchema, description: "Grant approved and client token issued" },
      400: { schema: ErrorObjectSchema, description: "Invalid request" },
      403: { schema: ErrorObjectSchema, description: "Grant is malformed or no longer valid" },
      404: { schema: ErrorObjectSchema, description: "Pending consent request not found" },
    },
  },
  {
    id: "exchangeConsentCode",
    method: "POST",
    path: "/consent/exchange",
    surface: "public",
    tags: ["grants"],
    summary:
      "Redeem a short-lived single-use consent exchange code from the hosted HTML consent flow for the client token.",
    request: {
      body: {
        contentType: "application/json",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            code: NonEmptyStringSchema,
          },
          required: ["code"],
        },
      },
    },
    responses: {
      200: { schema: GrantApprovalResponseSchema, description: "Exchange code redeemed and client token issued" },
      400: { schema: ErrorObjectSchema, description: "Invalid request" },
      404: { schema: ErrorObjectSchema, description: "Unknown exchange code" },
      410: { schema: ErrorObjectSchema, description: "Exchange code expired or already redeemed" },
    },
  },
  {
    id: "startOwnerDeviceAuthorization",
    method: "POST",
    path: "/oauth/device_authorization",
    surface: "public",
    tags: ["oauth"],
    summary: "Start the owner device flow used for owner-self-export and dashboard bootstrap.",
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
  },
  {
    id: "exchangeOwnerDeviceToken",
    method: "POST",
    path: "/oauth/token",
    surface: "public",
    tags: ["oauth"],
    summary: "Exchange an OAuth device code, authorization code, or refresh token for a bearer token.",
    request: {
      body: {
        contentType: "application/x-www-form-urlencoded",
        schema: OAuthTokenRequestSchema,
      },
    },
    responses: {
      200: { schema: OAuthTokenResponseSchema },
      ...OAuthFlowErrors,
      500: { schema: OAuthErrorSchema, description: "Server error while exchanging the device code" },
    },
  },
  {
    id: "introspectToken",
    method: "POST",
    path: "/introspect",
    surface: "public",
    tags: ["oauth"],
    summary: "Inspect token activity and, for active client tokens, the bound grant projection.",
    request: {
      body: {
        contentType: "application/x-www-form-urlencoded",
        schema: IntrospectionRequestSchema,
      },
    },
    responses: {
      200: { schema: IntrospectionResponseSchema },
      400: { schema: ErrorObjectSchema, description: "Missing token parameter" },
    },
  },
  {
    id: "revokeGrant",
    method: "POST",
    path: "/grants/{grantId}/revoke",
    surface: "public",
    tags: ["grants"],
    summary: "Revoke a grant and all tokens minted from it.",
    request: {
      params: GrantIdPathSchema,
    },
    responses: {
      200: { schema: RevokeGrantResponseSchema },
      403: { schema: ErrorObjectSchema, description: "Grant is malformed or no longer valid" },
    },
  },
  {
    id: "listConnectors",
    method: "GET",
    path: "/v1/connectors",
    surface: "public",
    tags: ["records"],
    summary:
      "List connector or source boundaries visible under the bearer token, with stream summaries and coarse capability hints.",
    request: {
      headers: AuthHeaderSchema,
    },
    responses: {
      200: { schema: ConnectorListResponseSchema },
      ...ProtectedReadErrors,
    },
  },
  {
    id: "getSchema",
    method: "GET",
    path: "/v1/schema",
    surface: "public",
    tags: ["records"],
    summary:
      "Return the caller-visible source/stream capability graph. Use `view=compact` and optional `stream=<name>` for a token-efficient agent discovery step; omitted `view` returns the full schema, query declarations, field capabilities, expand capabilities, and freshness.",
    request: {
      headers: AuthHeaderSchema,
      query: SchemaQuerySchema,
    },
    responses: {
      200: { schema: SchemaResponseSchema },
      ...ProtectedReadErrors,
    },
  },
  {
    id: "listStreams",
    method: "GET",
    path: "/v1/streams",
    surface: "public",
    tags: ["records"],
    summary:
      "List streams available under the current grant or owner scope. Returns stream-level totals only; for per-field filter capabilities (exact, range operators, aggregation) call `GET /v1/schema` first and consult `field_capabilities` per stream before issuing `filter[...]` queries on `/v1/streams/{stream}/records`. Multi-connection deployments emit one entry per (stream, connection_id); each entry carries `connection_id` and a `display_name` so callers can attribute and disambiguate.",
    request: {
      headers: AuthHeaderSchema,
      query: {
        type: "object",
        additionalProperties: false,
        properties: {
          connector_id: { type: "string" },
          subject_id: { type: "string" },
          connection_id: ConnectionIdSchema,
          connector_instance_id: ConnectorInstanceIdAliasSchema,
        },
      },
    },
    responses: {
      200: { schema: StreamListResponseSchema },
      ...ProtectedReadErrors,
    },
  },
  {
    id: "getStreamMetadata",
    method: "GET",
    path: "/v1/streams/{stream}",
    surface: "public",
    tags: ["records"],
    summary:
      "Return stream metadata including declared query capabilities and advisory freshness. For per-field filter capabilities on this stream (exact, range operators, aggregation), prefer `GET /v1/schema` first and read `field_capabilities` rather than guessing `filter[...]` shapes against the records endpoint. Pass `connection_id` (or the deprecated `connector_instance_id` alias) to restrict to a single connection; omitted, the response aggregates across the connections the grant authorizes.",
    request: {
      headers: AuthHeaderSchema,
      params: StreamNamePathSchema,
      query: {
        type: "object",
        additionalProperties: false,
        properties: {
          connector_id: { type: "string" },
          subject_id: { type: "string" },
          connection_id: ConnectionIdSchema,
          connector_instance_id: ConnectorInstanceIdAliasSchema,
        },
      },
    },
    responses: {
      200: { schema: StreamMetadataResponseSchema },
      ...ProtectedReadErrors,
    },
  },
  {
    id: "listRecords",
    method: "GET",
    path: "/v1/streams/{stream}/records",
    surface: "public",
    tags: ["records"],
    summary:
      "List records in a stream under grant enforcement. Supports logical-cursor pagination, exact and declared range filters, declared one-hop expansion, and changes_since. Per-field filter operators, sortable fields, expandable relations, projection, search modes, and count support are advertised by `GET /v1/schema` (`field_capabilities`, `expand_capabilities`); consult it before issuing `filter[...]`, `expand[]`, or `fields=` shapes to avoid 400 errors. Pass `connection_id` to restrict to one connection; the deprecated `connector_instance_id` alias is accepted for compatibility but new clients SHOULD use `connection_id`.",
    request: {
      headers: AuthHeaderSchema,
      params: StreamNamePathSchema,
      query: ListRecordsQuerySchema,
    },
    responses: {
      200: { schema: RecordsListResponseSchema },
      ...ListRecordErrors,
    },
  },
  {
    id: "aggregateStream",
    method: "GET",
    path: "/v1/streams/{stream}/aggregate",
    surface: "public",
    tags: ["records"],
    summary:
      "Compute a single-stream grant-safe aggregation. Supports count, numeric sum, numeric/date min/max, exact count_distinct, scalar grouped counts (`group_by`), calendar time-bucket counts (`group_by_time`+`granularity`, optional `time_zone` defaulting to UTC), and existing exact/range filters over declared fields. Exactly one grouping dimension per call: `group_by` XOR `group_by_time`.",
    request: {
      headers: AuthHeaderSchema,
      params: StreamNamePathSchema,
      query: AggregateQuerySchema,
    },
    responses: {
      200: { schema: AggregationResponseSchema },
      ...ProtectedReadErrors,
    },
  },
  {
    id: "getRecord",
    method: "GET",
    path: "/v1/streams/{stream}/records/{id}",
    surface: "public",
    tags: ["records"],
    summary:
      "Fetch a single record by primary key under grant enforcement, with optional declared one-hop expansion. Expandable relations and the per-relation `expand_limit` ceiling are advertised by `GET /v1/schema` (`expand_capabilities`); requesting an unadvertised relation is rejected rather than silently ignored. When the identifier resolves to more than one connection under the caller's grant and `connection_id` is omitted, returns a typed `ambiguous_connection` (409) error with `available_connections` and retry guidance instead of silently picking one. The deprecated `connector_instance_id` alias is accepted for compatibility but new clients SHOULD use `connection_id`.",
    request: {
      headers: AuthHeaderSchema,
      params: RecordIdPathSchema,
      query: {
        type: "object",
        additionalProperties: false,
        properties: {
          expand: { type: "array", items: { type: "string" } },
          expand_limit: { type: "object" },
          connector_id: { type: "string" },
          subject_id: { type: "string" },
          connection_id: ConnectionIdSchema,
          connector_instance_id: ConnectorInstanceIdAliasSchema,
        },
      },
    },
    responses: {
      200: { schema: RecordSchema },
      ...ProtectedReadWithAmbiguityErrors,
    },
  },
  {
    id: "searchRecordsLexical",
    method: "GET",
    path: "/v1/search",
    surface: "public",
    tags: ["records", "lexical-retrieval"],
    summary:
      "Optional lexical retrieval extension: search records across authorized streams by text. Search modes, per-mode cursor support, and field-level `lexical_search`/`semantic_search` capabilities are advertised by `GET /v1/schema`; `filter[...]` operators applied to a single named stream must come from that stream's `field_capabilities`. Hits carry `connection_id` for attribution; the deprecated `connector_instance_id` alias is emitted alongside for compatibility but new clients SHOULD read `connection_id`.",
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
        type: "object",
        additionalProperties: false,
        properties: {
          q: NonEmptyStringSchema,
          limit: { type: "integer", minimum: 1, maximum: 100 },
          cursor: CursorSchema,
          streams: {
            anyOf: [NonEmptyStringSchema, { type: "array", items: NonEmptyStringSchema, minItems: 1 }],
          },
          filter: {
            type: "object",
            additionalProperties: true,
          },
          connection_id: ConnectionIdSchema,
          connector_instance_id: ConnectorInstanceIdAliasSchema,
        },
        required: ["q"],
      },
    },
    responses: {
      200: {
        schema: {
          type: "object",
          additionalProperties: true,
          properties: {
            object: { const: "list" },
            url: { type: "string" },
            has_more: { type: "boolean" },
            next_cursor: { type: "string" },
            data: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: true,
                properties: {
                  object: { const: "search_result" },
                  stream: NonEmptyStringSchema,
                  record_key: NonEmptyStringSchema,
                  connector_id: NonEmptyStringSchema,
                  connection_id: ConnectionIdSchema,
                  display_name: ConnectionDisplayNameSchema,
                  connector_instance_id: ConnectorInstanceIdAliasSchema,
                  record_url: { type: "string" },
                  emitted_at: NonEmptyStringSchema,
                  score: RetrievalScoreSchema,
                  matched_fields: {
                    type: "array",
                    minItems: 1,
                    items: NonEmptyStringSchema,
                  },
                  snippet: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      field: NonEmptyStringSchema,
                      text: { type: "string" },
                    },
                    required: ["field", "text"],
                  },
                },
                required: ["object", "stream", "record_key", "connector_id", "emitted_at", "matched_fields"],
              },
            },
          },
          required: ["object", "data", "has_more"],
        },
      },
      400: {
        schema: ErrorObjectSchema,
        description: "Invalid request (e.g. unsupported v1 query parameter, missing q)",
      },
      401: { schema: ErrorObjectSchema, description: "Missing or invalid access token" },
      403: { schema: ErrorObjectSchema, description: "Grant does not permit a named stream (client tokens only)" },
      410: { schema: ErrorObjectSchema, description: "Cursor expired or refers to an unknown snapshot" },
    },
  },
  {
    id: "searchRecordsSemantic",
    method: "GET",
    path: "/v1/search/semantic",
    surface: "public",
    tags: ["records", "semantic-retrieval"],
    summary:
      "Experimental optional extension: semantic retrieval across authorized streams by text. See the semantic-retrieval capability spec. Unstable in v1. Per-stream semantic capability and pagination support are advertised by `GET /v1/schema` and the `capabilities.semantic_retrieval` block in protected-resource metadata; consult them before relying on cursors or filters. Hits carry `connection_id` for attribution; the deprecated `connector_instance_id` alias is emitted for compatibility only.",
    request: {
      headers: AuthHeaderSchema,
      // additionalProperties: false locks the v1 param allowlist at the schema
      // layer in addition to the runtime check in search-semantic.js. Raw
      // vectors, client-supplied embeddings, model selectors, and ranking
      // knobs are intentionally NOT in the allowlist.
      // `connection_id` / `connector_instance_id` are additive optional
      // filters per `expose-connection-identity-on-public-read`.
      query: {
        type: "object",
        additionalProperties: false,
        properties: {
          q: NonEmptyStringSchema,
          limit: { type: "integer", minimum: 1, maximum: 100 },
          cursor: CursorSchema,
          streams: {
            anyOf: [NonEmptyStringSchema, { type: "array", items: NonEmptyStringSchema, minItems: 1 }],
          },
          filter: {
            type: "object",
            additionalProperties: true,
          },
          connection_id: ConnectionIdSchema,
          connector_instance_id: ConnectorInstanceIdAliasSchema,
        },
        required: ["q"],
      },
    },
    responses: {
      200: {
        schema: {
          type: "object",
          additionalProperties: true,
          properties: {
            object: { const: "list" },
            url: { type: "string" },
            has_more: { type: "boolean" },
            next_cursor: { type: "string" },
            data: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: true,
                properties: {
                  object: { const: "search_result" },
                  stream: NonEmptyStringSchema,
                  record_key: NonEmptyStringSchema,
                  connector_id: NonEmptyStringSchema,
                  connection_id: ConnectionIdSchema,
                  display_name: ConnectionDisplayNameSchema,
                  connector_instance_id: ConnectorInstanceIdAliasSchema,
                  record_url: { type: "string" },
                  emitted_at: NonEmptyStringSchema,
                  score: RetrievalScoreSchema,
                  matched_fields: {
                    type: "array",
                    items: NonEmptyStringSchema,
                  },
                  retrieval_mode: {
                    type: "string",
                    enum: ["semantic", "hybrid"],
                  },
                  snippet: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      field: NonEmptyStringSchema,
                      text: { type: "string" },
                    },
                    required: ["field", "text"],
                  },
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
              },
            },
          },
          required: ["object", "data", "has_more"],
        },
      },
      400: {
        schema: ErrorObjectSchema,
        description: "Invalid request (e.g. unsupported v1 query parameter, missing q)",
      },
      401: { schema: ErrorObjectSchema, description: "Missing or invalid access token" },
      403: { schema: ErrorObjectSchema, description: "Grant does not permit a named stream (client tokens only)" },
      410: { schema: ErrorObjectSchema, description: "Cursor expired or refers to an unknown snapshot" },
    },
  },
  {
    id: "searchRecordsHybrid",
    method: "GET",
    path: "/v1/search/hybrid",
    surface: "public",
    tags: ["records", "hybrid-retrieval"],
    summary:
      "Experimental optional extension: hybrid retrieval blending lexical and semantic recall under one grant-safe result list. See the hybrid-retrieval capability spec. Hybrid does NOT support cursor pagination on this reference; check `pdpp_discovery_hints.hybrid_pagination_supported` in the protected-resource metadata and, when it is `false` or absent, fall back to `GET /v1/search` (lexical) which supports `cursor`.",
    request: {
      headers: AuthHeaderSchema,
      // Mirrors the lexical + semantic allowlists. v1 intentionally omits
      // cursor/pagination knobs (see the hybrid-retrieval spec: first-tranche
      // servers either encode snapshot-honest cursors or omit cursor support
      // entirely). The reference rejects cursor to keep pagination honest.
      // `connection_id` / `connector_instance_id` are additive optional
      // filters per `expose-connection-identity-on-public-read`.
      query: {
        type: "object",
        additionalProperties: false,
        properties: {
          q: NonEmptyStringSchema,
          limit: { type: "integer", minimum: 1, maximum: 100 },
          streams: {
            anyOf: [NonEmptyStringSchema, { type: "array", items: NonEmptyStringSchema, minItems: 1 }],
          },
          filter: {
            type: "object",
            additionalProperties: true,
          },
          connection_id: ConnectionIdSchema,
          connector_instance_id: ConnectorInstanceIdAliasSchema,
        },
        required: ["q"],
      },
    },
    responses: {
      200: {
        schema: {
          type: "object",
          additionalProperties: true,
          properties: {
            object: { const: "list" },
            url: { type: "string" },
            has_more: { type: "boolean" },
            data: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: true,
                properties: {
                  object: { const: "search_result" },
                  stream: NonEmptyStringSchema,
                  record_key: NonEmptyStringSchema,
                  connector_id: NonEmptyStringSchema,
                  connection_id: ConnectionIdSchema,
                  display_name: ConnectionDisplayNameSchema,
                  connector_instance_id: ConnectorInstanceIdAliasSchema,
                  record_url: { type: "string" },
                  emitted_at: NonEmptyStringSchema,
                  matched_fields: {
                    type: "array",
                    items: NonEmptyStringSchema,
                  },
                  retrieval_mode: { const: "hybrid" },
                  retrieval_sources: {
                    type: "array",
                    minItems: 1,
                    items: { type: "string", enum: ["lexical", "semantic"] },
                  },
                  scores: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      lexical: RetrievalScoreSchema,
                      semantic: RetrievalScoreSchema,
                    },
                  },
                  snippet: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      field: NonEmptyStringSchema,
                      text: { type: "string" },
                    },
                    required: ["field", "text"],
                  },
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
              },
            },
          },
          required: ["object", "data", "has_more"],
        },
      },
      400: {
        schema: ErrorObjectSchema,
        description: "Invalid request (e.g. unsupported v1 query parameter, missing q, cursor parameter)",
      },
      401: { schema: ErrorObjectSchema, description: "Missing or invalid access token" },
      403: { schema: ErrorObjectSchema, description: "Grant does not permit a named stream (client tokens only)" },
      404: { schema: ErrorObjectSchema, description: "Hybrid retrieval not advertised on this server" },
    },
  },
  {
    id: "uploadBlob",
    method: "POST",
    path: "/v1/blobs",
    surface: "public",
    tags: ["records"],
    summary: "Upload connector/runtime-owned blob bytes for a bound record.",
    request: {
      headers: AuthHeaderSchema,
      query: UploadBlobQuerySchema,
      body: {
        contentType: "application/octet-stream",
        schema: { type: "string", format: "binary" },
      },
    },
    responses: {
      200: {
        schema: BlobObjectSchema,
        description: "Canonical content-addressed blob identity for the uploaded bytes",
      },
      400: { schema: ErrorObjectSchema, description: "Invalid upload request" },
      401: { schema: ErrorObjectSchema, description: "Missing or invalid access token" },
      403: { schema: ErrorObjectSchema, description: "Owner/runtime authority required" },
      404: { schema: ErrorObjectSchema, description: "Unknown connector or stream" },
    },
  },
  {
    id: "getBlob",
    method: "GET",
    path: "/v1/blobs/{blob_id}",
    surface: "public",
    tags: ["records"],
    summary:
      "Fetch blob bytes authorized by the caller having discovered the referencing record under grant. When the blob identifier resolves to more than one connection under the caller's grant and `connection_id` is omitted, returns a typed `ambiguous_connection` (409) error with `available_connections` and retry guidance instead of silently picking one. The deprecated `connector_instance_id` alias is accepted for compatibility but new clients SHOULD use `connection_id`.",
    request: {
      headers: AuthHeaderSchema,
      params: {
        type: "object",
        additionalProperties: false,
        properties: { blob_id: { type: "string", minLength: 1 } },
        required: ["blob_id"],
      },
      query: {
        type: "object",
        additionalProperties: false,
        properties: {
          connection_id: ConnectionIdSchema,
          connector_instance_id: ConnectorInstanceIdAliasSchema,
        },
      },
    },
    responses: {
      200: { description: "Blob bytes", contentType: "application/octet-stream" },
      ...ProtectedReadWithAmbiguityErrors,
    },
  },
  {
    id: "createEventSubscription",
    method: "POST",
    path: "/v1/event-subscriptions",
    surface: "public",
    tags: ["event-subscriptions"],
    summary:
      "Create an event subscription for the bearer's explicit authority (`client_grant` or registered `trusted_owner_agent`). Immediately enqueues a `pdpp.subscription.verify` event to the callback URL. The subscription stays in `pending_verification` until the receiver echoes the `challenge` value. Returns the per-subscription HMAC signing secret (`whsec_*`) once; it cannot be retrieved again.",
    request: {
      body: { contentType: "application/json", schema: CreateEventSubscriptionBodySchema },
    },
    responses: {
      201: {
        schema: CreateEventSubscriptionResponseSchema,
        description:
          "Subscription created. The `secret` field is the Standard Webhooks signing key (`whsec_<base64>`) and is returned only on creation.",
      },
      400: {
        schema: ErrorObjectSchema,
        description: "Invalid request (callback URL malformed, filters not in grant, etc.)",
      },
      ...EventSubscriptionAuthErrors,
    },
  },
  {
    id: "listEventSubscriptions",
    method: "GET",
    path: "/v1/event-subscriptions",
    surface: "public",
    tags: ["event-subscriptions"],
    summary:
      "List all non-deleted event subscriptions for the bearer's authority tuple (`authority_kind`, `client_id`, `subject_id`, and `grant_id` when `client_grant`).",
    responses: {
      200: { schema: ListEventSubscriptionsResponseSchema },
      ...EventSubscriptionAuthErrors,
    },
  },
  {
    id: "getEventSubscription",
    method: "GET",
    path: "/v1/event-subscriptions/{subscription_id}",
    surface: "public",
    tags: ["event-subscriptions"],
    summary: "Get a single event subscription owned by the bearer.",
    request: { params: EventSubscriptionIdPathSchema },
    responses: {
      200: { schema: EventSubscriptionSchema },
      ...EventSubscriptionAuthErrors,
      ...EventSubscriptionNotFoundError,
    },
  },
  {
    id: "updateEventSubscription",
    method: "PATCH",
    path: "/v1/event-subscriptions/{subscription_id}",
    surface: "public",
    tags: ["event-subscriptions"],
    summary:
      "Update an event subscription. Toggle `enabled` to disable or re-enable delivery. Set `rotate_secret` to true to generate a new signing secret (returned in the response body; old secret is immediately invalid).",
    request: {
      params: EventSubscriptionIdPathSchema,
      body: { contentType: "application/json", schema: UpdateEventSubscriptionBodySchema },
    },
    responses: {
      200: {
        schema: UpdateEventSubscriptionResponseSchema,
        description: "Updated subscription. `secret` is only present when `rotate_secret` was `true`.",
      },
      400: { schema: ErrorObjectSchema, description: "Invalid update (e.g. re-enabling a revoked subscription)" },
      ...EventSubscriptionAuthErrors,
      ...EventSubscriptionNotFoundError,
      409: {
        schema: ErrorObjectSchema,
        description: "State conflict (e.g. re-enabling a `disabled_revoked` subscription)",
      },
    },
  },
  {
    id: "deleteEventSubscription",
    method: "DELETE",
    path: "/v1/event-subscriptions/{subscription_id}",
    surface: "public",
    tags: ["event-subscriptions"],
    summary:
      "Delete an event subscription. Queued undelivered events are dropped. Idempotent for the caller's authority tuple (`authority_kind`, `client_id`, `subject_id`, and `grant_id` when `client_grant`).",
    request: { params: EventSubscriptionIdPathSchema },
    responses: {
      204: { description: "Subscription deleted." },
      ...EventSubscriptionAuthErrors,
      ...EventSubscriptionNotFoundError,
    },
  },
  {
    id: "sendTestEvent",
    method: "POST",
    path: "/v1/event-subscriptions/{subscription_id}/test-event",
    surface: "public",
    tags: ["event-subscriptions"],
    summary:
      "Enqueue a `pdpp.subscription.test` event for asynchronous delivery to the subscription's callback URL. Accepted for `active` and `pending_verification` subscriptions. Returns the enqueued event ID.",
    request: { params: EventSubscriptionIdPathSchema },
    responses: {
      202: { schema: SendTestEventResponseSchema, description: "Test event accepted for delivery." },
      ...EventSubscriptionAuthErrors,
      ...EventSubscriptionNotFoundError,
      409: {
        schema: ErrorObjectSchema,
        description:
          "Subscription is not in a state that accepts test events (must be `active` or `pending_verification`)",
      },
    },
  },
];
