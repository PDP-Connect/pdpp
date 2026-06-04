# PDPP reference-implementation public API

Generated from `packages/reference-contract/src/public/`. Do not edit by hand.

| Method | Path | Operation | Summary |
|--------|------|-----------|---------|
| **GET** | `/` | `getRsDiscoveryIndex` | Unauthenticated cold-start pointer at the resource server root. Names the well-known endpoint, the `/v1/schema` capability discovery surface, the core query base, and the running reference revision so a probe learns the next hop without trial-and-error. |
| **GET** | `/` | `getAsDiscoveryIndex` | Unauthenticated cold-start pointer at the authorization server root. Names the AS well-known endpoint and the running reference revision so a probe learns the next hop without trial-and-error. |
| **GET** | `/.well-known/oauth-authorization-server` | `getAuthorizationServerMetadata` | Return RFC 8414 authorization-server metadata with the reference provider-connect capability extensions. |
| **GET** | `/.well-known/oauth-protected-resource` | `getProtectedResourceMetadata` | Return RFC 9728 protected-resource metadata advertising the PDPP query base, owner-self-export, advisory `pdpp_agent_discovery` / `pdpp_owner_agent_onboarding` when safely configured, and capabilities such as `client_event_subscriptions`. |
| **GET** | `/.well-known/oauth-protected-resource/mcp` | `getMcpProtectedResourceMetadata` | Return RFC 9728 protected-resource metadata for the hosted MCP endpoint. |
| **POST** | `/oauth/register` | `registerDynamicClient` | Register a public client through the reference dynamic client registration profile. |
| **POST** | `/oauth/par` | `createPushedAuthorizationRequest` | Stage a PDPP data-access request and receive a pending-consent request_uri plus authorization URL. |
| **POST** | `/consent/approve` | `approveConsent` | Approve a pending data-access request through the JSON consent surface used by tests and automation. |
| **POST** | `/consent/exchange` | `exchangeConsentCode` | Redeem a short-lived single-use consent exchange code from the hosted HTML consent flow for the client token. |
| **POST** | `/oauth/device_authorization` | `startOwnerDeviceAuthorization` | Start the owner device flow used for owner-self-export and dashboard bootstrap. |
| **POST** | `/oauth/token` | `exchangeOwnerDeviceToken` | Exchange an OAuth device code, authorization code, or refresh token for a bearer token. |
| **POST** | `/introspect` | `introspectToken` | Inspect token activity and, for active client tokens, the bound grant projection. |
| **POST** | `/grants/{grantId}/revoke` | `revokeGrant` | Revoke a grant and all tokens minted from it. |
| **GET** | `/v1/connectors` | `listConnectors` | List connector or source boundaries visible under the bearer token, with stream summaries and coarse capability hints. |
| **GET** | `/v1/schema` | `getSchema` | Return the caller-visible source/stream capability graph. Use `view=compact` and optional `stream=<name>` for a token-efficient agent discovery step; omitted `view` returns the full schema, query declarations, field capabilities, expand capabilities, and freshness. |
| **GET** | `/v1/streams` | `listStreams` | List streams available under the current grant or owner scope. Returns stream-level totals only; for per-field filter capabilities (exact, range operators, aggregation) call `GET /v1/schema` first and consult `field_capabilities` per stream before issuing `filter[...]` queries on `/v1/streams/{stream}/records`. Multi-connection deployments emit one entry per (stream, connection_id); each entry carries `connection_id` and a `display_name` so callers can attribute and disambiguate. |
| **GET** | `/v1/streams/{stream}` | `getStreamMetadata` | Return stream metadata including declared query capabilities and advisory freshness. For per-field filter capabilities on this stream (exact, range operators, aggregation), prefer `GET /v1/schema` first and read `field_capabilities` rather than guessing `filter[...]` shapes against the records endpoint. Pass `connection_id` (or the deprecated `connector_instance_id` alias) to restrict to a single connection; omitted, the response aggregates across the connections the grant authorizes. |
| **GET** | `/v1/streams/{stream}/records` | `listRecords` | List records in a stream under grant enforcement. Supports logical-cursor pagination, exact and declared range filters, declared one-hop expansion, and changes_since. Per-field filter operators, sortable fields, expandable relations, projection, search modes, and count support are advertised by `GET /v1/schema` (`field_capabilities`, `expand_capabilities`); consult it before issuing `filter[...]`, `expand[]`, or `fields=` shapes to avoid 400 errors. Pass `connection_id` to restrict to one connection; the deprecated `connector_instance_id` alias is accepted for compatibility but new clients SHOULD use `connection_id`. |
| **GET** | `/v1/streams/{stream}/aggregate` | `aggregateStream` | Compute a single-stream grant-safe aggregation. Supports count, numeric sum, numeric/date min/max, exact count_distinct, scalar grouped counts (`group_by`), calendar time-bucket counts (`group_by_time`+`granularity`, optional `time_zone` defaulting to UTC), and existing exact/range filters over declared fields. Exactly one grouping dimension per call: `group_by` XOR `group_by_time`. |
| **GET** | `/v1/streams/{stream}/records/{id}` | `getRecord` | Fetch a single record by primary key under grant enforcement, with optional declared one-hop expansion. Expandable relations and the per-relation `expand_limit` ceiling are advertised by `GET /v1/schema` (`expand_capabilities`); requesting an unadvertised relation is rejected rather than silently ignored. When the identifier resolves to more than one connection under the caller's grant and `connection_id` is omitted, returns a typed `ambiguous_connection` (409) error with `available_connections` and retry guidance instead of silently picking one. The deprecated `connector_instance_id` alias is accepted for compatibility but new clients SHOULD use `connection_id`. |
| **GET** | `/v1/search` | `searchRecordsLexical` | Optional lexical retrieval extension: search records across authorized streams by text. Search modes, per-mode cursor support, and field-level `lexical_search`/`semantic_search` capabilities are advertised by `GET /v1/schema`; `filter[...]` operators applied to a single named stream must come from that stream's `field_capabilities`. Hits carry `connection_id` for attribution; the deprecated `connector_instance_id` alias is emitted alongside for compatibility but new clients SHOULD read `connection_id`. |
| **GET** | `/v1/search/semantic` | `searchRecordsSemantic` | Experimental optional extension: semantic retrieval across authorized streams by text. See the semantic-retrieval capability spec. Unstable in v1. Per-stream semantic capability and pagination support are advertised by `GET /v1/schema` and the `capabilities.semantic_retrieval` block in protected-resource metadata; consult them before relying on cursors or filters. Hits carry `connection_id` for attribution; the deprecated `connector_instance_id` alias is emitted for compatibility only. |
| **GET** | `/v1/search/hybrid` | `searchRecordsHybrid` | Experimental optional extension: hybrid retrieval blending lexical and semantic recall under one grant-safe result list. See the hybrid-retrieval capability spec. Hybrid does NOT support cursor pagination on this reference; check `pdpp_discovery_hints.hybrid_pagination_supported` in the protected-resource metadata and, when it is `false` or absent, fall back to `GET /v1/search` (lexical) which supports `cursor`. |
| **POST** | `/v1/blobs` | `uploadBlob` | Upload connector/runtime-owned blob bytes for a bound record. |
| **GET** | `/v1/blobs/{blob_id}` | `getBlob` | Fetch blob bytes authorized by the caller having discovered the referencing record under grant. When the blob identifier resolves to more than one connection under the caller's grant and `connection_id` is omitted, returns a typed `ambiguous_connection` (409) error with `available_connections` and retry guidance instead of silently picking one. The deprecated `connector_instance_id` alias is accepted for compatibility but new clients SHOULD use `connection_id`. |
| **POST** | `/v1/event-subscriptions` | `createEventSubscription` | Create an event subscription for the bearer's explicit authority (`client_grant` or registered `trusted_owner_agent`). Immediately enqueues a `pdpp.subscription.verify` event to the callback URL. The subscription stays in `pending_verification` until the receiver echoes the `challenge` value. Returns the per-subscription HMAC signing secret (`whsec_*`) once; it cannot be retrieved again. |
| **GET** | `/v1/event-subscriptions` | `listEventSubscriptions` | List all non-deleted event subscriptions for the bearer's authority tuple (`authority_kind`, `client_id`, `subject_id`, and `grant_id` when `client_grant`). |
| **GET** | `/v1/event-subscriptions/{subscription_id}` | `getEventSubscription` | Get a single event subscription owned by the bearer. |
| **PATCH** | `/v1/event-subscriptions/{subscription_id}` | `updateEventSubscription` | Update an event subscription. Toggle `enabled` to disable or re-enable delivery. Set `rotate_secret` to true to generate a new signing secret (returned in the response body; old secret is immediately invalid). |
| **DELETE** | `/v1/event-subscriptions/{subscription_id}` | `deleteEventSubscription` | Delete an event subscription. Queued undelivered events are dropped. Idempotent for the caller's authority tuple (`authority_kind`, `client_id`, `subject_id`, and `grant_id` when `client_grant`). |
| **POST** | `/v1/event-subscriptions/{subscription_id}/test-event` | `sendTestEvent` | Enqueue a `pdpp.subscription.test` event for asynchronous delivery to the subscription's callback URL. Accepted for `active` and `pending_verification` subscriptions. Returns the enqueued event ID. |

