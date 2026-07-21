# PDPP Reference Implementation Examples

Status: Illustrative
Date: 2026-04-11

These examples are illustrative sequences built from the current draft. They are not the normative source for wire shapes or role responsibilities. When an example and the live draft differ, the normative documents win:

- [spec-core.md](spec-core.md)
- [spec-collection-profile.md](spec-collection-profile.md)

(`spec-data-query-api.md` is superseded; its surviving normative content lives in
[spec-core.md](spec-core.md) — see the authority map in the README.)

Two explicit limits apply in this file:

1. The authorization server HTTP interface is not normatively specified in v0.1, so authorization and token-exchange steps are shown as decoded request/response shapes rather than mandatory AS endpoints.
2. The Collection Profile standardizes the `START` envelope and its portable `scope`, but not every runtime-internal planning detail or execution hint a particular runtime may use around that envelope.

---

## Example 1: `single_use` grant with differentiated consent rendering

A concert recommendation app wants the user's Spotify top artists from the last 6 months. It asks for a one-time grant and includes a supplementary client-authored claim.

### Step 1: Decoded authorization request

This is the logical content carried in the OAuth authorization request. `client_display` is top-level requester identity metadata. The PDPP request lives inside `authorization_details`.

```json
{
  "client_display": {
    "name": "Concerts App",
    "uri": "https://concerts.example.com"
  },
  "authorization_details": [
    {
      "type": "https://pdpp.org/data-access",
      "source": { "kind": "connector", "id": "https://registry.pdpp.org/connectors/spotify" },
      "purpose_code": "https://pdpp.org/purpose/personalization",
      "purpose_description": "Recommend concerts based on your listening history",
      "access_mode": "single_use",
      "retention": {
        "max_duration": "P90D",
        "on_expiry": "delete"
      },
      "client_claims": {
        "commitments": [
          "We never publish your listening history."
        ]
      },
      "streams": [
        {
          "name": "top_artists",
          "necessity": "required",
          "time_range": {
            "since": "2025-10-11T00:00:00Z"
          },
          "fields": [
            "id",
            "name",
            "genres",
            "popularity",
            "source_updated_at"
          ]
        }
      ]
    }
  ]
}
```

### Step 2: Consent rendering

The authorization server preserves the semantic distinctions required by the draft.

> **Requester**
> Concerts App
>
> **Data Access**
> Spotify: top artists
> Artists updated on or after October 11, 2025
> Fields: name, genres, popularity
> Access mode: one-time access
>
> **Policy Declarations**
> Purpose: Recommend concerts based on your listening history
> Retention: Delete within 90 days
>
> **Concerts App says**
> "We never publish your listening history."
>
> [Allow] [Deny]

The manifest-authored data description and the structured grant terms are rendered authoritatively. The free-text commitment is attributed to the client and not flattened into the same register.

### Step 3: Issued grant

The AS validates the request against the connector manifest and issues an immutable grant.

```json
{
  "version": "0.1.0",
  "grant_id": "grt_concerts_001",
  "issued_at": "2026-04-11T15:00:00Z",
  "subject": { "id": "user_abc" },
  "client": { "client_id": "concerts_app" },
  "source": { "kind": "connector", "id": "https://registry.pdpp.org/connectors/spotify" },
  "manifest_version": "2.0.0",
  "purpose_code": "https://pdpp.org/purpose/personalization",
  "purpose_description": "Recommend concerts based on your listening history",
  "access_mode": "single_use",
  "streams": [
    {
      "name": "top_artists",
      "fields": [
        "id",
        "name",
        "genres",
        "popularity",
        "source_updated_at"
      ],
      "time_range": {
        "since": "2025-10-11T00:00:00Z"
      }
    }
  ],
  "retention": {
    "max_duration": "P90D",
    "on_expiry": "delete"
  },
  "expires_at": "2026-04-11T16:00:00Z"
}
```

`single_use` is consumed when the AS issues the first client access token for this grant, not when the RS serves the first page.

### Step 4: App queries records

```http
GET /v1/streams/top_artists/records?limit=50
Authorization: Bearer pdpp_client_tok_001
PDPP-Version: 2026-04-06
```

```json
{
  "object": "list",
  "url": "/v1/streams/top_artists/records",
  "has_more": false,
  "freshness": {
    "captured_at": "2026-04-11T14:58:00Z",
    "status": "current",
    "last_attempted_at": "2026-04-11T14:58:00Z"
  },
  "data": [
    {
      "object": "record",
      "id": "4Z8W4fKeB5",
      "stream": "top_artists",
      "data": {
        "id": "4Z8W4fKeB5",
        "name": "Radiohead",
        "genres": ["alternative rock"],
        "popularity": 82,
        "source_updated_at": "2026-04-10T23:15:00Z"
      },
      "emitted_at": "2026-04-11T14:58:00Z"
    }
  ]
}
```

