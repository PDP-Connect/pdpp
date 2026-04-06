# Personal Data Portability Protocol (PDPP) v0.1.0

Status: Draft
Date: 2026-04-06

---

## 1. Introduction

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
| Data Transfer Project (DTI) | PDPP grants can serve as consent artifacts in DTI transfers. PDPP stream schemas can carry DTI canonical data models. See Appendix B. |
| GDPR / DMA | PDPP implements data minimization (field and stream selection) and purpose limitation (`purpose_code`). The `continuous` access mode enables ongoing portability aligned with the DMA's requirements. |

---

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

### Data concepts

| Term | Definition |
|------|-----------|
| **Grant** | An immutable consent artifact specifying what data a client may access, under what constraints. |
| **Stream** | A named collection of records with a schema, primary key, and optional cursor field. Stream names are connector-local (e.g., `messages`). The fully qualified form is `connector_id` + stream name, used in cross-connector references and storage. |
| **Record** | A single data object within a stream. |
| **Connector** | A program that collects data from a data source. Defined in the Collection Profile. |
| **Manifest** | A connector's declaration of the streams it can produce and the consent surface it exposes. |
| **Selection Request** | A client's request for specific data, expressed as RFC 9396 `authorization_details`. |
| **View** | A named field projection defined by the authorization server, composed from manifest-declared fields. Views are the unit of consent for field-level access. |

---

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

---

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

**Cursor expiry:** Resource servers MAY expire historical version data after a retention period. If a client's cursor has expired, the resource server MUST return HTTP 410 Gone. The client MUST perform a full re-sync to re-establish its baseline.

**Tombstones:** When a record is deleted from a `mutable_state` stream, the resource server MUST include a tombstone entry in incremental sync responses for clients whose cursor predates the deletion. Tombstone format:

```json
{
  "object": "record",
  "id": "playlist_123",
  "stream": "playlists",
  "deleted": true,
  "deleted_at": "2026-04-01T10:00:00Z"
}
```

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

---

## 5. Selection Request

A client requests specific personal data by including `authorization_details` in an OAuth 2.0 authorization request, following RFC 9396.

```json
{
  "response_type": "code",
  "client_id": "music_recommendations",
  "redirect_uri": "https://app.example.com/callback",
  "scope": "openid",
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
      ]
    }
  ]
}
```

### Request-level parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `connector_id` | URI | yes | Fully qualified connector identifier. |
| `purpose_code` | URI | yes | Machine-readable purpose. See Appendix A for the initial registry. Custom purposes use implementer-defined URIs. |
| `purpose_description` | string | no | Human-readable purpose, displayed to the user during consent. |
| `access_mode` | enum | yes | `single_use` or `continuous`. See Section 6. |
| `retention` | object | no | Requested retention constraints: `{ max_duration, on_expiry }`. |
| `streams` | StreamRequest[] | yes (unless `profile` is used) | Requested streams with per-stream parameters. |
| `profile` | string | no | Reference to a manifest-defined profile (alternative to explicit streams). |

### Stream selection parameters

Per-stream, within the `streams` array. All are optional except `name`.

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | string | Stream name, or `*` for all streams (resolved at consent time against the manifest). |
| `necessity` | enum | `required` (default) or `optional`. Optional streams are presented as user choices during consent. |
| `time_range.since` | ISO 8601 | Earliest data to include (inclusive, >=), evaluated against the stream's `consent_time_field`. |
| `time_range.until` | ISO 8601 | Latest data to include (exclusive, <), evaluated against the stream's `consent_time_field`. A hard cap: applies to future resources as well as past ones. |
| `fields` | string[] | Field allowlist. Schema-required fields are always included regardless of this list. |
| `resources` | string[] | Specific resource IDs (e.g., specific playlist IDs). |

**Note on `time_range`:** `time_range` is only valid for streams that declare a `consent_time_field` in their manifest. The authorization server MUST reject selection requests that specify `time_range` on a stream without a `consent_time_field`. Streams that cannot define a stable temporal consent boundary are simply not `time_range`-compatible.

**Note on wildcards:** `"streams": [{ "name": "*" }]` requests all streams the connector supports. This is resolved at consent time against the manifest and frozen as an explicit list in the grant.

**Note on defaults:** Omitting `fields` means all fields in the stream are authorized. Omitting `time_range` means no temporal constraint. Clients SHOULD request only the data they need (see Section 10, Data Minimization).

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

---

