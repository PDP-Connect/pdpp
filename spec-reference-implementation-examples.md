# PDPP Reference Implementation Examples

Status: Illustrative
Date: 2026-10-13

These examples are illustrative sequences built from the current draft. They are not the normative source for wire shapes or role responsibilities. When an example and the live draft differ, the normative documents win:

- [spec-core.md](spec-core.md)
- [spec-collection-profile.md](spec-collection-profile.md)

(`spec-data-query-api.md` is superseded; its surviving normative content lives in [spec-core.md](spec-core.md) — see the authority map in the README.)

Two explicit limits apply in this file:

1. The owner-facing authorization interaction is deployment-specific, so authorization and token-exchange steps are shown as decoded request/response shapes rather than complete OAuth HTTP exchanges. Core specifies the client-visible token result, AS-to-RS introspection, and the grant lifecycle HTTP operation.
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
      "type": "https://pdpp.dev/data-access",
      "source": { "kind": "connector", "id": "https://registry.pdpp.dev/connectors/spotify" },
      "purpose_code": "https://pdpp.dev/purpose/personalization",
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

The authorization server preserves the semantic distinctions required by the draft. This excerpt shows only those distinctions. Final owner review also shows the grant expiry, the selected account, the envelope identifiers that every record discloses, and what happens to held data after the grant ends, as Core Sections 4 and 6 require.

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

The declaration-authored data description and the structured grant terms are rendered authoritatively. The free-text commitment is attributed to the client and not flattened into the same register.

### Step 3: Issued grant

The AS validates the request against the retained source declaration, whose `top_artists` schema requires `id` and `name`, and issues an immutable grant.

```json
{
  "version": "0.1.0",
  "grant_id": "grt_concerts_001",
  "issued_at": "2026-04-11T15:00:00Z",
  "subject": { "id": "sub_H7mQ2vKa" },
  "client": { "client_id": "concerts_app" },
  "source": { "kind": "connector", "id": "https://registry.pdpp.dev/connectors/spotify" },
  "source_declaration": { "version": "2.0.0" },
  "purpose_code": "https://pdpp.dev/purpose/personalization",
  "purpose_description": "Recommend concerts based on your listening history",
  "access_mode": "single_use",
  "streams": [
    {
      "name": "top_artists",
      "instance_ids": ["inst_Rb3kT9wE"],
      "fields": [
        "id",
        "name",
        "genres",
        "popularity",
        "source_updated_at"
      ],
      "required_fields": ["id", "name"],
      "time_constraint": {
        "field": "source_updated_at",
        "type": "date-time",
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
PDPP-Version: 0.1
```

```json
{
  "object": "list",
  "url": "/v1/streams/top_artists/records",
  "has_more": false,
  "freshness": [
    { "instance_id": "inst_Rb3kT9wE", "last_success_at": "2026-04-11T14:00:00Z" }
  ],
  "data": [
    {
      "object": "record",
      "id": "4Z8W4fKeB5",
      "instance_id": "inst_Rb3kT9wE",
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

`freshness` is response metadata. It has one entry for each instance that the grant lists for the stream, and it tells the client when the server last succeeded in collecting data relevant to the grant. It is not itself a grant term.

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
      "type": "https://pdpp.dev/data-access",
      "source": { "kind": "connector", "id": "https://registry.pdpp.dev/connectors/chatgpt" },
      "purpose_code": "https://pdpp.dev/purpose/agent_context",
      "purpose_description": "Provide context to your personal AI agent",
      "access_mode": "continuous",
      "streams": [
        { "name": "*", "fields": ["*"] }
      ]
    }
  ]
}
```

### Step 2: Issued grant with wildcard expansion

For this example, the retained source declaration revision is 2.0.0, and the owner approves one ChatGPT instance, exposed to this client as `inst_Jm6pX2cV`. The `conversations` schema has `id`, `title`, and `source_updated_at`; `messages` has `id`, `conversation_id`, `role`, `content`, and `source_created_at`; `memories` has `id`, `content`, and `source_created_at`. Each schema's root `required` array lists only `id`. The AS resolves the `*` markers to these explicit lists and freezes each required set as `required_fields`.

```json
{
  "version": "0.1.0",
  "grant_id": "grt_agent_001",
  "issued_at": "2026-04-11T15:10:00Z",
  "subject": { "id": "sub_N9rT4xWp" },
  "client": { "client_id": "my_agent" },
  "source": { "kind": "connector", "id": "https://registry.pdpp.dev/connectors/chatgpt" },
  "source_declaration": { "version": "2.0.0" },
  "purpose_code": "https://pdpp.dev/purpose/agent_context",
  "purpose_description": "Provide context to your personal AI agent",
  "access_mode": "continuous",
  "streams": [
    { "name": "conversations", "instance_ids": ["inst_Jm6pX2cV"], "fields": ["id", "title", "source_updated_at"], "required_fields": ["id"] },
    { "name": "messages", "instance_ids": ["inst_Jm6pX2cV"], "fields": ["id", "conversation_id", "role", "content", "source_created_at"], "required_fields": ["id"] },
    { "name": "memories", "instance_ids": ["inst_Jm6pX2cV"], "fields": ["id", "content", "source_created_at"], "required_fields": ["id"] }
  ]
}
```

