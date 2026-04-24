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
  OAuthErrorSchema,
  OrderSchema,
  UriSchema,
} from "../common/index.ts";

const NonEmptyStringSchema = {
  type: "string",
  minLength: 1,
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
    filter: { type: "object" },
    expand: { type: "array", items: NonEmptyStringSchema },
    expand_limit: { type: "object" },
    connector_id: { type: "string" },
    subject_id: { type: "string" },
  },
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
  },
  required: ["name"],
};

const AuthorizationDetailBaseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    type: { const: "https://pdpp.org/data-access" },
    connector_id: NonEmptyStringSchema,
    provider_id: NonEmptyStringSchema,
    purpose_code: NonEmptyStringSchema,
    purpose_description: NonEmptyStringSchema,
    access_mode: { type: "string", enum: ["single_use", "continuous"] },
    retention: RetentionSchema,
    streams: { type: "array", minItems: 1, items: StreamSelectionSchema },
  },
  required: ["type", "purpose_code", "access_mode", "streams"],
};

const AuthorizationDetailSchema = {
  allOf: [
    AuthorizationDetailBaseSchema,
    {
      oneOf: [{ required: ["connector_id"] }, { required: ["provider_id"] }],
    },
  ],
};

const GrantSourceSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    binding_kind: { type: "string", enum: ["connector", "provider_native"] },
    connector_id: NonEmptyStringSchema,
    provider_id: NonEmptyStringSchema,
  },
  required: ["binding_kind"],
};

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
    source: GrantSourceSchema,
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
    "pdpp_authorization_details_types_supported",
    "token_endpoint",
    "token_endpoint_auth_methods_supported",
    "device_authorization_endpoint",
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
  },
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
    client_uri: { type: ["string", "null"] },
    logo_uri: { type: ["string", "null"] },
    policy_uri: { type: ["string", "null"] },
    tos_uri: { type: ["string", "null"] },
  },
  required: [
    "client_id",
    "client_id_issued_at",
    "token_endpoint_auth_method",
    "client_name",
    "client_uri",
    "logo_uri",
    "policy_uri",
    "tos_uri",
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
      maxItems: 1,
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
  },
  required: ["object", "data", "has_more"],
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
      },
    },
    field_capabilities: {
      type: "object",
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        properties: {
          schema: { type: "object", additionalProperties: true },
          granted: { type: "boolean" },
          exact_filter: {
            type: "object",
            additionalProperties: false,
            properties: {
              declared: { type: "boolean" },
              usable: { type: "boolean" },
              reason: { type: "string" },
            },
            required: ["declared", "usable"],
          },
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
          lexical_search: {
            type: "object",
            additionalProperties: false,
            properties: {
              declared: { type: "boolean" },
              usable: { type: "boolean" },
              reason: { type: "string" },
            },
            required: ["declared", "usable"],
          },
          semantic_search: {
            type: "object",
            additionalProperties: false,
            properties: {
              declared: { type: "boolean" },
              usable: { type: "boolean" },
              reason: { type: "string" },
            },
            required: ["declared", "usable"],
          },
        },
        required: [
          "schema",
          "granted",
          "exact_filter",
          "range_filter",
          "lexical_search",
          "semantic_search",
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
          stream: NonEmptyStringSchema,
          cardinality: { type: "string", enum: ["has_one", "has_many"] },
          foreign_key: NonEmptyStringSchema,
          default_limit: { type: "integer", minimum: 1 },
          max_limit: { type: "integer", minimum: 1 },
          granted: { type: "boolean" },
          usable: { type: "boolean" },
          reason: { type: "string" },
        },
        required: ["name", "stream", "cardinality", "granted", "usable"],
      },
    },
    freshness: FreshnessSchema,
  },
  required: ["object", "name", "field_capabilities", "expand_capabilities"],
};

const AuthHeaderSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    authorization: { type: "string", pattern: "^Bearer " },
  },
  required: ["authorization"],
};