## getRsDiscoveryIndex

`GET /`

Unauthenticated cold-start pointer at the resource server root. Names the well-known endpoint, the `/v1/schema` capability discovery surface, the core query base, and the running reference revision so a probe learns the next hop without trial-and-error.

### Responses

- `200` — JSON body

## getAsDiscoveryIndex

`GET /`

Unauthenticated cold-start pointer at the authorization server root. Names the AS well-known endpoint and the running reference revision so a probe learns the next hop without trial-and-error.

### Responses

- `200` — JSON body

## getAuthorizationServerMetadata

`GET /.well-known/oauth-authorization-server`

Return RFC 8414 authorization-server metadata with the reference provider-connect capability extensions.

### Responses

- `200` — JSON body

## getProtectedResourceMetadata

`GET /.well-known/oauth-protected-resource`

Return RFC 9728 protected-resource metadata advertising the PDPP query base, owner-self-export, advisory `pdpp_agent_discovery` / `pdpp_owner_agent_onboarding` when safely configured, and capabilities such as `client_event_subscriptions`.

### Responses

- `200` — JSON body

## getMcpProtectedResourceMetadata

`GET /.well-known/oauth-protected-resource/mcp`

Return RFC 9728 protected-resource metadata for the hosted MCP endpoint.

### Responses

