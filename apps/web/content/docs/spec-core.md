---
title: "Protocol"
description: "Authorization and disclosure semantics for personal data — record model, selection request, grant, manifest, and resource server interface."
---

## 1. Introduction {#introduction}

PDPP is an authorization and disclosure protocol for personal data. It defines how a user authorizes an application to access specific data from their personal data store, and how a resource server enforces that authorization.

The protocol specifies:

- A **record model** for representing personal data as flat relational streams
- A **selection request** format for applications to request specific data (RFC 9396 envelope)
- A **grant** object representing user-approved, parameterized consent
- A **connector manifest** declaring the consent surface a connector exposes
- A **resource server interface** for serving records under grant enforcement

**Design axiom:** Connector manifests define the consent surface. Grants define actual consent. These are separate concerns and must not be conflated.

Collection of data from source platforms is a separate concern addressed in the companion [PDPP Collection Profile](spec-collection-profile). The core protocol is useful without it: a resource server holding pre-collected data can serve that data under grant enforcement with no collection machinery involved.

### Relationship to existing standards

| Standard | Relationship |
|----------|-------------|
| OAuth 2.0 (RFC 6749) | PDPP uses OAuth 2.0 authorization flows. The grant is issued as the result of an OAuth authorization flow with RFC 9396 authorization_details. |
| RFC 9396 (RAR) | PDPP uses the `authorization_details` envelope for selection requests. The `type` URI is `https://pdpp.org/data-access`. |
| Airbyte / Singer | PDPP borrows the RECORD/STATE checkpoint pattern for incremental sync (see Collection Profile). |
| Data Transfer Project (DTI) | PDPP and DTI are complementary: PDPP handles consent and disclosure semantics; DTI handles transfer mechanics. The two protocols can chain. See Appendix B. |
| GNAP (RFC 9635) | GNAP is the IETF's ground-up rethink of OAuth. Several design decisions are directly relevant to PDPP: (1) inline client display metadata in the grant request, eliminating the need for a separate registration spec; (2) interaction modes beyond browser redirects (relevant to PDPP's session relay flow); (3) request continuation for multi-step consent negotiation (relevant to optional streams); (4) key-bound grants instead of bearer tokens (stronger security for ongoing personal data access); (5) built-in grant management with revocation and rotation (relevant to `continuous` access mode). PDPP v0.1 uses OAuth 2.0 + RFC 9396, but a future version should evaluate whether GNAP is a better foundation. TODO for v0.2. |
| GDPR / DMA | PDPP implements data minimization (field and stream selection) and purpose limitation (`purpose_code`). The `continuous` access mode enables ongoing portability aligned with the DMA's requirements. The internal version history required for incremental sync may support implementations that choose to expose historical access features to users. Whether such exposure is required is outside the scope of this specification. This alignment is informative only and is not a required v0.1 capability. |

**Note:** The PDPP Collection Profile is one fulfillment mechanism. A conformance test suite for this specification is planned but is not defined in v0.1 (see Section 11).


## 2. Terminology and Actors

### Actors

| Actor | Definition |
|-------|-----------|
| **User** | The person whose data is being accessed. Owns the data, approves grants, may revoke. |
| **Client** | An application or AI agent requesting user data. Identified by `client_id`. In OAuth terms, this is the client. |
| **Data Source** | Any external system from which a user's data originates: a consumer platform, a SaaS application, a device, a local archive, a financial institution, or other system. |

### Protocol roles

These roles may be co-located in a single deployment (e.g., a personal server acting as both authorization server and resource server) or separated. The spec defines the interfaces between roles, not the deployment topology.

| Role | Responsibility |
|------|---------------|
| **Authorization Server** | Issues and manages grants. Validates selection requests against connector manifests. Tracks grant lifecycle (active, expired, revoked). |
| **Resource Server** | Stores records as flat relational streams. Serves records to clients filtered by grant parameters. |

The [PDPP Collection Profile](spec-collection-profile) defines a third role:

| Role | Responsibility |
|------|---------------|
| **Connector Runtime** | Runs connectors. Writes collected records to the resource server. Manages incremental sync state. |

In many deployments, a single **personal server** fills all three roles. The spec uses "personal server" when referring to a combined deployment, and the specific role name when the distinction matters.

**Note on the Authorization Server interface:** This spec defines the resource server interface normatively because cross-deployment interoperability requires it. The authorization server interface is not normatively specified in v0.1 because authorization flows are deployment-specific. The personal server deployment uses the session relay flow described in the PDPP Session Relay Profile (not yet published).

**Token resolution:** User-facing authorization flows are deployment-specific and are not normatively specified in v0.1. However, when the AS and RS are deployed separately, the AS↔RS token-resolution contract is normative: the RS resolves access tokens using RFC 7662-style token introspection. For co-located deployments, a local equivalent (shared database or function call) is acceptable. Self-contained JWTs may be used as an optimization but MUST NOT be the sole revocation mechanism (see Section 10).

### Data concepts

| Term | Definition |
|------|-----------|
| **Grant** | An immutable consent artifact specifying what data a client may access, under what constraints. |
| **Stream** | A named collection of records with a schema, primary key, and optional cursor field. Stream names are connector-local (e.g., `messages`). The fully qualified identifier is an ordered pair `(connector_id, stream_name)`, used in cross-connector references and storage. Example: `("https://registry.pdpp.org/connectors/spotify", "top_artists")`. |
| **Record** | A single data object within a stream. |
| **Connector** | A program that collects data from a data source. Defined in the Collection Profile. |
| **Manifest** | A connector's declaration of the streams it can produce and the consent surface it exposes. |
| **Selection Request** | A client's request for specific data, expressed as RFC 9396 `authorization_details`. |
| **View** | A named field projection, composed from fields declared in the connector manifest schema. Views are the unit of consent for field-level access. Connector manifests MAY suggest views (advisory); the authorization server is authoritative for views used in consent UI and issued grants. |


## 3. System Architecture

```
                                    +----------------------------------+
                                    |        Personal Server           |
+----------+   selection            |  (may be a single deployment)    |
|          |-- request -----------> |                                  |
|  Client  |                        |  +------------------------+      |
|          |<-- records ----------- |  |  Authorization Server  |      |
+----------+   (filtered by grant)  |  |  Issues + manages      |      |
                                    |  |  grants                |      |
+----------+                        |  +------------------------+      |
|   User   |-- consent -----------> |  +------------------------+      |
|          |                        |  |  Resource Server       |      |
+----------+                        |  |  Stores + serves       |      |
                                    |  |  records               |      |
                                    |  +------------------------+      |
                                    +---------------+------------------+
                                                    |
+------------------+                               |
| Connector Runtime|-- RECORD/STATE -------------->|
| (Collection      |<-- state -------------------->|
|  Profile)        |                               |
+--------+---------+
         |
         v
+------------------+
|  Data Sources    |
+------------------+
```

### How the protocol layers relate

PDPP separates three concerns that other systems conflate:

1. **Authorization**: what has the user consented to disclose, to whom, under what constraints? This is the grant. It is the portable core of PDPP.

2. **Disclosure**: given a valid grant, what records does the resource server return? This is the resource server query API.

3. **Collection**: how does data get into the resource server in the first place? This is the Collection Profile. It is one answer to this question; pre-loaded data, manual imports, and other mechanisms are equally valid.

The grant and query API are the normative core. Collection is a companion mechanism.

**Ingest and sync-state are Collection Profile concerns.** The core protocol defines the query API (disclosure) and grant semantics. Record ingest and sync-state management endpoints are defined here for reference but are only required for implementations claiming PDPP Collection Profile support (see Section 9).


## 4. Record Model

Personal data is represented as flat relational streams. This enables streaming, pagination, incremental sync, and compatibility with DTI canonical data models.

### Streams

A stream is a named collection of records with a consistent schema. Examples: `playlists`, `messages`, `sleep_sessions`.

### Stream semantics

Each stream has one of two semantic types:

| Semantics | Meaning | Examples | Resource server behavior |
|-----------|---------|----------|------------------------|
| `append_only` | Records are immutable events. New records are added; existing records are never modified. | messages, transactions, play_events, workouts | Insert only. Duplicate keys are idempotent. |
| `mutable_state` | Records represent current state of an entity. Records may be updated or deleted. | profile, settings, playlist_items, follow_lists | Upsert by primary key. Resource server maintains version history for incremental sync. |

Approximately 95% of personal data by volume is `append_only`. The remaining 5% is `mutable_state`. Mutable state records (profiles, preferences, relationships) are often the highest-value context for AI agents.

### Incremental sync for mutable streams

For `mutable_state` streams, the resource server maintains internal version history to support incremental sync queries. This is an implementation detail: the protocol surface is a standard cursor-based query that returns records changed since a given cursor position (see Section 8). The version history is not exposed as a separate stream.

A client that has previously synced a `mutable_state` stream queries for changes by passing its last cursor. The resource server returns only records whose state has changed since that cursor, within the client's grant-authorized field projection. If no authorized fields changed on a record, that record does not appear in the response.

