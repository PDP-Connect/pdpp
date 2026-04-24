# PDPP reference-implementation public API

Generated from `packages/reference-contract/src/public/`. Do not edit by hand.

| Method | Path | Operation | Summary |
|--------|------|-----------|---------|
| **GET** | `/.well-known/oauth-authorization-server` | `getAuthorizationServerMetadata` | Return RFC 8414 authorization-server metadata with the reference provider-connect capability extensions. |
| **GET** | `/.well-known/oauth-protected-resource` | `getProtectedResourceMetadata` | Return RFC 9728 protected-resource metadata advertising the PDPP query base and owner-self-export capabilities. |
| **POST** | `/oauth/register` | `registerDynamicClient` | Register a public client through the reference dynamic client registration profile. |
| **POST** | `/oauth/par` | `createPushedAuthorizationRequest` | Stage a PDPP data-access request and receive a pending-consent request_uri plus authorization URL. |
| **POST** | `/consent/approve` | `approveConsent` | Approve a pending data-access request through the JSON consent surface used by tests and automation. |
| **POST** | `/oauth/device_authorization` | `startOwnerDeviceAuthorization` | Start the owner device flow used for owner-self-export and dashboard bootstrap. |
| **POST** | `/oauth/token` | `exchangeOwnerDeviceToken` | Exchange an approved owner device_code for an owner bearer token. |
| **POST** | `/introspect` | `introspectToken` | Inspect token activity and, for active client tokens, the bound grant projection. |
| **POST** | `/grants/{grantId}/revoke` | `revokeGrant` | Revoke a grant and all tokens minted from it. |
| **GET** | `/v1/streams` | `listStreams` | List streams available under the current grant or owner scope. |
| **GET** | `/v1/streams/{stream}` | `getStreamMetadata` | Return stream metadata including declared query capabilities and advisory freshness. |
| **GET** | `/v1/streams/{stream}/records` | `listRecords` | List records in a stream under grant enforcement. Supports logical-cursor pagination, exact and declared range filters, and changes_since. |
| **GET** | `/v1/streams/{stream}/records/{id}` | `getRecord` | Fetch a single record by primary key under grant enforcement, with optional declared expansion. |
| **GET** | `/v1/search` | `searchRecordsLexical` | Optional lexical retrieval extension: search records across authorized streams by text. See the lexical-retrieval capability spec. |
| **GET** | `/v1/search/semantic` | `searchRecordsSemantic` | Experimental optional extension: semantic retrieval across authorized streams by text. See the semantic-retrieval capability spec. Unstable in v1. |
| **GET** | `/v1/blobs/{blob_id}` | `getBlob` | Fetch blob bytes authorized by the caller having discovered the referencing record under grant. |

## getAuthorizationServerMetadata

`GET /.well-known/oauth-authorization-server`

Return RFC 8414 authorization-server metadata with the reference provider-connect capability extensions.

### Responses

- `200` — JSON body

## getProtectedResourceMetadata

`GET /.well-known/oauth-protected-resource`

Return RFC 9728 protected-resource metadata advertising the PDPP query base and owner-self-export capabilities.

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

### Responses

- `200` — Grant approved and client token issued
- `400` — Invalid request
- `403` — Grant is malformed or no longer valid
- `404` — Pending consent request not found

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

Exchange an approved owner device_code for an owner bearer token.

### Request body

`application/x-www-form-urlencoded`
- `grant_type` (required) — const `urn:ietf:params:oauth:grant-type:device_code`
- `device_code` (required) — string
- `client_id` (required) — string

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

## listStreams

`GET /v1/streams`

List streams available under the current grant or owner scope.

### Query parameters

- `connector_id` — string
- `subject_id` — string

### Responses

- `200` — JSON body
- `400` — Invalid request
- `401` — Missing or invalid access token
- `403` — Grant does not permit this request
- `404` — Stream or record not found

## getStreamMetadata

`GET /v1/streams/{stream}`

Return stream metadata including declared query capabilities and advisory freshness.

### Query parameters

- `connector_id` — string
- `subject_id` — string

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

List records in a stream under grant enforcement. Supports logical-cursor pagination, exact and declared range filters, and changes_since.

### Query parameters

- `limit` — integer · min: 1 · max: 100
- `cursor` — string · Opaque logical pagination cursor. Encodes (cursor_field, primary_key) position.
- `order` — enum `asc | desc`
- `changes_since` — string · Opaque changes-since token. Distinct from list-page cursors.
- `fields` — string
- `view` — string
- `filter` — object
- `expand` — array
- `expand_limit` — object
- `connector_id` — string
- `subject_id` — string

### Path parameters

- `stream` — string

### Responses

- `200` — JSON body
- `400` — Invalid request
- `401` — Missing or invalid access token
- `403` — Grant does not permit this request
- `404` — Stream or record not found
- `410` — Cursor expired

## getRecord

`GET /v1/streams/{stream}/records/{id}`

Fetch a single record by primary key under grant enforcement, with optional declared expansion.

### Query parameters

- `expand` — array
- `expand_limit` — object
- `connector_id` — string
- `subject_id` — string

### Path parameters

- `stream` — string
- `id` — string

### Responses

- `200` — JSON body
- `400` — Invalid request
- `401` — Missing or invalid access token
- `403` — Grant does not permit this request
- `404` — Stream or record not found

## searchRecordsLexical

`GET /v1/search`

Optional lexical retrieval extension: search records across authorized streams by text. See the lexical-retrieval capability spec.

### Query parameters

- `q` — string
- `limit` — integer · min: 1 · max: 100
- `cursor` — string · Opaque logical pagination cursor. Encodes (cursor_field, primary_key) position.
- `streams` — any

### Responses

- `200` — JSON body
- `400` — Invalid request (e.g. unsupported v1 query parameter, missing q)
- `401` — Missing or invalid access token
- `403` — Grant does not permit a named stream (client tokens only)
- `410` — Cursor expired or refers to an unknown snapshot

## searchRecordsSemantic

`GET /v1/search/semantic`

Experimental optional extension: semantic retrieval across authorized streams by text. See the semantic-retrieval capability spec. Unstable in v1.

### Query parameters

- `q` — string
- `limit` — integer · min: 1 · max: 100
- `cursor` — string · Opaque logical pagination cursor. Encodes (cursor_field, primary_key) position.
- `streams` — any

### Responses

- `200` — JSON body
- `400` — Invalid request (e.g. unsupported v1 query parameter, missing q)
- `401` — Missing or invalid access token
- `403` — Grant does not permit a named stream (client tokens only)
- `410` — Cursor expired or refers to an unknown snapshot

## getBlob

`GET /v1/blobs/{blob_id}`

Fetch blob bytes authorized by the caller having discovered the referencing record under grant.

### Path parameters

- `blob_id` — string

### Responses

- `200` — Blob bytes
- `400` — Invalid request
- `401` — Missing or invalid access token
- `403` — Grant does not permit this request
- `404` — Stream or record not found