- `200` — JSON body

## registerDynamicClient

`POST /oauth/register`

Register a public client through the reference dynamic client registration profile.

### Request body

`application/json`
- `application_type` — string
- `client_name` — string
- `client_uri` — string · format: uri
- `grant_types` — array
- `logo_uri` — string · format: uri
- `policy_uri` — string · format: uri
- `redirect_uris` — array
- `response_types` — array
- `token_endpoint_auth_method` — enum `none`
- `tos_uri` — string · format: uri

### Responses

- `201` — Client registered
- `400` — Invalid client metadata
- `401` — Missing or invalid initial access token
- `404` — Dynamic client registration is disabled

## createPushedAuthorizationRequest

`POST /oauth/par`

Stage a PDPP data-access request and receive a pending-consent request_uri plus authorization URL.

### Request body

`application/json`
- `client_id` (required) — string
- `client_display` — object
- `scenario_id` — string
- `authorization_details` (required) — array

### Responses

- `201` — Pending consent request created
- `400` — Invalid request
- `403` — Request rejected because the resolved grant contract is invalid

## approveConsent

`POST /consent/approve`

Approve a pending data-access request through the JSON consent surface used by tests and automation.

### Request body

`application/json`
- `request_uri` (required) — string
- `subject_id` — string
- `ai_training_consented` — boolean
- `approved_source_indexes` — any
- `confirm_approve_all` — any