This design ensures that a client authorized for fields A and B cannot infer that field C changed, even if C was modified after the client's last sync. The response is a function of the grant, not of the full record state.

**Snapshot model:** `changes_since` returns the full current state of each record whose grant-authorized projection changed since the cursor position, plus tombstones for deletions. It does not return field-level diffs. The client receives a complete record object for any record that changed.

**Cursor expiry:** Resource servers MAY expire historical version data after a retention period. If a client's cursor has expired, the resource server MUST return HTTP 410 Gone. The client MUST perform a full re-sync to re-establish its baseline.

**Two distinct cursor spaces:** `cursor`/`next_cursor` are pagination tokens within a single query execution; `changes_since`/`next_changes_since` are incremental sync tokens across sessions. A client MUST NOT use a `next_cursor` value as a `changes_since` parameter; they are different token spaces and will produce a protocol error if confused. The terminal page of a `changes_since` result MUST include a `next_changes_since` field. Paginating an incremental sync: pass `changes_since` on the first request, follow `next_cursor` for subsequent pages within that session, then store `next_changes_since` from the terminal page for the next session.

**Tombstones:** When a record is deleted from a `mutable_state` stream, the resource server MUST include a tombstone entry in incremental sync responses for clients whose cursor predates the deletion. Tombstone format:

```json
{
  "object": "record",
  "id": "canonical-key-string",
  "stream": "playlists",
  "deleted": true,
  "deleted_at": "2026-04-01T10:00:00Z",
  "emitted_at": "2026-04-01T10:00:01Z"
}
```

Tombstones use the same `object: "record"` envelope as regular response records, with `deleted: true`. The `id` field is the canonical key string (see RECORD envelope, Compound key encoding below). Both `deleted_at` and `emitted_at` are required on tombstone objects. No `data` field is present on tombstones.

`deleted_at` represents the time the record was deleted in the source system, if known; otherwise the time the RS processed the deletion directive. If the source system deletion time is unknown, the RS SHOULD use the `emitted_at` value of the delete directive as `deleted_at`.

**Informative note (GDPR Article 15):** The version history maintained internally by the resource server to support `mutable_state` incremental sync may support implementations that choose to expose historical access features to users. Whether such exposure is required is outside the scope of this specification. This alignment is informative only and is not a required v0.1 capability.

### Split rule

When modeling data from a source, apply this rule:

- **Separate stream** if: has its own stable ID, unbounded cardinality, changes independently, or consumers query it independently.
- **Nested within a record** if: small, bounded, and only meaningful as part of the parent.

Example: `conversations` and `messages` are separate streams (messages are unbounded, have their own IDs, change independently). A message's `content_blocks` array can be nested (bounded, only meaningful within the message).

This is a common data modeling judgment call. The rule above is a guide, not a formula; connector authors exercise discretion.

### The RECORD envelope

RECORD is the universal data envelope. It is used in the Collection Profile and is the canonical shape for records stored in the resource server.

