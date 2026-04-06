# PDPP End-to-End Examples

These examples show the full sequence of interactions for each primary use case. Every HTTP request, protocol message, and response is shown in order.

---

## Example 1: App requests specific data (concert recommendation app)

The app needs the user's top 50 Spotify artists from the last 6 months.

### Step 1: App initiates authorization

The app redirects the user to the authorization server with a selection request.

```http
GET /authorize?response_type=code&client_id=concert_app&redirect_uri=https://concerts.example.com/callback&scope=openid&authorization_details=%5B%7B%22type%22%3A%22https%3A%2F%2Fvana.com%2Fprotocol%2Fdata-access%22%2C%22connector_id%22%3A%22https%3A%2F%2Fregistry.vana.org%2Fconnectors%2Fspotify%22%2C%22purpose_code%22%3A%22personalization%22%2C%22sync_mode%22%3A%22one_time%22%2C%22purpose_description%22%3A%22Recommend%20concerts%20based%20on%20your%20listening%20history%22%2C%22streams%22%3A%5B%7B%22name%22%3A%22top_artists%22%2C%22necessity%22%3A%22required%22%2C%22time_range%22%3A%7B%22since%22%3A%222025-09-28T00%3A00%3A00Z%22%7D%7D%5D%7D%5D
```

Decoded `authorization_details`:
```json
[{
  "type": "https://vana.com/protocol/data-access",
  "connector_id": "https://registry.vana.org/connectors/spotify",
  "purpose_code": "personalization",
  "purpose_description": "Recommend concerts based on your listening history",
  "streams": [
    { "name": "top_artists", "necessity": "required", "time_range": { "since": "2025-09-28T00:00:00Z" } }
  ]
}]
```

### Step 2: User consents

The authorization server shows the user a consent screen:

> **Concerts App** wants to access your **Spotify** data:
> - **Your top artists** (last 6 months, up to 50) — *required*
>
> Purpose: Recommend concerts based on your listening history
>
> [Allow] [Deny]

The user clicks Allow.

### Step 3: Authorization server issues grant

The authorization server validates the selection request against the Spotify connector manifest, creates a grant, and returns an authorization code to the app.

Grant created:
```json
{
  "version": "0.1.0",
  "grant_id": "grt_8f72a1b3",
  "issued_at": "2026-03-28T15:00:00Z",
  "subject": { "id": "user_abc" },
  "client": { "client_id": "concert_app" },
  "connector_id": "https://registry.vana.org/connectors/spotify",
  "manifest_version": "2.0.0",
  "purpose_code": "personalization",
  "purpose_description": "Recommend concerts based on your listening history",
  "sync_mode": "one_time",
  "streams": [
    { "name": "top_artists", "time_range": { "since": "2025-09-28T00:00:00Z" } }
  ]
}
```

The app exchanges the authorization code for an access token (standard OAuth token exchange).

### Step 4: Resource server checks for data

The app calls the resource server to read data:

```http
GET /v1/streams/top_artists/records?limit=50
Authorization: Bearer pdq_tok_abc123
PDPP-Version: 2026-03-28
```

The resource server resolves the token to grant `grt_8f72a1b3`, checks if it has fresh Spotify `top_artists` data. Two scenarios:

**4a: Data is already collected** (user previously ran `vana collect spotify`).

The resource server returns records immediately, filtered by grant:

```json
{
  "object": "list",
  "url": "/v1/streams/top_artists/records",
  "has_more": false,
  "data": [
    {
      "object": "record",
      "id": "4Z8W4fKeB5",
      "stream": "top_artists",
      "data": { "id": "4Z8W4fKeB5", "name": "Radiohead", "genres": ["alternative rock"], "popularity": 82 },
      "emitted_at": "2026-03-28T15:01:00Z"
    },
    {
      "object": "record",
      "id": "1dfeR4RgS2",
      "stream": "top_artists",
      "data": { "id": "1dfeR4RgS2", "name": "Bjork", "genres": ["art pop", "electronic"], "popularity": 71 },
      "emitted_at": "2026-03-28T15:01:00Z"
    }
  ]
}
```