### Responses

- `200` — Grant approved and client token issued
- `400` — Invalid request
- `403` — Grant is malformed or no longer valid
- `404` — Pending consent request not found

## exchangeConsentCode

`POST /consent/exchange`

Redeem a short-lived single-use consent exchange code from the hosted HTML consent flow for the client token.

### Request body

`application/json`
- `code` (required) — string

### Responses

- `200` — Exchange code redeemed and client token issued
- `400` — Invalid request
- `404` — Unknown exchange code
- `410` — Exchange code expired or already redeemed

## startOwnerDeviceAuthorization

`POST /oauth/device_authorization`

Start the owner device flow used for owner-self-export and dashboard bootstrap.

### Request body

`application/x-www-form-urlencoded`
- `client_id` (required) — string

### Responses

- `200` — JSON body
- `400` — OAuth request rejected

## exchangeOwnerDeviceToken

`POST /oauth/token`

Exchange an OAuth device code, authorization code, or refresh token for a bearer token.

### Request body

`application/x-www-form-urlencoded`

### Responses

- `200` — JSON body
- `400` — OAuth request rejected
- `500` — Server error while exchanging the device code

## introspectToken

`POST /introspect`

Inspect token activity and, for active client tokens, the bound grant projection.

### Request body

`application/x-www-form-urlencoded`
- `token` (required) — string

### Responses

- `200` — JSON body
- `400` — Missing token parameter

## revokeGrant

`POST /grants/{grantId}/revoke`

Revoke a grant and all tokens minted from it.

### Path parameters

- `grantId` — string

### Responses

- `200` — JSON body
- `403` — Grant is malformed or no longer valid

## listConnectors

`GET /v1/connectors`

List connector or source boundaries visible under the bearer token, with stream summaries and coarse capability hints.

### Responses

- `200` — JSON body
- `400` — Invalid request
- `401` — Missing or invalid access token
- `403` — Grant does not permit this request
- `404` — Stream or record not found

## getSchema

`GET /v1/schema`

Return the caller-visible source/stream capability graph. Use `view=compact` and optional `stream=<name>` for a token-efficient agent discovery step; omitted `view` returns the full schema, query declarations, field capabilities, expand capabilities, and freshness.

### Query parameters

- `connector_id` — string · Optional owner-polyfill source hint for runtimes that expose multiple connector templates.
- `view` — string · Set `view=compact` to return the token-efficient schema projection. Omitted or any other value returns the full schema body.
- `stream` — string · When used with `view=compact`, narrows the schema document to connectors that contribute this stream.

### Responses

- `200` — JSON body
- `400` — Invalid request
- `401` — Missing or invalid access token
- `403` — Grant does not permit this request
- `404` — Stream or record not found

## listStreams

`GET /v1/streams`

List streams available under the current grant or owner scope. Returns stream-level totals only; for per-field filter capabilities (exact, range operators, aggregation) call `GET /v1/schema` first and consult `field_capabilities` per stream before issuing `filter[...]` queries on `/v1/streams/{stream}/records`. Multi-connection deployments emit one entry per (stream, connection_id); each entry carries `connection_id` and a `display_name` so callers can attribute and disambiguate.

### Query parameters

- `connector_id` — string
- `subject_id` — string
- `connection_id` — string · Canonical public identifier for a connection (one owner-configured account/device/profile). Prefer this over the deprecated `connector_instance_id` alias.
- `connector_instance_id` — string · Deprecated wire alias for `connection_id`. Emitted alongside `connection_id` during the migration window. New clients SHOULD ignore this field and read `connection_id` instead.

### Responses

- `200` — JSON body
- `400` — Invalid request
- `401` — Missing or invalid access token
- `403` — Grant does not permit this request
- `404` — Stream or record not found

## getStreamMetadata

`GET /v1/streams/{stream}`