```json
{
  "stream": "messages",
  "key": "msg_abc123",
  "data": {
    "id": "msg_abc123",
    "conversation_id": "conv_xyz",
    "role": "user",
    "content": "What is the weather like?",
    "source_created_at": "2026-03-28T15:00:00Z"
  },
  "emitted_at": "2026-03-28T15:01:00Z"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `stream` | string | yes | Stream name |
| `key` | string or string[] | yes | Primary key value. Array for compound keys; order matches manifest `primary_key`. |
| `data` | object | yes | Record payload conforming to the stream schema. |
| `emitted_at` | ISO 8601 | yes | When the record was emitted by the connector (processing time, not source time). |
| `op` | enum | no | `upsert` (default) or `delete`. This field is a directive to the resource server and is not stored as part of the record data. |

**Compound key encoding:** When `primary_key` has multiple fields, `key` is an array of values in the order declared by the manifest's `primary_key`. The canonical string form of a compound key is the minified JSON array of key values (e.g., `["user_123","2026-04-01"]`). Each primary-key component MUST be serialized as a string in the canonical encoding. Non-string primary-key field values (e.g., integers, dates) MUST be converted to their string representation before encoding. URL path parameters and `resources[]` entries use percent-encoded canonical string form. The `resource_ref.record_id` field retains native `string | string[]` type.

**Record identity:** For any record, the values of the `data` fields named by the stream's `primary_key` MUST match the values in the `key` envelope field (in order). If `data` contains the fields named by `primary_key` and their values disagree with `key`, ingest MUST fail with 400 `invalid_record_identity`.

### Timestamps

Two timestamp concepts appear in records:

- **`emitted_at`**: when the connector emitted the record. Always present on the RECORD envelope. Connector-generated.
- **Source timestamps**: when the event occurred or the resource was created or modified on the source platform. These are fields within `data`, declared in the stream schema. The spec reserves two standard field names: `source_created_at` and `source_updated_at`. Connector authors SHOULD use these names when the platform provides them, rather than inventing platform-specific names.

### Foreign keys

Streams reference each other via foreign key fields in `data`:

```json
{
  "stream": "conversations",
  "key": "conv_xyz",
  "data": {
    "id": "conv_xyz",
    "title": "Weather chat",
    "source_created_at": "2026-03-28T14:00:00Z"
  }
}
{
  "stream": "messages",
  "key": "msg_abc123",
  "data": {
    "id": "msg_abc123",
    "conversation_id": "conv_xyz",
    "content": "...",
    "source_created_at": "2026-03-28T15:00:00Z"
  }
}
```

The manifest declares `primary_key` per stream. Foreign key relationships are declared in the manifest's `relationships` field (see Section 7).

### Binary data (blob_ref)

Binary data (photos, videos, audio, documents) is not inlined in records. The record contains metadata and a `blob_ref`:

```json
{
  "stream": "media",
  "key": "media_123",
  "data": {
    "id": "media_123",
    "caption": "Sunset",
    "media_type": "image",
    "source_created_at": "2026-03-28T10:00:00Z",
    "blob_ref": {
      "blob_id": "blob_media_123",
      "mime_type": "image/jpeg",
      "size_bytes": 2048000,
      "sha256": "a1b2c3..."
    }
  }
}
```

`mime_type` MUST be a valid IANA media type (see [IANA Media Types](https://www.iana.org/assignments/media-types/)). Connectors emit `blob_ref` without a `fetch_url`. The resource server injects `fetch_url` at read time when serving records via the query API.

`fetch_url` is the only PDPP-API way to discover bytes. Clients MUST follow it verbatim and treat it as opaque. The PDPP API does NOT define resource-specific byte URLs such as `/v1/streams/{stream}/records/{id}/content`, `/download`, or `/file`. Implementations MUST NOT expose such URLs as part of the PDPP contract, and clients MUST NOT construct them.

### Cross-stream references (resource_ref)

When a record references a record in a different stream on the same resource server, use a `resource_ref`. This is a within-subject, within-server pointer. Cross-user or cross-server references are out of scope.

```json
{
  "stream": "tag_assignments",
  "key": "assign_1",
  "data": {
    "tag_id": "tag_sunset",
    "target": {
      "connector_id": "https://registry.pdpp.org/connectors/instagram",
      "stream": "media",
      "record_id": "media_123"
    }
  }
}
```


## 5. Selection Request {#selection-request}

A client requests specific personal data by including `authorization_details` in an OAuth 2.0 authorization request, following RFC 9396.

```json
{
  "response_type": "code",
  "client_id": "music_recommendations",
  "redirect_uri": "https://app.example.com/callback",
  "scope": "openid",
  "client_display": {
    "name": "Concert Finder",
    "uri": "https://concertfinder.example.com",
    "logo_uri": "https://concertfinder.example.com/logo.png"
  },
  "authorization_details": [
    {
      "type": "https://pdpp.org/data-access",
      "connector_id": "https://registry.pdpp.org/connectors/spotify",
      "purpose_code": "https://pdpp.org/purpose/personalization",
      "purpose_description": "Recommend concerts based on your listening history",
      "access_mode": "single_use",
      "streams": [
        {
          "name": "top_artists",
          "necessity": "required",
          "time_range": { "since": "2025-09-28T00:00:00Z" }
        },
        {
          "name": "saved_tracks",
          "necessity": "optional"
        }
      ],
      "client_claims": {
        "commitments": ["Data used only for concert recommendations"]
      }
    }
  ]
}
```

### Client display metadata {#client-display}

The top-level `client_display` object carries self-asserted identity metadata for the requesting application. This follows the pattern established by GNAP (RFC 9635), which bundles client display metadata inline rather than requiring a separate registration step.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `client_display.name` | string | yes | Human-readable application name. |
| `client_display.uri` | URI | no | The client's homepage. |
| `client_display.logo_uri` | URI | no | URL to a square image representing the client. |

`client_display` is entity-scoped: it describes the client, not a specific authorization request. It appears at the top level of the authorization request, outside `authorization_details`.

**Server rendering obligations:**

1. The AS MUST display `client_display.name` to the user during consent.
2. If the server has a positive trust signal for the client (e.g., domain verification, trust registry membership), it MUST render that status distinctly (e.g., a "verified" badge). If it has no positive trust signal, it MUST treat the client as unverified and SHOULD display an "unverified app" indicator.
3. The AS MUST treat `logo_uri` as untrusted content. It MUST NOT fetch and render a client-supplied remote logo in the consent UI unless the client is verified or the asset has been proxied, cached, and approved under local policy. For unverified clients, the AS SHOULD generate a monogram from `client_display.name`.
4. If `client_display` is absent, the AS MUST display the `client_id` as the requester identity. The consent UI SHOULD clearly indicate that the client has not provided display metadata.

### Client claims {#client-claims}

The optional `client_claims` object within each `authorization_details` entry carries client-authored, non-enforceable statements about the specific authorization being requested. These are request-scoped, not entity-scoped: a client may make different commitments for different authorization requests.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `client_claims.commitments` | string[] | no | Free-text policy commitments relevant to this request (e.g., "Data used only for this study"). |

**Trust boundary:** Client claims are self-asserted and unverifiable by the server. The AS MUST render `client_claims` content separately from protocol-enforced grant terms and MUST attribute it to the client (e.g., "[client name] says:"). The AS MUST NOT render client claims in the same visual register as server-derived facts (access mode, retention, stream descriptions).

**Relationship to `purpose_description`:** `purpose_description` is a first-class request field describing what the authorization is for. It is part of the authorization semantics the user reviews. `client_claims.commitments` are supplementary promises that are not reducible to structured protocol fields. Both are client-authored, but `purpose_description` is the primary purpose statement while `commitments` are additional assurances.

**Commitments that ARE machine-readable:** Structured grant fields (e.g., `retention.max_duration`, `access_mode`) SHOULD be rendered by the AS as server-generated display text (e.g., "Deleted within 90 days", "Ongoing access until you revoke it"). Clients SHOULD NOT duplicate machine-readable constraints as free-text commitments. If a commitment duplicates a structured field, the structured field is authoritative.

### Request-level parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `connector_id` | URI | yes | Fully qualified connector identifier. |
| `purpose_code` | URI | yes | Machine-readable purpose (absolute URI). See Appendix A for the initial registry. The AS MUST accept any syntactically valid absolute-URI purpose code. For unrecognized codes, the AS MUST display `purpose_description` if present, or the raw URI if not, and MUST NOT reject the request solely because the purpose code is unrecognized. Consent properties associated with purpose codes in the registry are advisory, not protocol-enforced, with the exception of `https://pdpp.org/purpose/ai_training` (see below). |
| `purpose_description` | string | no | Human-readable purpose, displayed to the user during consent. Clients SHOULD provide this field. When present, the AS MUST display it. For standard purpose codes, the AS MAY display a human-readable label from the registry when `purpose_description` is absent. |
| `access_mode` | enum | yes | `single_use` or `continuous`. See Section 6. |
| `retention` | object | no | Requested retention constraints: `{ max_duration, on_expiry }`. |
| `streams` | StreamRequest[] | yes (unless `profile` is used) | Requested streams with per-stream parameters. |
| `profile` | string | no | Reference to a manifest-defined profile (alternative to explicit streams). |
| `client_claims` | object | no | Client-authored, non-enforceable claims about this request. See [Client claims](#client-claims). |

#### AI training consent {#ai-training-consent}

The AS MUST obtain explicit affirmative user consent before issuing any grant with `purpose_code` value `https://pdpp.org/purpose/ai_training`. This is the sole purpose code with a mandatory consent requirement at the protocol level.

### Stream selection parameters

Per-stream, within the `streams` array. All are optional except `name`.

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | string | Stream name, or `*` for all streams (resolved at consent time against the manifest). |
| `necessity` | enum | `required` (default) or `optional`. Optional streams are presented as user choices during consent. |
| `time_range.since` | ISO 8601 | Earliest data to include (inclusive, >=), evaluated against the stream's `consent_time_field`. |
| `time_range.until` | ISO 8601 | Latest data to include (exclusive, <), evaluated against the stream's `consent_time_field`. A hard cap: applies to future resources as well as past ones. |
| `view` | string | Named view defined by the authorization server. Mutually exclusive with `fields` in a request; both MUST NOT be present simultaneously. AS returns 400 `invalid_request` if both are present. |
| `fields` | string[] | Field allowlist. Schema-required fields are always included regardless of this list. In v0.1, restricted to top-level field names only. Mutually exclusive with `view`. |
| `resources` | string[] | Specific record IDs to authorize. Values are canonical key strings: minified JSON array for compound keys, plain string for simple keys. The AS validates arity and type against the manifest `primary_key` at grant issuance. The RS filters by exact primary-key match. |

**Note on `time_range`:** `time_range` is only valid for streams that declare a `consent_time_field` in their manifest. The authorization server MUST reject selection requests that specify `time_range` on a stream without a `consent_time_field`. The presence of `consent_time_field` in the manifest is the authoritative signal that a stream is time-range-capable. (The `selection.time_range` boolean has been removed from the manifest (see Section 7).)

**Note on wildcards:** `"streams": [{ "name": "*" }]` requests all streams the connector supports. This is resolved at consent time against the manifest and frozen as an explicit list in the grant.

**Note on `streams` vs `profile`:** `streams` and `profile` are mutually exclusive in a request. An authorization server MUST return 400 `invalid_request` if both are present.

**Note on defaults:** Omitting `fields` (and `view`) means all fields in the stream are authorized. Omitting `time_range` means no temporal constraint. Clients SHOULD request only the data they need (see Section 10, Data Minimization).

### Profiles

Connectors may define profiles (presets) in their manifest. A client can reference a profile instead of constructing explicit stream selections:

```json
{
  "type": "https://pdpp.org/data-access",
  "connector_id": "https://registry.pdpp.org/connectors/instagram",
  "profile": "social_summary"
}
```

The authorization server expands the profile into explicit streams before issuing the grant, pinned to the manifest version at consent time.

Every field in the issued grant is derived from either the selection request, client registration, or authorization server policy. The grant never contains values whose source is ambiguous.


## 6. Grant {#grant}

The grant is an immutable consent artifact. It is the output of the authorization flow.

The authorization server issues an access token bound to the grant. The client uses the access token (not the raw grant) to authenticate with the resource server. The resource server resolves the token to the grant and enforces its constraints on every request. Grant lifecycle (active, expired, revoked) is tracked by the authorization server, not stored in the grant itself.

```json
{
  "version": "0.1.0",
  "grant_id": "grt_8f72a1b3",
  "issued_at": "2026-04-06T15:00:00Z",
  "subject": { "id": "user_abc123" },
  "client": { "client_id": "music_recommendations" },
  "connector_id": "https://registry.pdpp.org/connectors/spotify",
  "manifest_version": "2.0.0",
  "purpose_code": "https://pdpp.org/purpose/personalization",
  "purpose_description": "Recommend concerts based on your listening history",
  "access_mode": "single_use",
  "streams": [
    {
      "name": "top_artists",
      "time_range": { "since": "2025-09-28T00:00:00Z" },
      "fields": ["id", "name", "genres", "popularity", "source_updated_at"]
    }
  ],
  "retention": {
    "max_duration": "P1Y",
    "on_expiry": "delete"
  },
  "expires_at": "2027-04-06T00:00:00Z"
}
```

### Grant fields (normative)

**The following field table is normative.** TypeScript types in Section 12 are illustrative.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `version` | string | yes | Protocol version. |
| `grant_id` | string | yes | Unique identifier. |
| `issued_at` | ISO 8601 | yes | When the grant was issued. |
| `subject` | object | yes | The user. At minimum `{ id }`. The `subject.id` is an opaque string, unique within the issuing AS's namespace. No format constraint is imposed. |
| `client` | object | yes | The client. At minimum `{ client_id }`. |
| `connector_id` | URI | yes | Fully qualified connector identifier. |
| `manifest_version` | string | yes | Connector manifest version this grant was validated against. Audit and pinning metadata; the RS is not required to fetch the manifest at request time. |
| `purpose_code` | URI | yes | Machine-readable purpose (see Appendix A). |
| `purpose_description` | string | no | Human-readable purpose. |
| `access_mode` | enum | yes | `single_use` or `continuous`. |
| `streams` | StreamGrant[] | yes | Granted streams. Always expanded; no wildcards. See StreamGrant fields table below. |
| `profile` | string | no | Which manifest profile was used (informational). |
| `retention` | object | no | Policy commitment by the data recipient (see below). |
| `expires_at` | ISO 8601 or null | no | Grant expiry. null means no expiry. |

### StreamGrant fields (normative)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Stream name. Always a concrete name; no wildcards in issued grants. |
| `view` | string | no | The view name selected at consent time (informational). |
| `fields` | string[] | no | Resolved field allowlist, authoritative for RS enforcement. Top-level field names only. Absent means all fields are authorized. |
| `time_range` | TimeRange | no | Authorized temporal window. Absent means no temporal constraint. |
| `resources` | string[] | no | Authorized record IDs in canonical key string encoding. Absent means all records. |

**Note:** `view` and `fields` may both appear in a `StreamGrant`: `view` is informational, `fields` are the enforcement list resolved at consent time. In a `StreamRequest`, they are mutually exclusive. The AS resolves the view to its field list at issuance time and stores the result in `fields`. View evolution never silently widens an existing grant; re-consent is required for new fields added to a view after grant issuance.

### Three time-related concepts

The grant carries three orthogonal time-related concepts that must not be conflated:

| Concept | Fields | Meaning |
|---------|--------|---------|
| Grant validity period | `issued_at`, `expires_at` | How long the authorization itself is active. |
| Data temporal scope | `streams[].time_range` | Which records the client is authorized to see, filtered by time. |
| Access pattern | `access_mode` | Whether the grant can be exercised once or continuously. |

A grant can be short-lived (expires in 1 hour) but cover all historical data (no `time_range`). A grant can be long-lived but cover only data from the last 6 months (`time_range.since`). A grant can be `single_use` but cover a large historical window. These combinations are all valid and distinct.

### Version layering

Three independent version axes exist in PDPP. They MUST NOT be conflated:

| Axis | Field | Meaning |
|------|-------|---------|
| Grant schema version | `grant.version` | Version of the PDPP grant schema. RS MUST reject grants with unsupported major versions, returning 400 `unsupported_version`. |
| Manifest version | `grant.manifest_version` | `manifest_version` identifies the manifest version against which the AS validated and resolved the grant at issuance time. The RS enforces the resolved grant as issued; it is not required to fetch the manifest at request time. If the RS implementation does not support grants generated against the pinned manifest version (e.g., due to incompatible schema changes introduced in a major manifest version bump), it returns 403 `grant_invalid`. This is a code-level compatibility check, not a runtime manifest fetch. |
| HTTP API contract version | `PDPP-Version` request header | Version of the RS HTTP API contract. RS returns 400 `unsupported_version` if the requested version is not supported. If the header is absent, the RS uses the current stable version and returns the selected version in the response header (see Section 8). |

### Access modes {#access-modes}

| Mode | Behavior |
|------|----------|
| `single_use` | The grant is consumed at first token issuance. The AS marks the grant consumed atomically with issuance of the first client access token. The RS honors all tokens issued against the grant until token expiry or revocation. The client MAY retry or resume pagination using the same access token. Failure to complete retrieval before token expiry does not un-consume the grant. The runtime does not persist STATE from single_use collection runs. |
| `continuous` | The grant is fulfilled repeatedly. The client may query the resource server incrementally over time. Active until expiry or revocation. |

### time_range semantics

`time_range` filters records by their stream's declared `consent_time_field` (see Section 7). The filter is:

```
record.consent_time_field >= time_range.since  (if since is present)
record.consent_time_field <  time_range.until  (if until is present)
```

`time_range.until` is a hard cap. It applies equally to records that existed at grant issuance and to records created afterward. A `continuous` grant with `time_range.until` set to a past date is valid: it is a historical-only grant that will never disclose new records. This is not an error.

For `continuous` grants without `time_range.until`, future records in a granted stream are included as they are collected, provided their `consent_time_field` falls within any `since` constraint. Stream names are frozen at consent time; future stream types require a new grant.

### Standing authorization

Grants freeze stream names at consent time. Within a granted stream, future records are included for `continuous` grants (subject to `time_range` constraints). Future stream types (streams not listed in the grant) are not included; they require a new grant.

### Grant narrowing

Grant narrowing (reducing the scope of an existing grant) is not supported in v0.1. Scope reduction is achieved via revoke-and-reissue: the client revokes the existing grant and the user issues a new, narrower grant. Authorization server UIs SHOULD model this flow as revocation followed by a new grant request.

### Records from revoked grants

Revocation stops future access only. Records already delivered to the client before revocation are governed by the grant's `retention` policy and applicable legal obligations. PDPP does not retroactively reach into client-side data stores.

### Retention

Retention is a policy commitment by the data recipient (the client). PDPP does not technically enforce retention. Enforcement is through legal agreements, contractual obligations, or trust registry mechanisms. This is consistent with how OAuth 2.0 treats scope compliance: the protocol makes the commitment legible and machine-readable; external mechanisms enforce it.

```json
{
  "max_duration": "P6M",
  "on_expiry": "delete"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `max_duration` | ISO 8601 duration | How long the client may retain collected data. |
| `on_expiry` | enum | `delete` or `anonymize`. Note: `archive` is not supported in v0.1. |

### Examples

**Specific data, single use:**
```json
{
  "version": "0.1.0",
  "grant_id": "grt_001",
  "issued_at": "2026-04-06T15:00:00Z",
  "subject": { "id": "user_abc" },
  "client": { "client_id": "concert_app" },
  "connector_id": "https://registry.pdpp.org/connectors/spotify",
  "manifest_version": "2.0.0",
  "purpose_code": "https://pdpp.org/purpose/personalization",
  "access_mode": "single_use",
  "streams": [
    {
      "name": "top_artists",
      "time_range": { "since": "2025-09-28T00:00:00Z" },
      "fields": ["id", "name", "genres", "popularity", "source_updated_at"]
    }
  ]
}
```

**Continuous access for an AI agent:**
```json
{
  "version": "0.1.0",
  "grant_id": "grt_002",
  "issued_at": "2026-04-06T15:00:00Z",
  "subject": { "id": "user_abc" },
  "client": { "client_id": "personal_agent" },
  "connector_id": "https://registry.pdpp.org/connectors/openai",
  "manifest_version": "2.0.0",
  "purpose_code": "https://pdpp.org/purpose/agent_context",
  "access_mode": "continuous",
  "streams": [
    { "name": "conversations" },
    { "name": "messages" }
  ],
  "expires_at": null
}
```

**Health data with field selection and retention:**
```json
{
  "version": "0.1.0",
  "grant_id": "grt_003",
  "issued_at": "2026-04-06T15:00:00Z",
  "subject": { "id": "user_abc" },
  "client": { "client_id": "sleep_analysis" },
  "connector_id": "https://registry.pdpp.org/connectors/oura",
  "manifest_version": "1.0.0",
  "purpose_code": "https://pdpp.org/purpose/analytics",
  "access_mode": "single_use",
  "streams": [
    {
      "name": "sleep_sessions",
      "time_range": { "since": "2026-01-01T00:00:00Z", "until": "2026-04-01T00:00:00Z" },
      "fields": ["day", "total_sleep_duration", "sleep_score"]
    }
  ],
  "retention": { "max_duration": "P90D", "on_expiry": "delete" }
}
```


## 7. Manifest Format {#manifest-format}

**Note:** This section defines manifest syntax only. Connector runtime behavior (collection, state management, interaction) is defined in the [PDPP Collection Profile](spec-collection-profile).

Each connector publishes a manifest declaring its consent surface: what streams it produces, what fields those streams contain, and what selection parameters are applicable. The manifest is the source of truth for what can be consented to. What is actually consented to is determined by the grant.

### Manifest structure

```json
{
  "protocol_version": "0.1.0",
  "connector_id": "https://registry.pdpp.org/connectors/spotify",
  "version": "2.0.0",
  "display_name": "Spotify",
  "profiles": [
    {
      "id": "listening_history",
      "label": "Listening history",
      "streams": [
        { "name": "top_artists" },
        { "name": "saved_tracks" }
      ]
    }
  ],
  "streams": [
    {
      "name": "top_artists",
      "description": "Most-listened artists over time",
      "display": {
        "label": "Your top artists",
        "detail": "Artist names, genres, and popularity scores. No listening timestamps or play counts."
      },
      "semantics": "mutable_state",
      "schema": {
        "type": "object",
        "properties": {
          "id": { "type": "string" },
          "name": { "type": "string" },
          "genres": { "type": "array", "items": { "type": "string" } },
          "popularity": { "type": "integer" },
          "source_updated_at": { "type": "string", "format": "date-time" }
        },
        "required": ["id", "name"]
      },
      "primary_key": ["id"],
      "cursor_field": "source_updated_at",
      "consent_time_field": "source_updated_at",
      "selection": {
        "fields": true,
        "resources": false
      },
      "views": [
        {
          "id": "basic",
          "label": "Artist names and genres",
          "fields": ["id", "name", "genres"]
        },
        {
          "id": "full",
          "label": "Full artist data",
          "fields": ["id", "name", "genres", "popularity", "source_updated_at"]
        }
      ]
    },
    {
      "name": "play_events",
      "description": "Individual track play events",
      "semantics": "append_only",
      "schema": {
        "type": "object",
        "properties": {
          "id": { "type": "string" },
          "track_id": { "type": "string" },
          "played_at": { "type": "string", "format": "date-time" },
          "duration_ms": { "type": "integer" }
        },
        "required": ["id", "track_id", "played_at"]
      },
      "primary_key": ["id"],
      "cursor_field": "played_at",
      "consent_time_field": "played_at",
      "selection": {
        "fields": true,
        "resources": false
      }
    }
  ]
}
```

### Manifest fields

| Field | Description |
|-------|-------------|
| `connector_id` | Fully qualified URI identifying this connector. |
| `version` | Connector version (semver). |
| `display_name` | Human-readable name for display in consent UIs. |
| `profiles` | Optional preset selections. The authorization server expands profiles into explicit stream lists before issuing grants. |
| `streams[].name` | Stream name, connector-local. |
| `streams[].display` | Optional consent-surface metadata. See [Stream display metadata](#stream-display). |
| `streams[].semantics` | `append_only` or `mutable_state`. |
| `streams[].schema` | JSON Schema for the record's `data` field. `primary_key` and `cursor_field` must reference fields declared here. |
| `streams[].primary_key` | Fields that uniquely identify a record within the stream. |
| `streams[].cursor_field` | Field used for incremental sync ordering (Collection Profile). Defined here for manifest syntax completeness; used by the Collection Profile runtime. The RS is not required to use this field for query enforcement; enforcement constraints are carried in the grant. |
| `streams[].consent_time_field` | The temporal consent boundary: the field against which `time_range` is evaluated. Absent means `time_range` is not applicable to this stream. Must reference a field declared in the schema. |
| `streams[].selection` | Which selection parameters this stream supports (`fields`, `resources`). Time-range capability is derived from `consent_time_field` presence; absent means not time-range-capable. The AS MUST reject grants that request `time_range` on a stream without a `consent_time_field`, or that request an unsupported selection parameter. |
| `streams[].views` | Named field projections the connector author suggests. Advisory; the AS is authoritative. Each view has `id`, `label`, and `fields` (top-level field names only). |
| `streams[].relationships` | Declared foreign key relationships to other streams. Used for expansion in the query API. |

### Stream display metadata {#stream-display}

Streams MAY include a `display` object with human-readable metadata for the consent UI. This metadata is authored by the connector maintainer (not the requesting client) and is trusted by the authorization server.

| Field | Type | Description |
|-------|------|-------------|
| `display.label` | string | Short human-readable name shown in the consent card (e.g., "Who you follow"). If absent, the AS SHOULD display `streams[].description` or fall back to the stream name. |
| `display.detail` | string | Consent-oriented description of what data is included and, where relevant, what is excluded (e.g., "Usernames and account IDs of accounts you follow. No DMs, profile details, or follower lists."). If absent, the AS MAY generate a description from the stream schema, or display no detail. |

**Authorship principle:** `display.label` and `display.detail` describe the data itself, not the requester's purpose. They are authored by the connector maintainer (who understands the source data) and curated through the connector registry. The requesting client MUST NOT be able to override or supplement these descriptions in the selection request. This separation ensures that the consent UI's data descriptions are trustworthy regardless of the client's intentions.

```json
{
  "name": "following_accounts",
  "description": "Accounts the user follows",
  "display": {
    "label": "Who you follow",
    "detail": "Usernames and account IDs of accounts you follow. No DMs, profile details, or follower lists."
  },
  "semantics": "mutable_state",
  "schema": { "..." : "..." }
}
```

### consent_time_field

The `consent_time_field` is the field on each record that the resource server evaluates `time_range` against. It represents the stream's temporal consent boundary: when the user consents to "data from the last 6 months," the `consent_time_field` is the field that determines whether a given record falls within that window.

The `consent_time_field` may be the same field as `cursor_field`, but they serve different purposes and must be declared separately:

- `cursor_field` governs incremental sync mechanics (which records to fetch since the last run).
- `consent_time_field` governs consent-time filtering (which records fall within the authorized time window).

For many `append_only` streams, both fields will be the same (e.g., `played_at` for play events). For some `mutable_state` streams they may differ: a playlists stream might use `source_updated_at` as the cursor (for efficient incremental sync) but `source_created_at` as the `consent_time_field` (because the user's consent to "playlists from the last 6 months" most naturally means playlists they created in that period, not playlists they edited).

The `consent_time_field` must be rendered in human-readable consent UX. A grant with `time_range: { since: "2026-01-01" }` on the `playlists` stream should be presented as "playlists created on or after January 1, 2026," not just "playlists in time_range."

Streams that cannot define a stable `consent_time_field` simply omit it. The absence of `consent_time_field` is the normative signal that the stream does not support time-range filtering.

### Relationships

```json
{
  "name": "conversations",
  "relationships": [
    {
      "name": "messages",
      "stream": "messages",
      "foreign_key": "conversation_id",
      "cardinality": "has_many"
    }
  ]
}
```

| Field | Description |
|-------|-------------|
| `name` | Relation name (used in `expand[]` on the query API). |
| `stream` | The related stream name. |
| `foreign_key` | The field on the related stream that references this stream's primary key. |
| `cardinality` | `has_many` or `has_one`. |

### Views {#views}

Views are named field projections that the authorization server may define for a stream, composed from fields declared in the stream schema. Views are the unit of consent when a client requests access by view name rather than by explicit field list.

Connector authors MAY suggest views in their manifest. These suggestions are advisory. The authorization server is authoritative for views used in consent UI and issued grants. The AS MUST NOT define a view that includes fields absent from the connector manifest schema for the relevant stream.

**View evolution:** Grants are bound to the resolved field set at issuance time: `fields` in the `StreamGrant` is authoritative, not the view name. View evolution (adding new fields to a view) never silently widens existing grants. Re-consent is required before a client can access new fields, even if those fields are subsequently added to a named view the client already has a grant for.

**Authority and registry:** Views defined under `pdpp.org` URI namespaces are controlled by PDPP maintainers via a public change process. Implementations MUST treat unrecognized view URIs as opaque identifiers.

**Note:** Canonical view naming conventions (standard view names with consistent semantics across connectors) are intentionally deferred. The protocol reserves this space; naming conventions will be informed by implementation experience.

### Versioning

Grants store `manifest_version`. The authorization server validates grants against the manifest at creation time.

- **Additive changes** (new optional fields, new streams, fields added to existing views): compatible. Existing grants continue to work. The new fields are accessible under grants that authorize the relevant view or that use no field filter.
- **Breaking changes** (removed fields, changed types, removed streams, fields removed from a view): require a new grant (re-consent).

The recommended evolution path: add new fields freely; never remove existing fields; create a new stream version (e.g., `playlists_v2`) if a breaking change is unavoidable.

**RS enforcement:** The RS enforces the resolved grant as issued. All enforcement constraints (stream names, field lists, time ranges) are embedded in the grant itself; the RS is not required to fetch the manifest at request time. If the RS implementation does not support grants generated against the pinned manifest version (e.g., due to incompatible schema changes in a major manifest version bump), it returns 403 `grant_invalid`. This is a code-level compatibility check, not a runtime manifest fetch.


## 8. Resource Server Interface {#resource-server-interface}

The resource server stores records and serves them to clients filtered by grants. This section is normative: a compliant resource server must implement this interface for cross-deployment interoperability.

### Grant enforcement

On every request, the resource server:

1. Resolves the access token via token introspection (RFC 7662-style) or a local equivalent for co-located deployments. Positive introspection results MUST NOT be cached longer than `min(token_exp, 60 seconds)`.
2. Checks: is the grant active (`active: true` in introspection response)?
3. Checks: is the requested stream in the grant's `streams` list?
4. Checks: do the request parameters fall within the grant's selection constraints (`time_range`, `fields`, `resources`)?
5. If all checks pass, returns records filtered accordingly.
6. If any check fails, returns a structured error (see Errors below).

The RS computes `effective_filter = grant_filter AND request_filter`. Request filters can only narrow what the grant allows; they cannot widen it.

The RS MUST NOT re-validate with the AS beyond introspection. All enforcement constraints are in the grant.

**Token type distinction:** The format of the access token is opaque to the Resource Server. The RS MUST determine the token's properties (including `pdpp_token_kind`) solely from the introspection response, never from token syntax.

### Token introspection

For separated AS/RS deployments, the RS calls the AS introspection endpoint (RFC 7662). PDPP defines the following extension fields in the introspection response:

| Field | Type | Description |
|-------|------|-------------|
| `active` | boolean | Whether the token is currently valid. |
| `pdpp_token_kind` | string | `"owner"` or `"client"`. |
| `subject_id` | string | The subject (user) identifier. |
| `grant_id` | string | The associated grant identifier. Present for client tokens. |
| `client_id` | string | The client identifier. Present for client tokens. |
| `exp` | integer | Expiry timestamp (Unix epoch). |

Positive introspection results MUST NOT be cached longer than `min(token_exp, 60 seconds)`. Self-contained JWTs (e.g., signed JWTs) are allowed as an optimization but MUST NOT be the sole revocation mechanism; the RS MUST still be able to check active status through introspection or local equivalent.

### Authentication

Two authentication boundaries exist:

**Owner operations** (ingest, state management, grant administration): `Authorization: Bearer <owner_token>`. Owner tokens are scoped to a single subject's data store. The RS MUST derive the `subject_id` from the introspection response and MUST reject any request attempting to access data outside that subject's scope. How the owner obtains this token is out of scope (device code flow, API key, or any other mechanism).

**Client operations** (query records, list streams, fetch blobs): `Authorization: Bearer <access_token>`. Access tokens are bound to a specific grant. Both token types use RFC 6750 Bearer Token format. The RS distinguishes them via `pdpp_token_kind` in the introspection response.

**Self-export:** An owner holding a valid owner token MAY query their own data using the standard client query endpoints without a client grant. This is the v0.1 self-export mechanism and does not require a separate grant. Conformant Core RS implementations SHOULD support this capability (see Section 9 conformance item 12).

### Endpoints

#### Discover schema and capabilities

A Core RS MAY expose a one-shot discovery endpoint that returns the caller-visible source/stream capability graph (schema, query declarations, field capabilities, expansion capabilities, and freshness) in a single response, scoped to the bearer (owner-visible connectors for owner tokens; grant scope for client tokens). The PDPP reference implementation exposes this at `GET /v1/schema`. The shape MUST be derivable from the same per-stream metadata that powers `GET /v1/streams/{stream}` — discovery is an aggregation, not an independent capability model.

#### List streams

```
GET /v1/streams
Authorization: Bearer <access_token>
```

Returns the streams available under the current grant with record counts.

**Response:**
```json
{
  "object": "list",
  "data": [
    {
      "object": "stream",
      "name": "conversations",
      "record_count": 2196,
      "last_updated": "2026-04-06T15:01:00Z"
    },
    {
      "object": "stream",
      "name": "messages",
      "record_count": 48302,
      "last_updated": "2026-04-06T15:01:00Z"
    }
  ]
}
```

#### Get stream metadata {#stream-metadata}

```
GET /v1/streams/{stream}
Authorization: Bearer <access_token>
```

Returns full stream metadata. Response:

```json
{
  "object": "stream_metadata",
  "name": "top_artists",
  "schema": { },
  "primary_key": ["id"],
  "cursor_field": "source_updated_at",
  "consent_time_field": "source_updated_at",
  "selection": {
    "fields": true,
    "resources": false
  },
  "views": [
    { "id": "basic", "label": "Artist names and genres", "fields": ["id", "name", "genres"] }
  ],
  "relationships": [
    { "name": "messages", "stream": "messages", "foreign_key": "conversation_id", "cardinality": "has_many" }
  ]
}
```

#### List records {#list-records}

```
GET /v1/streams/{stream}/records
Authorization: Bearer <access_token>
```

Returns records from a stream, filtered by the grant and any additional request parameters.

**Query parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `limit` | integer | Records per page. Default 25, max 100. |
| `cursor` | string | Opaque pagination token from a previous response. Clients MUST NOT parse or construct cursor tokens. |
| `order` | enum | `desc` (default) or `asc`. |
| `filter[{field}]` | string | Exact match filter. |
| `filter[{field}][gte]` | string | Greater than or equal (ISO 8601 for dates). |
| `filter[{field}][gt]` | string | Greater than. |
| `filter[{field}][lte]` | string | Less than or equal. |
| `filter[{field}][lt]` | string | Less than. |
| `view` | string | Request records projected to a named view. Mutually exclusive with `fields`. |
| `fields` | comma-separated | Sparse fieldset. Schema-required fields are always included. In v0.1, restricted to top-level field names only. Mutually exclusive with `view`. |
| `expand[]` | string | Expand a declared foreign key relation inline. Expanded relations appear under the `expanded` key on the parent record. |
| `expand_limit[{relation}]` | integer | Max records per expanded relation. Default 10, max 50. |
| `changes_since` | string | Opaque incremental-sync token from a previous session (distinct token space from `cursor`). Returns only records whose grant-authorized projection changed since that cursor, plus tombstones for deletions. Use `next_changes_since` from the terminal page to seed the next session. Returns HTTP 410 Gone if the cursor has expired. |

**Stable sort:** Records are sorted by `(cursor_field, primary_key)` for cursor safety.

**Incremental sync for mutable streams:** Pass `changes_since` to retrieve only records changed since a previous sync. The resource server returns changed records within the grant's authorized field projection. If a record was deleted, a tombstone entry is included. If the cursor has expired (HTTP 410), the client must perform a full re-sync.

**Filter on unauthorized field:** RS MUST reject a `filter[{field}]` parameter targeting a field outside the grant's authorized projection with 403 `field_not_granted`.

**Expansion:** Requesting an unknown relation returns 400 `invalid_expand`. Requesting expansion of a stream not in the grant returns 403 `insufficient_scope`. Expansion never widens stream or field permissions beyond the grant.

**Response:**
```json
{
  "object": "list",
  "url": "/v1/streams/conversations/records",
  "has_more": true,
  "next_cursor": "eyJjcmVhdGVkX2F0IjoiMjAyNi0wMy0yNVQxODoyMjoxMVoiLCJpZCI6ImNvbnZfMDFKUVc4TTJSNyJ9",
  "next_changes_since": "eyJjaGFuZ2VzX3NpbmNlIjoiMjAyNi0wNC0wNlQxNTowMTowMFoifQ",
  "data": [
    {
      "object": "record",
      "id": "conv_01JQW8M2R7",
      "stream": "conversations",
      "data": {
        "id": "conv_01JQW8M2R7",
        "title": "Trip planning",
        "source_created_at": "2026-03-25T18:22:11Z"
      },
      "emitted_at": "2026-04-06T15:01:00Z"
    }
  ]
}
```

The terminal page of a `changes_since` request (i.e., `has_more: false`) MUST include `next_changes_since`.

#### Get a single record

```
GET /v1/streams/{stream}/records/{id}
Authorization: Bearer <access_token>
```

Returns a single record by primary key. The `{id}` path parameter is the percent-encoded canonical key string. Supports `expand[]`.

#### Delete a record (owner-authenticated)

```
DELETE /v1/streams/{stream}/records/{id}
Authorization: Bearer <owner_token>
```

Permanently removes a record from the stream. The RS may implement this as a tombstone internally. Returns 204 No Content on success. The `{id}` path parameter is the percent-encoded canonical key string.

#### Get a blob

```
GET /v1/blobs/{blob_id}
Authorization: Bearer <access_token>
```

The resource server authorizes blob access by verifying that:

1. The grant includes a stream containing a record that references this `blob_id`.
2. The referencing record passes all grant filters.
3. The `blob_ref` field is included in the grant's authorized field projection.

A `blob_id` alone does not grant access. The client must have discovered the blob through an authorized record.

**Direct response** MUST include:
- `Content-Type` (IANA media type)
- `Content-Length` if known
- `Cache-Control: private, no-store`
- `Accept-Ranges: bytes` if range requests are supported

**Redirect response** (HTTP 302) MUST include:
- `Location` header pointing to a short-lived signed URL (valid for at least 60 seconds)
- `Cache-Control: no-store`

A stale or unknown `blob_id` returns 404 `blob_not_found`.

`HEAD` is supported for size checks. `Range` headers are recommended for large files.

#### Collection Profile endpoints {#collection-profile-endpoints}

> The following endpoints are part of the PDPP Collection Profile. A Core RS implementation is NOT required to implement them. An implementation claiming PDPP Collection Profile support MUST implement both endpoints.

##### Ingest records (owner-authenticated)

```
POST /v1/ingest/{stream}
Authorization: Bearer <owner_token>
Content-Type: application/x-ndjson
```

Body is NDJSON (one RECORD envelope per line). Used by the connector runtime.

**Validation:** The RS MUST reject records whose `consent_time_field` value is null, absent, or not a valid ISO 8601 datetime with 400 `invalid_record`. For any record, if the values of the `data` fields named by the stream's `primary_key` disagree with the corresponding values in the `key` envelope field, the RS MUST fail with 400 `invalid_record_identity`. If legacy records with invalid `consent_time_field` values exist, the RS MUST exclude them from time-bounded queries.

Response:

```json
{
  "stream": "conversations",
  "records_accepted": 2,
  "records_rejected": 0
}
```

##### Sync state (owner-authenticated)

```
GET  /v1/state/{connector_id}
PUT  /v1/state/{connector_id}
Authorization: Bearer <owner_token>
```

Returns and updates the StreamState map for incremental sync (see Collection Profile).

`GET` response:
```json
{
  "object": "stream_state",
  "connector_id": "https://registry.pdpp.org/connectors/spotify",
  "state": {
    "top_artists": { "last_updated": "2026-04-01T00:00:00Z" }
  },
  "updated_at": "2026-04-06T15:00:00Z"
}
```

`PUT` request body:
```json
{
  "state": {
    "top_artists": { "last_updated": "2026-04-06T15:00:00Z" }
  }
}
```

`PUT` returns the same shape as `GET`.

### Errors {#errors}

Every non-2xx response returns a structured error:

```json
{
  "error": {
    "type": "permission_error",
    "code": "grant_stream_not_allowed",
    "message": "Grant does not include stream 'messages'.",
    "param": "expand[0]",
    "request_id": "req_01JQXA3N9Y"
  }
}
```

| Code | HTTP Status | Type | Meaning |
|------|------------|------|---------|
| `invalid_cursor` | 400 | `invalid_request_error` | Cursor token is malformed or unrecognized. |
| `invalid_request` | 400 | `invalid_request_error` | Malformed request parameter or mutually exclusive parameters. |
| `invalid_record` | 400 | `invalid_request_error` | Record failed validation (e.g., invalid consent_time_field). |
| `invalid_record_identity` | 400 | `invalid_request_error` | The `data` fields named by `primary_key` disagree with the `key` envelope field values. |
| `invalid_expand` | 400 | `invalid_request_error` | Relation is not declared as expandable. |
| `unknown_field` | 400 | `invalid_request_error` | Requested field not in stream schema. |
| `unsupported_version` | 400 | `invalid_request_error` | `PDPP-Version` header specifies unsupported version, or grant references unsupported schema version. |
| `authentication_error` | 401 | `authentication_error` | Missing or invalid access token. |
| `field_not_granted` | 403 | `permission_error` | Filter targets a field outside the grant's authorized projection. |
| `insufficient_scope` | 403 | `permission_error` | Expansion requests a stream not in the grant. |
| `grant_stream_not_allowed` | 403 | `permission_error` | Stream not in grant. |
| `grant_time_range_exceeded` | 403 | `permission_error` | Request filters exceed grant's `time_range`. |
| `grant_expired` | 403 | `permission_error` | Grant has expired. |
| `grant_revoked` | 403 | `permission_error` | Grant has been revoked. |
| `grant_invalid` | 403 | `permission_error` | Grant references unsupported manifest version. |
| `blob_not_found` | 404 | `not_found_error` | `blob_id` is unknown or stale. |
| `not_found` | 404 | `not_found_error` | Stream or record not found. |
| `cursor_expired` | 410 | `gone_error` | `changes_since` cursor is too old; full re-sync required. |
| `rate_limit_exceeded` | 429 | `rate_limit_error` | Too many requests. Includes `Retry-After` header. |
| `api_error` | 500 | `api_error` | Internal server error. |

### API versioning

API version is specified via header:

```
PDPP-Version: 2026-04-06
```

If the `PDPP-Version` header is absent, the RS uses the current stable version and returns the selected version in the `PDPP-Version` response header. If the requested version is not supported, the RS returns 400 `unsupported_version`.

Every response includes a `Request-Id` header for debugging.

### Concurrent collection

Multiple collection runs for the same connector may execute concurrently. The resource server handles this through idempotent writes:

- Records are upserted by primary key. A record written twice with the same key and data is idempotent.
- Cursor state is accepted only if it advances the cursor (max of current and incoming). A slower run cannot regress the cursor.


## 9. Conformance {#conformance}

This section defines what it means to implement each PDPP role. Conformance claims should reference this section.

### Authorization Server conformance

A conformant authorization server:

1. Accepts selection requests using the RFC 9396 `authorization_details` envelope with `type: "https://pdpp.org/data-access"`.
2. Validates selection requests against the connector manifest: rejects unknown streams, unsupported selection parameters (e.g., `time_range` on a stream without `consent_time_field`), and unrecognized profiles.
3. Issues grants that conform to the grant schema defined in Section 6 (normative field tables). All grant fields are derived from the selection request, client registration, or AS policy.
4. Expands wildcards (`"name": "*"`) and profiles into explicit stream lists before issuing the grant.
5. Returns 400 `invalid_request` when both `streams` and `profile` are present in a request.
6. MUST NOT reject a `purpose_code` solely because it is not in the PDPP registry. For unrecognized codes, displays `purpose_description` if present, or the raw URI. MAY reject a `purpose_code` based on local policy.
7. Tracks grant lifecycle (active, expired, revoked). Reflects revocation immediately in introspection responses (`active: false`).
8. Issues access tokens bound to specific grants. Access tokens include the PDPP introspection extension fields.
9. Validates stream/field/view/resource-id shape at grant issuance.
10. MUST NOT define a view including fields absent from the connector manifest schema.
11. Resolves view names to field lists at issuance time; stores resolved `fields` in the `StreamGrant`.
12. Obtains explicit affirmative user consent before issuing grants with `purpose_code: "https://pdpp.org/purpose/ai_training"`.
13. Returns 400 `unsupported_version` if `PDPP-Version` header specifies an unsupported version.

### Resource Server conformance

**Tier 1: Core RS**

A conformant Core RS:

1. Implements the query endpoints defined in Section 8: list streams, get stream metadata, list records, get a single record, get a blob, delete a record (owner-authenticated).
2. Enforces grant constraints on every client request: stream membership, `time_range`, `fields` allowlist, `resources` filter.
3. Resolves access tokens via introspection (RFC 7662) or local equivalent. Caches positive introspection results no longer than `min(token_exp, 60 seconds)`.
4. Distinguishes owner tokens from client tokens via `pdpp_token_kind`.
5. Computes effective filters as `grant_filter AND request_filter`.
6. Returns structured errors as defined in Section 8 (unified error table).
7. Supports incremental sync via `changes_since` for `mutable_state` streams, including tombstone entries and HTTP 410 on cursor expiry.
8. Returns `next_changes_since` on the terminal page of every `changes_since` response.
9. Rejects `filter[{field}]` on fields outside the grant's authorized projection with 403 `field_not_granted`.
10. Implements the `PDPP-Version` header negotiation.
11. Scopes owner token access to a single subject's data store; derives `subject_id` from introspection response.
12. SHOULD support owner-authenticated access to the `/v1/streams/{stream}/records` query endpoints without a client grant, allowing the data subject to export their own data directly (self-export).

**Tier 2: PDPP Collection Profile support**

An implementation claiming PDPP Collection Profile support MUST additionally implement:

1. `POST /v1/ingest/{stream}`: owner-authenticated record ingestion.
2. `GET /v1/state/{connector_id}` and `PUT /v1/state/{connector_id}`: sync state management.

### Connector conformance

Connector conformance is defined in the [PDPP Collection Profile](spec-collection-profile).

### Client conformance

A conformant client:

1. Submits selection requests using the RFC 9396 `authorization_details` envelope.
2. Uses access tokens (not raw grants) to authenticate with the resource server.
3. Treats `cursor` and `changes_since` tokens as opaque and from distinct token spaces. MUST NOT use a `next_cursor` value as a `changes_since` parameter.
4. Stores `next_changes_since` from the terminal page of a `changes_since` response for use in the next sync session.
5. Respects HTTP 410 responses by performing a full re-sync rather than retrying with the expired cursor.
6. Honors retention commitments declared in the grant.
7. MUST terminate an active collection run as soon as practical upon learning of grant revocation (e.g., via HTTP 403 `grant_revoked` response).

### Conformance test suite

A formal conformance test suite is planned but is not defined in v0.1. This is out of scope for the current version.


## 10. Security and Privacy Considerations {#security}

### Token security

PDPP defines two token kinds at the resource server boundary: owner tokens and client tokens. Both use RFC 6750 Bearer Token format on the wire. The RS distinguishes them via `pdpp_token_kind` in the introspection response, not by token syntax.

For separated AS/RS deployments, the RS calls the AS introspection endpoint (RFC 7662). For co-located deployments, a local equivalent (shared database lookup or function call) is acceptable. Self-contained JWTs are allowed as an optimization but MUST NOT be the sole revocation mechanism.

Positive introspection results MUST NOT be cached longer than `min(token_exp, 60 seconds)`. This bounds the propagation window for revocation.

Implementations SHOULD use short-lived access tokens with refresh tokens for `continuous` grants.

### Grant integrity

The grant is designed to be signable. The `subject` and `client` fields support future JWS/JWT signatures. Implementations MUST treat grants as tamper-sensitive. Grant signing and a formal token format are deferred to a future version; the current design is compatible with adding them without breaking changes.

Large `authorization_details` payloads may exceed URL length limits. Production deployments SHOULD use Pushed Authorization Requests (PAR, RFC 9126).

### Credential handling

INTERACTION_RESPONSE messages in the Collection Profile may contain passwords and OTP codes. Runtimes MUST NOT log or persist credential data. See the [PDPP Collection Profile](spec-collection-profile) for details.

### Connector trust

In the Collection Profile, connectors receive credentials via the INTERACTION channel. A malicious connector could exfiltrate credentials. Production deployments SHOULD mitigate this by sandboxing connector processes (restricting network egress), using connectors from trusted registries only, or having the runtime authenticate on behalf of the connector and pass only session tokens. A formal connector trust model is deferred.

### Trust boundary responsibilities

| Role | Responsibilities |
|------|----------------|
| **Authorization Server** | Validates purpose codes; authenticates user; enforces consent UI; validates stream/field/view/resource-id shape at grant issuance; resolves views to field lists; issues access tokens; maintains grant lifecycle. |
| **Resource Server** | Validates token via introspection; enforces stream membership, field projection, time_range, resources on every request; never re-validates beyond introspection; scopes owner access to single subject. |
| **Client** | Submits well-formed selection requests; uses access tokens; terminates on revocation; honors retention commitments. |

### Data minimization {#data-minimization}

Stream-level and field-level selection implements the GDPR principle of data minimization. Clients SHOULD request only the data they need for their stated purpose. Authorization servers SHOULD display the specific fields and streams being requested during consent.

### Purpose limitation

The `purpose_code` URI enables purpose-based access control and audit. Authorization servers MAY restrict client registrations to specific purpose codes. Personal servers SHOULD log purpose codes for auditability.

### Retention

The `retention` field is a policy commitment by the data recipient. PDPP does not technically enforce retention. Enforcement is through legal agreements, contractual obligations, or trust registry mechanisms. This is an intentional design choice, consistent with how OAuth 2.0 treats scope compliance.

### Revocation {#revocation}

There is no push revocation channel in v0.1. Revocation propagation is bounded by the introspection cache TTL (maximum 60 seconds). The AS MUST reflect revocation immediately in introspection responses (`active: false`). A client will receive a 403 `grant_revoked` response no later than 60 seconds after revocation.

If a grant is revoked while a collection run is in progress, the runtime MUST terminate the connector as soon as practical. Specifically: upon receiving any 403 `grant_revoked` response, the client MUST stop further requests against that grant.

Revocation stops future access only. Data already delivered to the client before revocation is governed by the grant's `retention` policy and applicable legal obligations.


## 11. Scope and Boundaries

### In scope (v0.1)

- Parameterized grants for user-owned data
- Flat relational streams with declared schemas
- Binary data references (`blob_ref`)
- Cross-stream references within a single subject (`resource_ref`)
- Connector manifest declaring the consent surface
- Resource server query API with cursor-based pagination and grant enforcement
- Incremental sync for `mutable_state` streams via `changes_since`
- Tombstones for deleted records
- Owner-authenticated user erasure (`DELETE /v1/streams/{stream}/records/{id}`)
- Self-export via owner token (informative)
- Conformance definitions for all roles

### Out of scope (v0.1)

| Concern | Status |
|---------|--------|
| Authorization server interface | Introspection endpoint contract defined here; full AS interface informational only; see Session Relay Profile |
| Ingest and sync-state endpoints | Required for Collection Profile support only; not required for Core RS |
| Conformance test suite | Planned but not defined in v0.1 |
| Webhook / push ingestion | Deferred; see spec-deferred |
| Source lifecycle actions | Deferred (e.g., deleting source data after export); see spec-deferred |
| Event-driven collection triggers | Deferred; architecturally distinct from the pull-based Collection Profile |
| Grant signing and token format | Deferred; current design is compatible |
| Trust registry and connector certification | Deferred |
| Consent screen UX | Surface-specific; out of scope |
| Point-in-time reconstruction | Deferred (reconstructing full state at a past timestamp) |
| Canonical view naming vocabulary | Deferred; will be informed by implementation experience |
| Predicate-based grant scoping | Deferred; see spec-deferred for subset template design direction |
| Real-time streaming | Different spec needed |

### Predicate-based grant scoping

v0.1 grants narrow access only by stream selection, named view or field projection, time range, and explicit resource identifiers. Generic predicate expressions (e.g., `filter[sender_domain]=amazon.com` as a grant parameter) are not supported.

**Request-time filters are not grant scope.** The `filter[{field}]` query parameters on `GET /v1/streams/{stream}/records` narrow the result set returned for a particular request but do not narrow the authorization scope of the underlying grant. A client authorized for a stream may request a filtered subset of that stream; the grant remains a grant to the stream as issued.

**Derived subset streams (informative).** A stream MAY represent either a source-native collection or a connector-defined derived subset, provided its semantics are stable, versioned through the manifest, and human-reviewable in consent UI. Implementations that need semantically bounded consent in v0.1 SHOULD prefer named streams with human-readable semantics (e.g., a connector that exposes `amazon_messages` as a distinct stream) over ad hoc technical predicates. Stream names MUST NOT encode predicate logic or synthesize per-request subsets; derived streams must be statically declared in the manifest.

The recommended future direction for this capability is manifest-declared parameterized subset templates with typed bound parameters and connector-defined consent display strings. See spec-deferred for the design constraints and open questions that must be resolved before specifying this.


## 12. TypeScript Types

**Note:** TypeScript types in this section are illustrative. The normative definitions are the prose field tables in Sections 5, 6, and 7.

```typescript
// --- Record model ---

interface BlobRef {
  blob_id: string;
  mime_type: string;       // IANA media type
  size_bytes: number;
  sha256: string;
  fetch_url?: string;      // Injected by resource server at read time; absent in connector output
}

interface ResourceRef {
  connector_id: string;    // Fully qualified URI
  stream: string;
  record_id: string | string[];
}

// --- Selection (request-time) ---

interface TimeRange {
  since?: string;          // ISO 8601, inclusive >=
  until?: string;          // ISO 8601, exclusive <
}

interface StreamRequest {
  name: string;
  necessity?: 'required' | 'optional';
  time_range?: TimeRange;
  view?: string;           // Mutually exclusive with fields
  fields?: string[];       // Top-level field names only in v0.1; mutually exclusive with view
  resources?: string[];    // Canonical key strings per compound key encoding
}

// --- Grant (post-consent, immutable) ---

interface StreamGrant {
  name: string;
  view?: string;           // Informational: the view name selected at consent time
  fields?: string[];       // Authoritative for RS enforcement; top-level field names only
  time_range?: TimeRange;
  resources?: string[];    // Canonical key strings per compound key encoding
}

interface DataGrant {
  version: string;
  grant_id: string;
  issued_at: string;
  subject: { id: string; [key: string]: unknown };
  client: { client_id: string; [key: string]: unknown };
  connector_id: string;
  manifest_version: string;
  purpose_code: string;    // URI
  purpose_description?: string;
  access_mode: 'single_use' | 'continuous';
  streams: StreamGrant[];
  profile?: string;
  retention?: {
    max_duration: string;  // ISO 8601 duration
    on_expiry: 'delete' | 'anonymize';
  };
  expires_at?: string | null;
}

// --- Manifest ---

interface StreamView {
  id: string;
  label: string;
  fields: string[];
}

interface StreamRelationship {
  name: string;
  stream: string;
  foreign_key: string;
  cardinality: 'has_many' | 'has_one';
}

interface ManifestStream {
  name: string;
  description: string;
  semantics: 'append_only' | 'mutable_state';
  schema: Record<string, unknown>;
  primary_key: string[];
  cursor_field?: string;           // Collection Profile: incremental sync ordering
  consent_time_field?: string;     // Absent means time_range not supported for this stream
  selection: {
    // time_range capability derived from consent_time_field presence
    fields: boolean;
    resources: boolean;
  };
  views?: StreamView[];
  relationships?: StreamRelationship[];
}

interface ConnectorManifest {
  protocol_version: string;
  connector_id: string;
  version: string;
  display_name: string;
  profiles?: Array<{
    id: string;
    label: string;
    streams: StreamRequest[];
  }>;
  streams: ManifestStream[];
}

// --- Token introspection response (PDPP extensions to RFC 7662) ---

interface PDPPIntrospectionResponse {
  active: boolean;
  pdpp_token_kind?: 'owner' | 'client';
  subject_id?: string;
  grant_id?: string;       // Present for client tokens
  client_id?: string;      // Present for client tokens
  exp?: number;            // Unix timestamp
}

// --- Tombstone (response object) ---

interface TombstoneRecord {
  object: 'record';
  id: string;              // Canonical key string
  stream: string;
  deleted: true;
  deleted_at: string;      // ISO 8601, required
  emitted_at: string;      // ISO 8601, required
  // No data field
}
```


## Appendix A: Purpose Code Registry

**Registry governance:** Purpose code registries under `pdpp.org` are controlled by PDPP maintainers via a public change process. Implementations MUST treat unrecognized purpose URIs as opaque identifiers and MUST NOT reject requests solely because a purpose code is unrecognized.

Purpose codes are URIs. The following codes are defined by PDPP. Implementers may define additional codes using their own URI namespaces.

| Code | Description |
|------|-------------|
| `https://pdpp.org/purpose/personalization` | Tailoring the application experience to the user. |
| `https://pdpp.org/purpose/analytics` | Analyzing user data to produce insights for the user. |
| `https://pdpp.org/purpose/export` | Exporting data for the user's own use. |
| `https://pdpp.org/purpose/agent_context` | Providing context to a personal AI agent. |
| `https://pdpp.org/purpose/ai_training` | Using data to train AI models. The AS MUST obtain explicit affirmative user consent before issuing any grant with this purpose code. This is a protocol-level requirement, not merely advisory. |
| `https://pdpp.org/purpose/research` | Academic or market research. |


## Appendix B: Relationship to the Data Transfer Project (DTI)

PDPP and DTI are complementary protocols addressing different concerns. PDPP defines parameterized consent and disclosure semantics (the grant is the consent artifact; the query API is the disclosure mechanism). DTI defines canonical data models and transfer adapters (the mechanics of moving data between systems).

The two protocols can chain: a PDPP grant can authorize access to data that a DTI transfer then moves, using PDPP stream schemas to carry DTI canonical data model payloads. Formal integration between PDPP grants and DTI transfer manifests is a separate effort; no integration document is currently specified.

Note: "Data Transfer Project" is referred to as DTI (Data Transfer Initiative) in current usage, reflecting its evolution from the original DTP initiative.