The wildcard is expanded at consent time and frozen in the grant. Future stream types added by later source declaration revisions are not silently included.

### Step 3: Runtime loads grant-scoped state

The Collection Profile runtime uses a `grant_id`-scoped state namespace for a `continuous` run.

```http
GET /v1/state/https%3A%2F%2Fregistry.pdpp.dev%2Fconnectors%2Fchatgpt?grant_id=grt_agent_001
Authorization: Bearer pdpp_owner_tok_001
```

```json
{
  "object": "stream_state",
  "connector_id": "https://registry.pdpp.dev/connectors/chatgpt",
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
PUT /v1/state/https%3A%2F%2Fregistry.pdpp.dev%2Fconnectors%2Fchatgpt?grant_id=grt_agent_001
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
GET /v1/streams/conversations/records?changes_since=cs_Hq4mZ8tWc1Lr6VxN0bYk3PjD9fGs2Ae7
Authorization: Bearer pdpp_client_tok_agent_001
PDPP-Version: 0.1
```

```json
{
  "object": "list",
  "url": "/v1/streams/conversations/records",
  "has_more": false,
  "next_changes_since": "cs_T2wPd7Kx5NqB0mRz9LyVc4HgJ1sFa8Eu",
  "freshness": [
    { "instance_id": "inst_Jm6pX2cV", "last_success_at": "2026-04-11T14:00:00Z" }
  ],
  "data": [
    {
      "object": "record",
      "id": "conv_003",
      "instance_id": "inst_Jm6pX2cV",
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

## Example 3: Retention, revocation, and erasure

A sleep analysis app receives a one-time grant with a retention declaration. The retained `sleep_sessions` schema requires `day`.

### Step 1: Issued grant

```json
{
  "version": "0.1.0",
  "grant_id": "grt_sleep_001",
  "issued_at": "2026-04-11T15:20:00Z",
  "subject": { "id": "sub_B6jL8sYe" },
  "client": { "client_id": "sleep_app" },
  "source": { "kind": "connector", "id": "https://registry.pdpp.dev/connectors/oura" },
  "source_declaration": { "version": "2026-04-01" },
  "purpose_code": "https://pdpp.dev/purpose/analytics",
  "purpose_description": "Analyze your sleep patterns",
  "access_mode": "single_use",
  "streams": [
    {
      "name": "sleep_sessions",
      "instance_ids": ["inst_R7mT2qVx"],
      "time_constraint": {
        "field": "day",
        "type": "date",
        "since": "2026-03-12",
        "until": "2026-04-11"
      },
      "fields": [
        "day",
        "total_sleep_duration",
        "sleep_score",
        "deep_sleep_duration"
      ],
      "required_fields": ["day"]
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

The AS asks the user to choose `keep` or `delete` for the data the app already holds, with neither option preselected. It then marks the grant revoked and records the choice. Further client access stops after revocation propagates through introspection.

### Step 3: Further disclosure attempts fail

```http
GET /v1/streams/sleep_sessions/records
Authorization: Bearer pdpp_client_tok_sleep_001
PDPP-Version: 0.1
```

The token is inactive, and authenticated RS context establishes that its grant was revoked. The response is HTTP 401 with `WWW-Authenticate: Bearer error="invalid_token"`. If the cause were not established, the structured code would be `authentication_error`.

```json
{
  "error": {
    "type": "authentication_error",
    "code": "grant_revoked",
    "message": "Grant has been revoked.",
    "request_id": "req_01JREVOCATION"
  }
}
```

### Step 4: What revocation does and does not mean

- Future disclosure stops.
- Revocation alone does not request deletion. The user's disposition decides what happens to data already delivered.
- With `keep`, the app may go on using that data for the approved purpose until each record's 90-day retention ceiling, counted from when the app first received the record.
- With `delete`, the AS records an erasure instruction. The app stops using the data and deletes it, with its derivatives and its processors' copies, within the limits of Core Section 7.
- The app stops using this access token and starts a Core grant lifecycle query before further use of the data. The failed read is not a lifecycle answer. While it holds the data, it also queries at least daily, and retries a failed query as Core Section 7 requires.
- If the app cannot reach the AS, it keeps the data and retries. It cannot learn of a `delete` made at the AS until the AS answers again. A `delete` chosen inside the app binds at once, and the retention ceiling still applies.

Core makes deletion an executable client duty. The stop-use bound runs from the instruction's effective time, and an app that learns later stops at once. The deletion bound runs from the app's first receipt. Core defines no proof of deletion: a conforming app's records make a breach attributable, not impossible.