Return stream metadata including declared query capabilities and advisory freshness. For per-field filter capabilities on this stream (exact, range operators, aggregation), prefer `GET /v1/schema` first and read `field_capabilities` rather than guessing `filter[...]` shapes against the records endpoint. Pass `connection_id` (or the deprecated `connector_instance_id` alias) to restrict to a single connection; omitted, the response aggregates across the connections the grant authorizes.

### Query parameters

- `connector_id` — string
- `subject_id` — string
- `connection_id` — string · Canonical public identifier for a connection (one owner-configured account/device/profile). Prefer this over the deprecated `connector_instance_id` alias.
- `connector_instance_id` — string · Deprecated wire alias for `connection_id`. Emitted alongside `connection_id` during the migration window. New clients SHOULD ignore this field and read `connection_id` instead.

### Path parameters

- `stream` — string

### Responses

- `200` — JSON body
- `400` — Invalid request
- `401` — Missing or invalid access token
- `403` — Grant does not permit this request
- `404` — Stream or record not found

## listRecords

`GET /v1/streams/{stream}/records`

List records in a stream under grant enforcement. Supports logical-cursor pagination, exact and declared range filters, declared one-hop expansion, and changes_since. Per-field filter operators, sortable fields, expandable relations, projection, search modes, and count support are advertised by `GET /v1/schema` (`field_capabilities`, `expand_capabilities`); consult it before issuing `filter[...]`, `expand[]`, or `fields=` shapes to avoid 400 errors. Pass `connection_id` to restrict to one connection; the deprecated `connector_instance_id` alias is accepted for compatibility but new clients SHOULD use `connection_id`.

### Query parameters

- `limit` — integer · min: 1 · max: 100
- `cursor` — string · Opaque logical pagination cursor. Encodes (cursor_field, primary_key) position.
- `order` — enum `asc | desc`
- `changes_since` — string · `beginning` for initial sync, or an opaque changes-since token from next_changes_since. Distinct from list-page cursors.
- `fields` — string
- `view` — string
- `filter` — object · Per-field filter map. Exact: `filter[field]=value`. Range: `filter[field][op]=value` where `op` is one of the declared `field_capabilities.range_filter.operators` from `GET /v1/schema`.
- `expand` — array
- `expand_limit` — object
- `connector_id` — string
- `subject_id` — string
- `connection_id` — string · Canonical public identifier for a connection (one owner-configured account/device/profile). Prefer this over the deprecated `connector_instance_id` alias.
- `connector_instance_id` — string · Deprecated wire alias for `connection_id`. Emitted alongside `connection_id` during the migration window. New clients SHOULD ignore this field and read `connection_id` instead.
- `window` — enum `none | exact`

### Path parameters

- `stream` — string

### Responses

- `200` — JSON body
- `400` — Invalid request
- `401` — Missing or invalid access token
- `403` — Grant does not permit this request
- `404` — Stream or record not found
- `410` — Cursor expired

## aggregateStream

`GET /v1/streams/{stream}/aggregate`

Compute a single-stream grant-safe aggregation. Supports count, numeric sum, numeric/date min/max, exact count_distinct, scalar grouped counts (`group_by`), calendar time-bucket counts (`group_by_time`+`granularity`, optional `time_zone` defaulting to UTC), and existing exact/range filters over declared fields. Exactly one grouping dimension per call: `group_by` XOR `group_by_time`.

### Query parameters

- `metric` — enum `count | sum | min | max | count_distinct`
- `field` — string
- `group_by` — string
- `group_by_time` — string · Group counts into calendar time buckets over a declared date/date-time field. Mutually exclusive with `group_by`. Requires `granularity`.
- `granularity` — enum `minute | hour | day | week | month | quarter | year`
- `time_zone` — string · IANA time zone used to compute `group_by_time` bucket boundaries. Defaults to `UTC`; the response echoes the effective zone.
- `limit` — integer · min: 1 · max: 100
- `filter` — object
- `connector_id` — string
- `subject_id` — string
- `connection_id` — string · Canonical public identifier for a connection (one owner-configured account/device/profile). Prefer this over the deprecated `connector_instance_id` alias.
- `connector_instance_id` — string · Deprecated wire alias for `connection_id`. Emitted alongside `connection_id` during the migration window. New clients SHOULD ignore this field and read `connection_id` instead.