`freshness` is response metadata. It tells the client what the server knows about recency. It is not itself a grant term.

### Step 5: Later attempt to mint another client token

Because this is a `single_use` grant, any later attempt to obtain a new client access token for `grt_concerts_001` is rejected by the AS. The original token may still be used for retries or pagination until token expiry or revocation.

---

## Example 2: `continuous` grant with grant-scoped collection state and incremental sync

A personal AI agent wants ongoing access to the user's ChatGPT data.

### Step 1: Decoded authorization request

```json
{
  "client_display": {
    "name": "My Agent"
  },
  "authorization_details": [
    {
      "type": "https://pdpp.org/data-access",
      "source": { "kind": "connector", "id": "https://registry.pdpp.org/connectors/chatgpt" },
      "purpose_code": "https://pdpp.org/purpose/agent_context",
      "purpose_description": "Provide context to your personal AI agent",
      "access_mode": "continuous",
      "streams": [
        { "name": "*" }
      ]
    }
  ]
}
```

### Step 2: Issued grant with wildcard expansion

```json
{
  "version": "0.1.0",
  "grant_id": "grt_agent_001",
  "issued_at": "2026-04-11T15:10:00Z",
  "subject": { "id": "user_abc" },
  "client": { "client_id": "my_agent" },
  "source": { "kind": "connector", "id": "https://registry.pdpp.org/connectors/chatgpt" },
  "manifest_version": "2.0.0",
  "purpose_code": "https://pdpp.org/purpose/agent_context",
  "purpose_description": "Provide context to your personal AI agent",
  "access_mode": "continuous",
  "streams": [
    { "name": "conversations" },
    { "name": "messages" },
    { "name": "memories" }
  ],
  "expires_at": null
}
```

The wildcard is expanded at consent time and frozen in the grant. Future stream types added by later manifest versions are not silently included.

### Step 3: Runtime loads grant-scoped state

The Collection Profile runtime uses a `grant_id`-scoped state namespace for a `continuous` run.

```http
GET /v1/state/https%3A%2F%2Fregistry.pdpp.org%2Fconnectors%2Fchatgpt?grant_id=grt_agent_001
Authorization: Bearer pdpp_owner_tok_001
```

```json
{
  "object": "stream_state",
  "connector_id": "https://registry.pdpp.org/connectors/chatgpt",
  "grant_id": "grt_agent_001",
  "state": {
    "conversations": { "updated_at": "2026-04-10T20:00:00Z" },
    "messages": { "created_at": "2026-04-10T20:05:00Z" },
    "memories": { "created_at": "2026-04-01T09:00:00Z" }
  },
  "updated_at": "2026-04-10T20:05:10Z"
}
```

### Step 4: Runtime starts the connector

The standardized `START` envelope does not carry the raw grant. It carries a portable collection `scope` that is a normalized, non-broadening projection of the grant, optionally narrowed further by local policy. Any additional runtime-internal planning data stays outside the portable wire contract.

```json
{
  "type": "START",
  "run_id": "run_agent_002",
  "collection_mode": "incremental",
  "scope": {
    "streams": [
      { "name": "conversations" },
      { "name": "messages" },
      { "name": "memories" }
    ]
  },
  "state": {
    "conversations": { "updated_at": "2026-04-10T20:00:00Z" },
    "messages": { "created_at": "2026-04-10T20:05:00Z" },
    "memories": { "created_at": "2026-04-01T09:00:00Z" }
  },
  "bindings": {
    "browser_automation": {
      "interface": "cdp",
      "ws_url": "ws://127.0.0.1:39011/devtools/browser/abc"
    },
    "network": {}
  }
}
```

### Step 5: Connector emits updates

```json
{
  "type": "RECORD",
  "stream": "conversations",
  "key": "conv_003",
  "data": {
    "id": "conv_003",
    "title": "New conversation",
    "source_updated_at": "2026-04-11T08:00:00Z"
  },
  "emitted_at": "2026-04-11T15:12:00Z"
}
{
  "type": "RECORD",
  "stream": "messages",
  "key": "msg_050",
  "data": {
    "id": "msg_050",
    "conversation_id": "conv_003",
    "role": "user",
    "content": "What's the weather?",
    "source_created_at": "2026-04-11T08:00:01Z"
  },
  "emitted_at": "2026-04-11T15:12:01Z"
}
{
  "type": "STATE",
  "stream": "conversations",
  "cursor": {
    "updated_at": "2026-04-11T08:00:00Z"
  }
}
{
  "type": "STATE",
  "stream": "messages",
  "cursor": {
    "created_at": "2026-04-11T08:00:01Z"
  }
}
{
  "type": "DONE",
  "status": "succeeded",
  "records_emitted": 2
}
```