Done. The app has the data.

**4b: Data needs to be collected** (no Spotify data in the store, or it's stale).

The resource server returns an empty result or triggers a collection. How this is triggered is implementation-specific. One approach: the resource server returns a 202 with a status URL:

```http
HTTP/1.1 202 Accepted
Location: /v1/collections/col_xyz789
```

The app polls the status URL until collection completes, then retries the records request.

### Step 5 (if 4b): Connector runtime collects data

The connector runtime starts the Spotify connector:

**Runtime → Connector (stdin):**

The runtime sends the full grant object. (Abbreviated here for readability; the full grant includes all fields from Step 3.)

```json
{"type": "START", "run_id": "run_001", "grant": {"version": "0.1.0", "grant_id": "grt_8f72a1b3", "issued_at": "2026-03-28T15:00:00Z", "subject": {"id": "user_abc"}, "client": {"client_id": "concert_app"}, "connector_id": "https://registry.vana.org/connectors/spotify", "manifest_version": "2.0.0", "purpose_code": "personalization", "sync_mode": "one_time", "streams": [{"name": "top_artists", "time_range": {"since": "2025-09-28T00:00:00Z"}}]}, "state": null}
```

**Connector → Runtime (stdout):**
```json
{"type": "INTERACTION", "request_id": "req_login", "kind": "credentials", "message": "Log in to Spotify", "schema": {"type": "object", "properties": {"email": {"type": "string"}, "password": {"type": "string", "format": "password"}}, "required": ["email", "password"]}, "timeout_seconds": 300}
```

**Runtime → Connector (stdin):**
```json
{"type": "INTERACTION_RESPONSE", "request_id": "req_login", "status": "success", "data": {"email": "user@example.com", "password": "..."}}
```

**Connector → Runtime (stdout):**
```json
{"type": "PROGRESS", "stream": "top_artists", "message": "Fetching top artists...", "count": 0, "total": 50}
{"type": "RECORD", "stream": "top_artists", "key": "4Z8W4fKeB5", "data": {"id": "4Z8W4fKeB5", "name": "Radiohead", "genres": ["alternative rock"], "popularity": 82, "last_updated": "2026-03-15T00:00:00Z"}, "emitted_at": "2026-03-28T15:01:00Z"}
{"type": "RECORD", "stream": "top_artists", "key": "1dfeR4RgS2", "data": {"id": "1dfeR4RgS2", "name": "Bjork", "genres": ["art pop", "electronic"], "popularity": 71, "last_updated": "2026-03-10T00:00:00Z"}, "emitted_at": "2026-03-28T15:01:01Z"}
```
*(... 48 more RECORD messages ...)*

```json
{"type": "STATE", "stream": "top_artists", "cursor": {"last_updated": "2026-03-28T00:00:00Z"}}
{"type": "DONE", "status": "succeeded", "records_emitted": 50}
```

The runtime writes records to the resource server. The app's next request returns the data (same as step 4a).

---

## Example 2: User grants everything to their AI agent

The user wants their personal AI agent to have access to all their ChatGPT data, kept updated.

### Step 1: Agent initiates authorization

```json
{
  "type": "https://vana.com/protocol/data-access",
  "connector_id": "https://registry.vana.org/connectors/chatgpt",
  "purpose_code": "agent_context",
  "purpose_description": "Provide context to your personal AI agent",
  "sync_mode": "recurring",
  "streams": [{ "name": "*" }]
}
```

### Step 2: User consents

> **My Agent** wants to access your **ChatGPT** data:
> - **All available data** — conversations, messages, memories
>
> This is a recurring grant. The agent will collect updated data periodically.
>
> [Allow] [Deny]

### Step 3: Grant issued (wildcards expanded)

```json
{
  "version": "0.1.0",
  "grant_id": "grt_agent_001",
  "issued_at": "2026-03-28T15:00:00Z",
  "subject": { "id": "user_abc" },
  "client": { "client_id": "my_agent" },
  "connector_id": "https://registry.vana.org/connectors/chatgpt",
  "manifest_version": "2.0.0",
  "purpose_code": "agent_context",
  "sync_mode": "recurring",
  "streams": [
    { "name": "conversations" },
    { "name": "messages" },
    { "name": "memories" }
  ],
  "expires_at": null
}
```

Note: `"*"` was expanded to the explicit stream list from the ChatGPT manifest.

### Step 4: First collection (full sync)

**Runtime → Connector:**

Full grant passed. (Abbreviated; all fields from Step 3 are included.)

```json
{"type": "START", "run_id": "run_100", "grant": {"version": "0.1.0", "grant_id": "grt_agent_001", "issued_at": "2026-03-28T15:00:00Z", "subject": {"id": "user_abc"}, "client": {"client_id": "my_agent"}, "connector_id": "https://registry.vana.org/connectors/chatgpt", "manifest_version": "2.0.0", "purpose_code": "agent_context", "sync_mode": "recurring", "streams": [{"name": "conversations"}, {"name": "messages"}, {"name": "memories"}], "expires_at": null}, "state": null}
```

**Connector → Runtime (streams conversations, then messages):**
```json
{"type": "PROGRESS", "stream": "conversations", "message": "Fetching conversations...", "count": 0}
{"type": "RECORD", "stream": "conversations", "key": "conv_001", "data": {"id": "conv_001", "title": "Trip planning", "created_at": "2026-03-25T18:22:11Z", "message_count": 12}, "emitted_at": "2026-03-28T15:02:00Z"}
{"type": "RECORD", "stream": "conversations", "key": "conv_002", "data": {"id": "conv_002", "title": "Recipe ideas", "created_at": "2026-03-26T10:00:00Z", "message_count": 8}, "emitted_at": "2026-03-28T15:02:00Z"}
{"type": "STATE", "stream": "conversations", "cursor": {"updated_at": "2026-03-26T10:00:00Z"}}
{"type": "PROGRESS", "stream": "messages", "message": "Fetching messages...", "count": 0}
{"type": "RECORD", "stream": "messages", "key": "msg_001", "data": {"id": "msg_001", "conversation_id": "conv_001", "role": "user", "content": "Plan a 3-day trip to Tokyo", "created_at": "2026-03-25T18:23:02Z"}, "emitted_at": "2026-03-28T15:02:01Z"}
{"type": "RECORD", "stream": "messages", "key": "msg_002", "data": {"id": "msg_002", "conversation_id": "conv_001", "role": "assistant", "content": "Here's a suggested itinerary...", "created_at": "2026-03-25T18:23:15Z"}, "emitted_at": "2026-03-28T15:02:01Z"}
{"type": "STATE", "stream": "messages", "cursor": {"created_at": "2026-03-26T10:05:00Z"}}
{"type": "RECORD", "stream": "memories", "key": "mem_001", "data": {"id": "mem_001", "content": "User prefers window seats on flights", "created_at": "2026-03-20T09:00:00Z"}, "emitted_at": "2026-03-28T15:02:02Z"}
{"type": "STATE", "stream": "memories", "cursor": {"created_at": "2026-03-20T09:00:00Z"}}
{"type": "DONE", "status": "succeeded", "records_emitted": 2200}
```

### Step 5: Second collection (incremental, next day)

**Runtime → Connector:**

Same grant as step 4, with grant-scoped state from the previous run (keyed by grant_id, not global):

```json
{"type": "START", "run_id": "run_101", "grant": {"version": "0.1.0", "grant_id": "grt_agent_001", "issued_at": "2026-03-28T15:00:00Z", "subject": {"id": "user_abc"}, "client": {"client_id": "my_agent"}, "connector_id": "https://registry.vana.org/connectors/chatgpt", "manifest_version": "2.0.0", "purpose_code": "agent_context", "sync_mode": "recurring", "streams": [{"name": "conversations"}, {"name": "messages"}, {"name": "memories"}], "expires_at": null}, "state": {"conversations": {"updated_at": "2026-03-26T10:00:00Z"}, "messages": {"created_at": "2026-03-26T10:05:00Z"}, "memories": {"created_at": "2026-03-20T09:00:00Z"}}}
```

The connector uses the cursors to fetch only new data since the last sync:

```json
{"type": "RECORD", "stream": "conversations", "key": "conv_003", "data": {"id": "conv_003", "title": "New conversation", "created_at": "2026-03-29T08:00:00Z", "message_count": 3}, "emitted_at": "2026-03-29T15:00:00Z"}
{"type": "RECORD", "stream": "messages", "key": "msg_050", "data": {"id": "msg_050", "conversation_id": "conv_003", "role": "user", "content": "What's the weather?", "created_at": "2026-03-29T08:00:01Z"}, "emitted_at": "2026-03-29T15:00:01Z"}
{"type": "STATE", "stream": "conversations", "cursor": {"updated_at": "2026-03-29T08:00:00Z"}}
{"type": "STATE", "stream": "messages", "cursor": {"created_at": "2026-03-29T08:00:30Z"}}
{"type": "DONE", "status": "succeeded", "records_emitted": 5}
```

Only 5 new records instead of 2200. The agent calls the data query API to get the latest:

```http
GET /v1/streams/conversations/records?limit=10&order=desc&expand[]=messages&expand_limit[messages]=5
Authorization: Bearer agent_tok_xyz
PDPP-Version: 2026-03-28
```

---

## Example 3: Health app with retention constraints

A sleep analysis app needs 30 days of Oura sleep data and agrees to delete it after 90 days.

### Step 1: Selection request

```json
{
  "type": "https://vana.com/protocol/data-access",
  "connector_id": "https://registry.vana.org/connectors/oura",
  "purpose_code": "analytics",
  "purpose_description": "Analyze your sleep patterns",
  "streams": [
    {
      "name": "sleep_sessions",
      "necessity": "required",
      "time_range": { "since": "2026-02-26T00:00:00Z", "until": "2026-03-28T00:00:00Z" },
      "fields": ["day", "total_sleep_duration", "sleep_score", "deep_sleep_duration"]
    }
  ]
}
```

### Step 2: Grant with retention

```json
{
  "version": "0.1.0",
  "grant_id": "grt_sleep_001",
  "issued_at": "2026-03-28T15:00:00Z",
  "subject": { "id": "user_abc" },
  "client": { "client_id": "sleep_app" },
  "connector_id": "https://registry.vana.org/connectors/oura",
  "manifest_version": "1.0.0",
  "purpose_code": "analytics",
  "sync_mode": "one_time",
  "streams": [
    {
      "name": "sleep_sessions",
      "time_range": { "since": "2026-02-26T00:00:00Z", "until": "2026-03-28T00:00:00Z" },
      "fields": ["day", "total_sleep_duration", "sleep_score", "deep_sleep_duration"]
    }
  ],
  "retention": { "max_duration": "P90D", "on_expiry": "delete" }
}
```

### Step 3: App queries data

```http
GET /v1/streams/sleep_sessions/records?fields=day,total_sleep_duration,sleep_score,deep_sleep_duration
Authorization: Bearer sleep_tok_abc
PDPP-Version: 2026-03-28
```

Response only includes the granted fields:

```json
{
  "object": "list",
  "url": "/v1/streams/sleep_sessions/records",
  "has_more": false,
  "data": [
    {
      "object": "record",
      "id": "sleep_20260226",
      "stream": "sleep_sessions",
      "data": {
        "day": "2026-02-26",
        "total_sleep_duration": 28800,
        "sleep_score": 85,
        "deep_sleep_duration": 7200
      },
      "emitted_at": "2026-03-28T15:01:00Z"
    }
  ]
}
```

Fields like `average_heart_rate`, `average_hrv`, and `lowest_heart_rate` exist in the resource server's stored records but are excluded because the grant's `fields` allowlist doesn't include them.

### Step 4: After 90 days

The sleep app is obligated to delete all data from this grant. The resource server still has the records (the user's data isn't affected). But if the app tries to use the access token after the retention period, the grant's obligations require the app to have already purged its copy.

---

## Example 4: Low-friction Instagram connect (profile-based)

A social app wants a quick connection with minimal user decisions.

### Step 1: Selection request using a profile

```json
{
  "type": "https://vana.com/protocol/data-access",
  "connector_id": "https://registry.vana.org/connectors/instagram",
  "purpose_code": "personalization",
  "sync_mode": "recurring",
  "profile": "quick_social"
}
```

The authorization server looks up the `quick_social` profile from the Instagram connector manifest:

```json
{
  "id": "quick_social",
  "label": "Quick social connect",
  "streams": [
    { "name": "profile" },
    { "name": "media" }
  ]
}
```

### Step 2: Consent screen (simplified)

> **Social App** wants to connect your **Instagram**:
> - Your profile
> - Your recent posts
>
> [Connect] [Cancel]

### Step 3: Grant

```json
{
  "version": "0.1.0",
  "grant_id": "grt_insta_001",
  "issued_at": "2026-03-28T15:00:00Z",
  "subject": { "id": "user_abc" },
  "client": { "client_id": "social_app" },
  "connector_id": "https://registry.vana.org/connectors/instagram",
  "manifest_version": "3.0.0",
  "purpose_code": "personalization",
  "sync_mode": "recurring",
  "profile": "quick_social",
  "streams": [
    { "name": "profile" },
    { "name": "media" }
  ]
}
```

### Step 4: Collection with INTERACTION (manual login)

Full grant passed:

```json
{"type": "START", "run_id": "run_200", "grant": {"version": "0.1.0", "grant_id": "grt_insta_001", "issued_at": "2026-03-28T15:00:00Z", "subject": {"id": "user_abc"}, "client": {"client_id": "social_app"}, "connector_id": "https://registry.vana.org/connectors/instagram", "manifest_version": "3.0.0", "purpose_code": "personalization", "sync_mode": "recurring", "profile": "quick_social", "streams": [{"name": "profile"}, {"name": "media"}]}, "state": null}
```

The connector needs browser-based login:

```json
{"type": "INTERACTION", "request_id": "req_ig_login", "kind": "manual_action", "message": "Log in to Instagram", "timeout_seconds": 300}
```

The runtime shows the user a headed browser (CLI), a Plaid-like login screen (web app), or a remote browser stream (Embrowse). The user logs in.

```json
{"type": "INTERACTION_RESPONSE", "request_id": "req_ig_login", "status": "success"}
```

The connector collects profile + media with blob_ref for images:

```json
{"type": "RECORD", "stream": "profile", "key": "user_123", "data": {"id": "user_123", "username": "jane_doe", "full_name": "Jane Doe", "bio": "Photographer", "follower_count": 1200}, "emitted_at": "2026-03-28T15:03:00Z"}
{"type": "RECORD", "stream": "media", "key": "media_456", "data": {"id": "media_456", "caption": "Sunset over the bay", "media_type": "image", "created_at": "2026-03-27T19:30:00Z", "like_count": 42, "blob_ref": {"blob_id": "blob_media_456", "mime_type": "image/jpeg", "size_bytes": 2048000, "sha256": "a1b2c3..."}}, "emitted_at": "2026-03-28T15:03:01Z"}
{"type": "STATE", "stream": "media", "cursor": {"created_at": "2026-03-27T19:30:00Z"}}
{"type": "DONE", "status": "succeeded", "records_emitted": 101}
```

### Step 5: App fetches data

```http
GET /v1/streams/media/records?limit=20&order=desc
Authorization: Bearer social_tok_abc
PDPP-Version: 2026-03-28
```

```json
{
  "object": "list",
  "url": "/v1/streams/media/records",
  "has_more": true,
  "data": [
    {
      "object": "record",
      "id": "media_456",
      "stream": "media",
      "data": {
        "id": "media_456",
        "caption": "Sunset over the bay",
        "media_type": "image",
        "created_at": "2026-03-27T19:30:00Z",
        "like_count": 42,
        "blob_ref": {
          "blob_id": "blob_media_456",
          "mime_type": "image/jpeg",
          "size_bytes": 2048000,
          "sha256": "a1b2c3...",
          "fetch_url": "https://ps.example.com/v1/blobs/blob_media_456"
        }
      },
      "emitted_at": "2026-03-28T15:03:01Z"
    }
  ]
}
```

The app fetches the actual image:

```http
GET /v1/blobs/blob_media_456
Authorization: Bearer social_tok_abc
```

```http
HTTP/1.1 200 OK
Content-Type: image/jpeg
Content-Length: 2048000
```

---

## Example 5: User proactively collects (CLI, no app involved)

The user runs `vana collect spotify` to populate their personal server before any app requests data.

### Step 1: User triggers collection

```bash
$ vana collect spotify
```

### Step 2: Connector runtime starts connector with no grant

**Runtime → Connector:**
```json
{"type": "START", "run_id": "run_300", "grant": null, "state": {"top_artists": {"last_updated": "2026-03-01T00:00:00Z"}, "saved_tracks": {"added_at": "2026-03-15T12:00:00Z"}}}
```

`grant` is null. The connector collects all streams defined in its manifest. Previous state is passed for incremental sync.

### Step 3: Connector collects incrementally

```json
{"type": "INTERACTION", "request_id": "req_spot_login", "kind": "credentials", "message": "Log in to Spotify", "schema": {"type": "object", "properties": {"email": {"type": "string"}, "password": {"type": "string", "format": "password"}}, "required": ["email", "password"]}, "timeout_seconds": 300}
```

Runtime prompts user in the CLI:

```
Log in to Spotify
Email: user@example.com
Password: ********
```

```json
{"type": "INTERACTION_RESPONSE", "request_id": "req_spot_login", "status": "success", "data": {"email": "user@example.com", "password": "hunter2"}}
```

Connector fetches only new data since last sync:

```json
{"type": "PROGRESS", "stream": "saved_tracks", "message": "Fetching new saved tracks...", "count": 0}
{"type": "RECORD", "stream": "saved_tracks", "key": "track_new_1", "data": {"track_id": "track_new_1", "name": "Everything In Its Right Place", "artist": "Radiohead", "added_at": "2026-03-20T10:00:00Z"}, "emitted_at": "2026-03-28T15:05:00Z"}
{"type": "RECORD", "stream": "saved_tracks", "key": "track_new_2", "data": {"track_id": "track_new_2", "name": "Army of Me", "artist": "Bjork", "added_at": "2026-03-22T14:30:00Z"}, "emitted_at": "2026-03-28T15:05:00Z"}
{"type": "STATE", "stream": "saved_tracks", "cursor": {"added_at": "2026-03-22T14:30:00Z"}}
{"type": "STATE", "stream": "top_artists", "cursor": {"last_updated": "2026-03-28T00:00:00Z"}}
{"type": "DONE", "status": "succeeded", "records_emitted": 55}
```

Data is now in the user's personal server. When a concert app requests access later, the data is already there (Example 1, step 4a).