### Path parameters

- `stream` — string

### Responses

- `200` — JSON body
- `400` — Invalid request
- `401` — Missing or invalid access token
- `403` — Grant does not permit this request
- `404` — Stream or record not found

## getRecord

`GET /v1/streams/{stream}/records/{id}`

Fetch a single record by primary key under grant enforcement, with optional declared one-hop expansion. Expandable relations and the per-relation `expand_limit` ceiling are advertised by `GET /v1/schema` (`expand_capabilities`); requesting an unadvertised relation is rejected rather than silently ignored. When the identifier resolves to more than one connection under the caller's grant and `connection_id` is omitted, returns a typed `ambiguous_connection` (409) error with `available_connections` and retry guidance instead of silently picking one. The deprecated `connector_instance_id` alias is accepted for compatibility but new clients SHOULD use `connection_id`.

### Query parameters

- `expand` — array
- `expand_limit` — object
- `connector_id` — string
- `subject_id` — string
- `connection_id` — string · Canonical public identifier for a connection (one owner-configured account/device/profile). Prefer this over the deprecated `connector_instance_id` alias.
- `connector_instance_id` — string · Deprecated wire alias for `connection_id`. Emitted alongside `connection_id` during the migration window. New clients SHOULD ignore this field and read `connection_id` instead.

### Path parameters

- `stream` — string
- `id` — string

### Responses

- `200` — JSON body
- `400` — Invalid request
- `401` — Missing or invalid access token
- `403` — Grant does not permit this request
- `404` — Stream or record not found
- `409` — Identifier resolves to more than one connection under the caller's grant. Retry with the `connection_id` listed in `error.available_connections`.

## searchRecordsLexical

`GET /v1/search`

Optional lexical retrieval extension: search records across authorized streams by text. Search modes, per-mode cursor support, and field-level `lexical_search`/`semantic_search` capabilities are advertised by `GET /v1/schema`; `filter[...]` operators applied to a single named stream must come from that stream's `field_capabilities`. Hits carry `connection_id` for attribution; the deprecated `connector_instance_id` alias is emitted alongside for compatibility but new clients SHOULD read `connection_id`.

### Query parameters

- `q` — string
- `limit` — integer · min: 1 · max: 100
- `cursor` — string · Opaque logical pagination cursor. Encodes (cursor_field, primary_key) position.
- `streams` — any
- `filter` — object
- `connection_id` — string · Canonical public identifier for a connection (one owner-configured account/device/profile). Prefer this over the deprecated `connector_instance_id` alias.
- `connector_instance_id` — string · Deprecated wire alias for `connection_id`. Emitted alongside `connection_id` during the migration window. New clients SHOULD ignore this field and read `connection_id` instead.

### Responses

- `200` — JSON body
- `400` — Invalid request (e.g. unsupported v1 query parameter, missing q)
- `401` — Missing or invalid access token
- `403` — Grant does not permit a named stream (client tokens only)
- `410` — Cursor expired or refers to an unknown snapshot

## searchRecordsSemantic

`GET /v1/search/semantic`

Experimental optional extension: semantic retrieval across authorized streams by text. See the semantic-retrieval capability spec. Unstable in v1. Per-stream semantic capability and pagination support are advertised by `GET /v1/schema` and the `capabilities.semantic_retrieval` block in protected-resource metadata; consult them before relying on cursors or filters. Hits carry `connection_id` for attribution; the deprecated `connector_instance_id` alias is emitted for compatibility only.

### Query parameters