const ProtectedReadErrors = {
  400: { schema: ErrorObjectSchema, description: "Invalid request" },
  401: { schema: ErrorObjectSchema, description: "Missing or invalid access token" },
  403: { schema: ErrorObjectSchema, description: "Grant does not permit this request" },
  404: { schema: ErrorObjectSchema, description: "Stream or record not found" },
};

const ListRecordErrors = {
  ...ProtectedReadErrors,
  410: { schema: ErrorObjectSchema, description: "Cursor expired" },
};

const OAuthFlowErrors = {
  400: { schema: OAuthErrorSchema, description: "OAuth request rejected" },
};

export const publicManifests = [
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
      "Return RFC 9728 protected-resource metadata advertising the PDPP query base and owner-self-export capabilities.",
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
    summary: "Exchange an approved owner device_code for an owner bearer token.",
    request: {
      body: {
        contentType: "application/x-www-form-urlencoded",
        schema: OwnerDeviceTokenRequestSchema,
      },
    },
    responses: {
      200: { schema: AccessTokenResponseSchema },
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
    id: "listStreams",
    method: "GET",
    path: "/v1/streams",
    surface: "public",
    tags: ["records"],
    summary: "List streams available under the current grant or owner scope.",
    request: {
      headers: AuthHeaderSchema,
      query: {
        type: "object",
        additionalProperties: false,
        properties: {
          connector_id: { type: "string" },
          subject_id: { type: "string" },
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
    summary: "Return stream metadata including declared query capabilities and advisory freshness.",
    request: {
      headers: AuthHeaderSchema,
      params: StreamNamePathSchema,
      query: {
        type: "object",
        additionalProperties: false,
        properties: {
          connector_id: { type: "string" },
          subject_id: { type: "string" },
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
      "List records in a stream under grant enforcement. Supports logical-cursor pagination, exact and declared range filters, and changes_since.",
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
    id: "getRecord",
    method: "GET",
    path: "/v1/streams/{stream}/records/{id}",
    surface: "public",
    tags: ["records"],
    summary: "Fetch a single record by primary key under grant enforcement, with optional declared expansion.",
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
        },
      },
    },
    responses: {
      200: { schema: RecordSchema },
      ...ProtectedReadErrors,
    },
  },
  {
    id: "searchRecordsLexical",
    method: "GET",
    path: "/v1/search",
    surface: "public",
    tags: ["records", "lexical-retrieval"],
    summary:
      "Optional lexical retrieval extension: search records across authorized streams by text. See the lexical-retrieval capability spec.",
    request: {
      headers: AuthHeaderSchema,
      // additionalProperties: false locks the v1 param allowlist at the schema
      // layer in addition to the runtime check in search.js. connector_id is
      // intentionally NOT in the allowlist — owner-mode search is
      // cross-connector with no public connector-scope param. See:
      //   openspec/changes/add-lexical-retrieval-extension/specs/lexical-retrieval/spec.md
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
                  record_url: { type: "string" },
                  emitted_at: NonEmptyStringSchema,
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
      "Experimental optional extension: semantic retrieval across authorized streams by text. See the semantic-retrieval capability spec. Unstable in v1.",
    request: {
      headers: AuthHeaderSchema,
      // additionalProperties: false locks the v1 param allowlist at the schema
      // layer in addition to the runtime check in search-semantic.js. Raw
      // vectors, client-supplied embeddings, model selectors, and ranking
      // knobs are intentionally NOT in the allowlist.
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
                  record_url: { type: "string" },
                  emitted_at: NonEmptyStringSchema,
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
    summary: "Fetch blob bytes authorized by the caller having discovered the referencing record under grant.",
    request: {
      headers: AuthHeaderSchema,
      params: {
        type: "object",
        additionalProperties: false,
        properties: { blob_id: { type: "string", minLength: 1 } },
        required: ["blob_id"],
      },
    },
    responses: {
      200: { description: "Blob bytes", contentType: "application/octet-stream" },
      ...ProtectedReadErrors,
    },
  },
];