## 6. Grant

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
      "time_range": { "since": "2025-09-28T00:00:00Z" }
    }
  ],
  "retention": {
    "max_duration": "P1Y",
    "on_expiry": "delete"
  },
  "expires_at": "2027-04-06T00:00:00Z"
}
```

### Grant fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `version` | string | yes | Protocol version. |
| `grant_id` | string | yes | Unique identifier. |
| `issued_at` | ISO 8601 | yes | When the grant was issued. |
| `subject` | object | yes | The user. At minimum `{ id }`. |
| `client` | object | yes | The client. At minimum `{ client_id }`. |
| `connector_id` | URI | yes | Fully qualified connector identifier. |
| `manifest_version` | string | yes | Connector manifest version this grant was validated against. |
| `purpose_code` | URI | yes | Machine-readable purpose (see Appendix A). |
| `purpose_description` | string | no | Human-readable purpose. |
| `access_mode` | enum | yes | `single_use` or `continuous`. |
| `streams` | StreamGrant[] | yes | Granted streams. Always expanded; no wildcards. |
| `profile` | string | no | Which manifest profile was used (informational). |
| `retention` | object | no | Policy commitment by the data recipient (see below). |
| `expires_at` | ISO 8601 or null | no | Grant expiry. null means no expiry. |

### Three time-related concepts

The grant carries three orthogonal time-related concepts that must not be conflated:

| Concept | Fields | Meaning |
|---------|--------|---------|
| Grant validity period | `issued_at`, `expires_at` | How long the authorization itself is active. |
| Data temporal scope | `streams[].time_range` | Which records the client is authorized to see, filtered by time. |
| Access pattern | `access_mode` | Whether the grant can be exercised once or continuously. |

A grant can be short-lived (expires in 1 hour) but cover all historical data (no `time_range`). A grant can be long-lived but cover only data from the last 6 months (`time_range.since`). A grant can be `single_use` but cover a large historical window. These combinations are all valid and distinct.

### Access modes

| Mode | Behavior |
|------|----------|
| `single_use` | The grant is fulfilled once. The resource server serves currently stored records matching the grant's constraints. The runtime does not persist STATE from single_use collection runs. |
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
| `on_expiry` | enum | `delete`, `anonymize`, or `archive`. |

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
  "time_range": {
    "since": "2025-09-28T00:00:00Z"
  }
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
{
  "name": "messages"
}
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

---

## 7. Connector Manifest

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
{
  "name": "saved_tracks"
}
      ]
    }
  ],
  "streams": [
    {
      "name": "top_artists",
      "description": "Most-listened artists over time",
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
        "time_range": true,
        "fields": true,
        "resources": false
      }
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
        "time_range": true,
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
| `streams[].semantics` | `append_only` or `mutable_state`. |
| `streams[].schema` | JSON Schema for the record's `data` field. `primary_key` and `cursor_field` must reference fields declared here. |
| `streams[].primary_key` | Fields that uniquely identify a record within the stream. |
| `streams[].cursor_field` | Field used for incremental sync ordering (Collection Profile). |
| `streams[].consent_time_field` | The temporal consent boundary: the field against which `time_range` is evaluated. No default; if absent, `time_range` is not applicable to this stream. Must reference a field declared in the schema. |
| `streams[].selection` | Which selection parameters this stream supports (`time_range`, `fields`, `resources`). The authorization server MUST reject grants that request an unsupported selection parameter. |
| `streams[].relationships` | Declared foreign key relationships to other streams. Used for expansion in the query API. |

### consent_time_field

The `consent_time_field` is the field on each record that the resource server evaluates `time_range` against. It represents the stream's temporal consent boundary: when the user consents to "data from the last 6 months," the `consent_time_field` is the field that determines whether a given record falls within that window.

The `consent_time_field` may be the same field as `cursor_field`, but they serve different purposes and must be declared separately:

- `cursor_field` governs incremental sync mechanics (which records to fetch since the last run).
- `consent_time_field` governs consent-time filtering (which records fall within the authorized time window).

For many `append_only` streams, both fields will be the same (e.g., `played_at` for play events). For some `mutable_state` streams they may differ: a playlists stream might use `source_updated_at` as the cursor (for efficient incremental sync) but `source_created_at` as the `consent_time_field` (because the user's consent to "playlists from the last 6 months" most naturally means playlists they created in that period, not playlists they edited).

The `consent_time_field` must be rendered in human-readable consent UX. A grant with `time_range: { since: "2026-01-01" }` on the `playlists` stream should be presented as "playlists created on or after January 1, 2026," not just "playlists in time_range."

Streams that cannot define a stable `consent_time_field` declare `"time_range": false` in their `selection` object. This is acceptable; not every stream needs to support time-bounded disclosure.

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

### Views

Views are named field projections that the authorization server may define for a stream, composed from fields declared in the stream schema. Views are the unit of consent when a client requests access by view name rather than by explicit field list.

Views are monotonically additive: fields may be added to a view over time, but fields may never be removed. Removing a field from a view is a breaking change requiring a new view name. This ensures that consent granted to a view name does not silently narrow over time.

Connector authors MAY suggest views in their manifest as a convenience. The authorization server may adopt these suggestions as-is or define its own views. If no views are defined, the default view for each stream is all fields.

```json
{
  "name": "top_artists",
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
}
```

**Note:** Canonical view naming conventions (standard view names with consistent semantics across connectors) are intentionally deferred. The protocol reserves this space; naming conventions will be informed by implementation experience.

### Versioning

Grants store `manifest_version`. The authorization server validates grants against the manifest at creation time.

- **Additive changes** (new optional fields, new streams, fields added to existing views): compatible. Existing grants continue to work. The new fields are accessible under grants that authorize the relevant view or that use no field filter.
- **Breaking changes** (removed fields, changed types, removed streams, fields removed from a view): require a new grant (re-consent).

The recommended evolution path: add new fields freely; never remove existing fields; create a new stream version (e.g., `playlists_v2`) if a breaking change is unavoidable.

---

## 8. Resource Server Interface

The resource server stores records and serves them to clients filtered by grants. This section is normative: a compliant resource server must implement this interface for cross-deployment interoperability.

### Grant enforcement

On every request, the resource server:

1. Validates the access token and resolves the associated grant.
2. Checks: is the grant active (not expired or revoked)?
3. Checks: is the requested stream in the grant's `streams` list?
4. Checks: do the request parameters fall within the grant's selection constraints (`time_range`, `fields`)?
5. If all checks pass, returns records filtered accordingly.
6. If any check fails, returns a structured error (see Errors below).

The resource server computes `effective_filter = grant_filter AND request_filter`. Request filters can only narrow what the grant allows; they cannot widen it.

### Authentication

Two authentication boundaries:

**Owner operations** (ingest, state management, grant administration): `Authorization: Bearer <owner_token>`. Owner tokens bypass grant enforcement. How the owner obtains this token is out of scope: device code flow, API key, or any other mechanism. The resource server MUST require owner authentication for these operations.

**Client operations** (query records, list streams, fetch blobs): `Authorization: Bearer <access_token>`. Access tokens are bound to a specific grant. Both token types use RFC 6750 Bearer Token format on the wire. Owner and client tokens MUST be distinguishable by the resource server.

### Endpoints

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

#### Get stream metadata

```
GET /v1/streams/{stream}
Authorization: Bearer <access_token>
```

Returns schema, primary key, cursor field, and expandable relations for a stream.

#### List records

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
| `fields` | comma-separated | Sparse fieldset. Schema-required fields are always included. |
| `expand[]` | string | Expand a declared foreign key relation inline. |
| `expand_limit[{relation}]` | integer | Max records per expanded relation. Default 10, max 50. |
| `changes_since` | string | Opaque cursor token from a previous response. Returns only records changed since that cursor (for `mutable_state` streams). Returns HTTP 410 Gone if the cursor has expired. |

**Stable sort:** Records are sorted by `(cursor_field, primary_key)` for cursor safety.

**Incremental sync for mutable streams:** Pass `changes_since` to retrieve only records changed since a previous sync. The resource server returns changed records within the grant's authorized field projection. If a record was deleted, a tombstone entry is included. If the cursor has expired (HTTP 410), the client must perform a full re-sync.

**Response:**
```json
{
  "object": "list",
  "url": "/v1/streams/conversations/records",
  "has_more": true,
  "next_cursor": "eyJjcmVhdGVkX2F0IjoiMjAyNi0wMy0yNVQxODoyMjoxMVoiLCJpZCI6ImNvbnZfMDFKUVc4TTJSNyJ9",
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

#### Get a single record

```
GET /v1/streams/{stream}/records/{id}
Authorization: Bearer <access_token>
```

Returns a single record by primary key. Supports `expand[]`.

#### Get a blob

```
GET /v1/blobs/{blob_id}
Authorization: Bearer <access_token>
```

Returns raw binary data. The resource server authorizes blob access by verifying that:

1. The grant includes a stream containing a record that references this `blob_id`.
2. The referencing record passes all grant filters.
3. The `blob_ref` field is included in the grant's authorized field projection.

A `blob_id` alone does not grant access. The client must have discovered the blob through an authorized record.

The server MAY return HTTP 302 to a short-lived signed URL. `HEAD` is supported for size checks. `Range` headers are recommended for large files.

#### Ingest records (owner-authenticated)

```
POST /v1/ingest/{stream}
Authorization: Bearer <owner_token>
Content-Type: application/x-ndjson
```

Body is NDJSON (one RECORD envelope per line). Used by the connector runtime. Response:

```json
{
  "stream": "conversations",
  "records_accepted": 2,
  "records_rejected": 0
}
```

#### Sync state (owner-authenticated)

```
GET  /v1/state/{connector_id}
PUT  /v1/state/{connector_id}
Authorization: Bearer <owner_token>
```

Returns and updates the StreamState map for incremental sync (see Collection Profile).

### Errors

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

| Type | HTTP Status | When |
|------|------------|------|
| `invalid_request_error` | 400 | Malformed request, invalid cursor, unknown field. |
| `authentication_error` | 401 | Missing or invalid access token. |
| `permission_error` | 403 | Grant violation: stream not allowed, time range exceeded, grant expired or revoked. |
| `not_found_error` | 404 | Stream or record not found. |
| `gone_error` | 410 | Incremental sync cursor has expired; full re-sync required. |
| `rate_limit_error` | 429 | Too many requests. Includes `Retry-After` header. |
| `api_error` | 500 | Internal server error. |

| Code | Type | Description |
|------|------|-------------|
| `invalid_cursor` | invalid_request | Cursor token is malformed or unrecognized. |
| `cursor_expired` | gone | `changes_since` cursor is too old; re-sync required. |
| `unknown_field` | invalid_request | Requested field not in stream schema. |
| `unknown_expand` | invalid_request | Relation is not expandable. |
| `grant_stream_not_allowed` | permission | Stream not in grant. |
| `grant_time_range_exceeded` | permission | Request filters exceed grant's `time_range`. |
| `grant_expired` | permission | Grant has expired. |
| `grant_revoked` | permission | Grant has been revoked. |

### API versioning

Date-based, via header:

```
PDPP-Version: 2026-04-06
```

Every response includes a `Request-Id` header for debugging.

### Concurrent collection

Multiple collection runs for the same connector may execute concurrently. The resource server handles this through idempotent writes:

- Records are upserted by primary key. A record written twice with the same key and data is idempotent.
- Cursor state is accepted only if it advances the cursor (max of current and incoming). A slower run cannot regress the cursor.

---

## 9. Conformance

This section defines what it means to implement each PDPP role. Conformance claims should reference this section.

### Authorization Server conformance

A conformant authorization server:

1. Accepts selection requests using the RFC 9396 `authorization_details` envelope with `type: "https://pdpp.org/data-access"`.
2. Validates selection requests against the connector manifest: rejects unknown streams, unsupported selection parameters (e.g., `time_range` on a stream without `consent_time_field`), and unrecognized profiles.
3. Issues grants that conform to the grant schema defined in Section 6. All fields in the grant are derived from the selection request, client registration, or authorization server policy.
4. Expands wildcards (`"name": "*"`) and profiles into explicit stream lists before issuing the grant.
5. Tracks grant lifecycle (active, expired, revoked) and makes this status available to resource servers.
6. Issues access tokens bound to specific grants.

### Resource Server conformance

A conformant resource server:

1. Implements all endpoints defined in Section 8.
2. Enforces grant constraints on every client request: stream membership, `time_range`, `fields` allowlist.
3. Computes effective filters as `grant_filter AND request_filter`. Client filters cannot widen grant constraints.
4. Returns structured errors as defined in Section 8.
5. Accepts record ingestion from the connector runtime using owner authentication.
6. Maintains sync state for connectors.
7. Supports incremental sync via `changes_since` for `mutable_state` streams, including tombstone entries for deleted records and HTTP 410 on cursor expiry.

### Connector conformance

Connector conformance is defined in the [PDPP Collection Profile](spec-collection-profile).

### Client conformance

A conformant client:

1. Submits selection requests using the RFC 9396 `authorization_details` envelope.
2. Uses access tokens (not raw grants) to authenticate with the resource server.
3. Treats cursor tokens as opaque; does not parse or construct them.
4. Respects HTTP 410 responses by performing a full re-sync rather than retrying with the expired cursor.
5. Honors retention commitments declared in the grant.

---

## 10. Security and Privacy Considerations

### Token security

PDPP defines two token classes at the resource server boundary (see Section 8). Token format (opaque string, JWT, etc.) is an implementation choice. Both use RFC 6750 Bearer Token format on the wire. Implementations SHOULD use short-lived access tokens with refresh tokens for `continuous` grants.

### Grant integrity

The grant is designed to be signable. The `subject` and `client` fields support future JWS/JWT signatures. Implementations MUST treat grants as tamper-sensitive. Grant signing and a formal token format are deferred to a future version; the current design is compatible with adding them without breaking changes.

Large `authorization_details` payloads may exceed URL length limits. Production deployments SHOULD use Pushed Authorization Requests (PAR, RFC 9126).

### Credential handling

INTERACTION_RESPONSE messages in the Collection Profile may contain passwords and OTP codes. Runtimes MUST NOT log or persist credential data. See the [PDPP Collection Profile](spec-collection-profile) for details.

### Connector trust

In the Collection Profile, connectors receive credentials via the INTERACTION channel. A malicious connector could exfiltrate credentials. Production deployments SHOULD mitigate this by sandboxing connector processes (restricting network egress), using connectors from trusted registries only, or having the runtime authenticate on behalf of the connector and pass only session tokens. A formal connector trust model is deferred.

### Data minimization

Stream-level and field-level selection implements the GDPR principle of data minimization. Clients SHOULD request only the data they need for their stated purpose. Authorization servers SHOULD display the specific fields and streams being requested during consent.

### Purpose limitation

The `purpose_code` URI enables purpose-based access control and audit. Authorization servers MAY restrict client registrations to specific purpose codes. Personal servers SHOULD log purpose codes for auditability.

### Retention

The `retention` field is a policy commitment by the data recipient. PDPP does not technically enforce retention. Enforcement is through legal agreements, contractual obligations, or trust registry mechanisms. This is an intentional design choice, consistent with how OAuth 2.0 treats scope compliance.

### Revocation

If a grant is revoked, the resource server MUST return `grant_revoked` errors immediately. If a collection run is in progress when a grant is revoked, the runtime SHOULD terminate the connector. A formal CANCEL message for in-progress runs is deferred.

---

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
- Conformance definitions for all roles

### Out of scope (v0.1)

| Concern | Status |
|---------|--------|
| Authorization server interface | Informational only; see Session Relay Profile |
| Webhook / push ingestion | Deferred; see spec-deferred |
| Source lifecycle actions | Deferred (e.g., deleting source data after export); see spec-deferred |
| Event-driven collection triggers | Deferred; architecturally distinct from the pull-based Collection Profile |
| Grant signing and token format | Deferred; current design is compatible |
| Trust registry and connector certification | Deferred |
| Consent screen UX | Surface-specific; out of scope |
| Point-in-time reconstruction | Deferred (reconstructing full state at a past timestamp) |
| Canonical view naming vocabulary | Deferred; will be informed by implementation experience |
| Real-time streaming | Different spec needed |

---

## 12. TypeScript Types

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
  fields?: string[];
  resources?: string[];
}