### Step 6: Runtime persists updated grant-scoped state

```http
PUT /v1/state/https%3A%2F%2Fregistry.pdpp.org%2Fconnectors%2Fchatgpt?grant_id=grt_agent_001
Authorization: Bearer pdpp_owner_tok_001
Content-Type: application/json
```

```json
{
  "state": {
    "conversations": { "updated_at": "2026-04-11T08:00:00Z" },
    "messages": { "created_at": "2026-04-11T08:00:01Z" },
    "memories": { "created_at": "2026-04-01T09:00:00Z" }
  }
}
```

### Step 7: Client runs incremental disclosure with `changes_since`

The client has previously stored a `next_changes_since` token from an earlier successful session.

```http
GET /v1/streams/conversations/records?changes_since=chg_eyJwcmV2IjoiMjAyNi0wNC0xMFQyMDowNToxMFoifQ
Authorization: Bearer pdpp_client_tok_agent_001
PDPP-Version: 2026-04-06
```

```json
{
  "object": "list",
  "url": "/v1/streams/conversations/records",
  "has_more": false,
  "next_changes_since": "chg_eyJuZXh0IjoiMjAyNi0wNC0xMVQxNToxMjowMVoifQ",
  "freshness": {
    "captured_at": "2026-04-11T15:12:01Z",
    "status": "current",
    "last_attempted_at": "2026-04-11T15:12:01Z"
  },
  "data": [
    {
      "object": "record",
      "id": "conv_003",
      "stream": "conversations",
      "data": {
        "id": "conv_003",
        "title": "New conversation",
        "source_updated_at": "2026-04-11T08:00:00Z"
      },
      "emitted_at": "2026-04-11T15:12:00Z"
    }
  ]
}
```

If only hidden fields had changed on a granted record, that record would not appear. `changes_since` eligibility is computed on the authorized projection, not on the full stored record.

If this session had multiple pages, the follow-on `next_cursor` pages would stay anchored to the same session window as the first page. New writes arriving after page 1 would wait for the next sync session seeded from the terminal-page `next_changes_since`.

---

## Example 3: Retention and revocation are not deletion

A sleep analysis app receives a one-time grant with a retention declaration.

### Step 1: Issued grant

```json
{
  "version": "0.1.0",
  "grant_id": "grt_sleep_001",
  "issued_at": "2026-04-11T15:20:00Z",
  "subject": { "id": "user_abc" },
  "client": { "client_id": "sleep_app" },
  "source": { "kind": "connector", "id": "https://registry.pdpp.org/connectors/oura" },
  "manifest_version": "1.0.0",
  "purpose_code": "https://pdpp.org/purpose/analytics",
  "purpose_description": "Analyze your sleep patterns",
  "access_mode": "single_use",
  "streams": [
    {
      "name": "sleep_sessions",
      "time_range": {
        "since": "2026-03-12T00:00:00Z",
        "until": "2026-04-11T00:00:00Z"
      },
      "fields": [
        "day",
        "total_sleep_duration",
        "sleep_score",
        "deep_sleep_duration"
      ]
    }
  ],
  "retention": {
    "max_duration": "P90D",
    "on_expiry": "delete"
  }
}
```

`retention` is a structured policy declaration and policy commitment by the recipient. It is not a DRM mechanism and it is not technically enforced by the RS.

### Step 2: User later revokes the grant

The AS marks the grant inactive. Further client access stops after revocation propagates through introspection.

### Step 3: Further disclosure attempts fail

```http
GET /v1/streams/sleep_sessions/records
Authorization: Bearer pdpp_client_tok_sleep_001
PDPP-Version: 2026-04-06
```

```json
{
  "error": {
    "type": "permission_error",
    "code": "grant_revoked",
    "message": "Grant has been revoked.",
    "request_id": "req_01JREVOCATION"
  }
}
```

### Step 4: What revocation does and does not mean

- Future disclosure stops.
- Data already delivered to the client remains governed by the grant's retention commitment and any applicable legal obligations.
- Revocation is not deletion.
- v0.1 does not define an active erasure signal telling the client to delete previously disclosed data immediately.

That separation is intentional: the protocol should not imply downstream deletion when it cannot actually make it happen.