- `q` — string
- `limit` — integer · min: 1 · max: 100
- `cursor` — string · Opaque logical pagination cursor. Encodes (cursor_field, primary_key) position.
- `streams` — any
- `filter` — object
- `connection_id` — string · Canonical public identifier for a connection (one owner-configured account/device/profile). Prefer this over the deprecated `connector_instance_id` alias.
- `connector_instance_id` — string · Deprecated wire alias for `connection_id`. Emitted alongside `connection_id` during the migration window. New clients SHOULD ignore this field and read `connection_id` instead.

### Responses

- `200` — JSON body
- `400` — Invalid request (e.g. unsupported v1 query parameter, missing q)
- `401` — Missing or invalid access token
- `403` — Grant does not permit a named stream (client tokens only)
- `410` — Cursor expired or refers to an unknown snapshot

## searchRecordsHybrid

`GET /v1/search/hybrid`

Experimental optional extension: hybrid retrieval blending lexical and semantic recall under one grant-safe result list. See the hybrid-retrieval capability spec. Hybrid does NOT support cursor pagination on this reference; check `pdpp_discovery_hints.hybrid_pagination_supported` in the protected-resource metadata and, when it is `false` or absent, fall back to `GET /v1/search` (lexical) which supports `cursor`.

### Query parameters

- `q` — string
- `limit` — integer · min: 1 · max: 100
- `streams` — any
- `filter` — object
- `connection_id` — string · Canonical public identifier for a connection (one owner-configured account/device/profile). Prefer this over the deprecated `connector_instance_id` alias.
- `connector_instance_id` — string · Deprecated wire alias for `connection_id`. Emitted alongside `connection_id` during the migration window. New clients SHOULD ignore this field and read `connection_id` instead.

### Responses

- `200` — JSON body
- `400` — Invalid request (e.g. unsupported v1 query parameter, missing q, cursor parameter)
- `401` — Missing or invalid access token
- `403` — Grant does not permit a named stream (client tokens only)
- `404` — Hybrid retrieval not advertised on this server

## uploadBlob

`POST /v1/blobs`

Upload connector/runtime-owned blob bytes for a bound record.

### Query parameters

- `connector_id` — string
- `stream` — string
- `record_key` — string

### Request body

`application/octet-stream`

### Responses

- `200` — Canonical content-addressed blob identity for the uploaded bytes
- `400` — Invalid upload request
- `401` — Missing or invalid access token
- `403` — Owner/runtime authority required
- `404` — Unknown connector or stream

## getBlob

`GET /v1/blobs/{blob_id}`

Fetch blob bytes authorized by the caller having discovered the referencing record under grant. When the blob identifier resolves to more than one connection under the caller's grant and `connection_id` is omitted, returns a typed `ambiguous_connection` (409) error with `available_connections` and retry guidance instead of silently picking one. The deprecated `connector_instance_id` alias is accepted for compatibility but new clients SHOULD use `connection_id`.

### Query parameters

- `connection_id` — string · Canonical public identifier for a connection (one owner-configured account/device/profile). Prefer this over the deprecated `connector_instance_id` alias.
- `connector_instance_id` — string · Deprecated wire alias for `connection_id`. Emitted alongside `connection_id` during the migration window. New clients SHOULD ignore this field and read `connection_id` instead.

### Path parameters

- `blob_id` — string

### Responses

- `200` — Blob bytes
- `400` — Invalid request
- `401` — Missing or invalid access token
- `403` — Grant does not permit this request
- `404` — Stream or record not found
- `409` — Identifier resolves to more than one connection under the caller's grant. Retry with the `connection_id` listed in `error.available_connections`.

## createEventSubscription

`POST /v1/event-subscriptions`

Create an event subscription for the bearer's explicit authority (`client_grant` or registered `trusted_owner_agent`). Immediately enqueues a `pdpp.subscription.verify` event to the callback URL. The subscription stays in `pending_verification` until the receiver echoes the `challenge` value. Returns the per-subscription HMAC signing secret (`whsec_*`) once; it cannot be retrieved again.

### Request body

`application/json`
- `callback_url` (required) — string · format: uri · HTTPS endpoint that will receive CloudEvents 1.0 structured-mode JSON POST requests signed with Standard Webhooks headers. `http://localhost` is accepted for development.
- `filters` — object