// --- Grant (post-consent, immutable) ---

interface StreamGrant {
  name: string;
  time_range?: TimeRange;
  fields?: string[];
  resources?: string[];
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
    on_expiry: 'delete' | 'anonymize' | 'archive';
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
  cursor_field?: string;
  consent_time_field?: string;  // Absent means time_range not supported for this stream
  incremental?: boolean;
  selection: {
    time_range: boolean;
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
```

---

## Appendix A: Purpose Code Registry

Purpose codes are URIs. The following codes are defined by PDPP. Implementers may define additional codes using their own URI namespaces.

| Code | Description |
|------|-------------|
| `https://pdpp.org/purpose/personalization` | Tailoring the application experience to the user. |
| `https://pdpp.org/purpose/analytics` | Analyzing user data to produce insights for the user. |
| `https://pdpp.org/purpose/export` | Exporting data for the user's own use. |
| `https://pdpp.org/purpose/agent_context` | Providing context to a personal AI agent. |
| `https://pdpp.org/purpose/ai_training` | Using data to train AI models. Requires explicit user consent. |
| `https://pdpp.org/purpose/research` | Academic or market research. |

---

## Appendix B: Relationship to the Data Transfer Project (DTI)

PDPP and DTI address complementary concerns. DTI defines canonical data models and transfer adapters. PDPP defines parameterized consent and disclosure semantics.

The two protocols can compose: a PDPP grant can serve as the consent artifact authorizing a DTI transfer. PDPP stream schemas can carry DTI canonical data model payloads. A mapping appendix defining the precise correspondence between PDPP grants and DTI transfer manifests is planned but not yet specified.

Note: "Data Transfer Project" is referred to as DTI (Data Transfer Initiative) in current usage, reflecting its evolution from the original DTP initiative.