### Responses

- `201` — Subscription created. The `secret` field is the Standard Webhooks signing key (`whsec_<base64>`) and is returned only on creation.
- `400` — Invalid request (callback URL malformed, filters not in grant, etc.)
- `401` — Bearer token missing or invalid
- `403` — Bearer token is authenticated but is neither a `client_grant` authority for an active grant nor a registered `trusted_owner_agent` authority; unregistered owner bearers are rejected.

## listEventSubscriptions

`GET /v1/event-subscriptions`

List all non-deleted event subscriptions for the bearer's authority tuple (`authority_kind`, `client_id`, `subject_id`, and `grant_id` when `client_grant`).

### Responses

- `200` — JSON body
- `401` — Bearer token missing or invalid
- `403` — Bearer token is authenticated but is neither a `client_grant` authority for an active grant nor a registered `trusted_owner_agent` authority; unregistered owner bearers are rejected.

## getEventSubscription

`GET /v1/event-subscriptions/{subscription_id}`

Get a single event subscription owned by the bearer.

### Path parameters

- `subscription_id` — string

### Responses

- `200` — JSON body
- `401` — Bearer token missing or invalid
- `403` — Bearer token is authenticated but is neither a `client_grant` authority for an active grant nor a registered `trusted_owner_agent` authority; unregistered owner bearers are rejected.
- `404` — Subscription not found or not owned by the bearer

## updateEventSubscription

`PATCH /v1/event-subscriptions/{subscription_id}`

Update an event subscription. Toggle `enabled` to disable or re-enable delivery. Set `rotate_secret` to true to generate a new signing secret (returned in the response body; old secret is immediately invalid).

### Path parameters

- `subscription_id` — string

### Request body

`application/json`
- `enabled` — boolean · Set to `false` to disable delivery; `true` to re-enable a `disabled` or `disabled_failure` subscription. Cannot re-enable a `disabled_revoked` subscription.
- `rotate_secret` — boolean · Generate a new `whsec_*` signing secret. The new secret is returned in the response body. The old secret is immediately invalid.

### Responses

- `200` — Updated subscription. `secret` is only present when `rotate_secret` was `true`.
- `400` — Invalid update (e.g. re-enabling a revoked subscription)
- `401` — Bearer token missing or invalid
- `403` — Bearer token is authenticated but is neither a `client_grant` authority for an active grant nor a registered `trusted_owner_agent` authority; unregistered owner bearers are rejected.
- `404` — Subscription not found or not owned by the bearer
- `409` — State conflict (e.g. re-enabling a `disabled_revoked` subscription)

## deleteEventSubscription

`DELETE /v1/event-subscriptions/{subscription_id}`

Delete an event subscription. Queued undelivered events are dropped. Idempotent for the caller's authority tuple (`authority_kind`, `client_id`, `subject_id`, and `grant_id` when `client_grant`).

### Path parameters

- `subscription_id` — string

### Responses

- `204` — Subscription deleted.
- `401` — Bearer token missing or invalid
- `403` — Bearer token is authenticated but is neither a `client_grant` authority for an active grant nor a registered `trusted_owner_agent` authority; unregistered owner bearers are rejected.
- `404` — Subscription not found or not owned by the bearer

## sendTestEvent

`POST /v1/event-subscriptions/{subscription_id}/test-event`

Enqueue a `pdpp.subscription.test` event for asynchronous delivery to the subscription's callback URL. Accepted for `active` and `pending_verification` subscriptions. Returns the enqueued event ID.

### Path parameters

- `subscription_id` — string

### Responses

- `202` — Test event accepted for delivery.
- `401` — Bearer token missing or invalid
- `403` — Bearer token is authenticated but is neither a `client_grant` authority for an active grant nor a registered `trusted_owner_agent` authority; unregistered owner bearers are rejected.
- `404` — Subscription not found or not owned by the bearer
- `409` — Subscription is not in a state that accepts test events (must be `active` or `pending_verification`)
