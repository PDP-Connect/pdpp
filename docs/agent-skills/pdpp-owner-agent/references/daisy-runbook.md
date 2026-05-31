# Daisy owner-agent runbook

This runbook is the end-to-end path for a trusted local owner agent — Daisy is the
worked example — from a single entrypoint URL through approval, local credential
storage, initial sync, and incremental sync. It is owner-level local automation. Read
`SKILL.md` first; read `sync.md` for the deeper query and callback-vs-polling reference.

Conventions used below:

- `$ENTRYPOINT` — the operator's reference instance origin (what the operator hands Daisy).
- `$RS_URL`, `$AS_URL` — resolved from discovery, not assumed.
- `read-owner-cred` — read `access_token` from
  `~/applications/daisy/.pi/agent/pdpp-owner-agent.json` without printing it.

Never print the bearer at any step. Status output is non-secret metadata only.

## Step 0 — Confirm you are the authorized owner agent

Daisy runs locally as the operator's assistant and the operator has explicitly chosen the
owner-agent profile. If that is not unambiguously true, stop and use the grant-scoped
`pdpp-data-access` skill instead. Owner-level access is not the default.

## Step 1 — Discover onboarding from the entrypoint URL

```bash
curl -fsS "$ENTRYPOINT/.well-known/oauth-protected-resource" \
  | jq '.pdpp_owner_agent_onboarding'
```

If the entrypoint is the bare origin, the cold-start root pointer also carries the block:

```bash
curl -fsS "$ENTRYPOINT/" | jq '.pdpp_owner_agent_onboarding'
```

Expect a block whose fields name every surface you need, so you never guess a route:

| Field | Use |
| --- | --- |
| `resource` | RS resource origin → `$RS_URL` |
| `authorization_server` | AS issuer → `$AS_URL` |
| `device_authorization_endpoint` | POST here to start owner approval (Step 2) |
| `owner_approval_url` | the `/device` page you relay to the operator (Step 2) |
| `token_endpoint` | poll here for the issued credential (Step 2) |
| `schema_endpoint` | `/v1/schema` (Step 4) |
| `streams_endpoint` | `/v1/streams` (Step 4) |
| `query_base` | base for `/v1/streams/{stream}/records` (Step 5) |
| `introspection_endpoint` | check credential validity (Step 7) |
| `revocation_path_template` | revoke the registered client |
| `event_subscriptions_endpoint` | optional push delivery (Step 6) |
| `mcp_owner_bearer_rejected: true` | `/mcp` is not the owner-agent transport |

Resolve `$RS_URL` (`resource`) and `$AS_URL` (`authorization_server`) from this block, and
read each endpoint by name. Do not assume paths; the host derives every URL from the
caller-visible trusted origin.

**If the block is absent:** owner-agent onboarding is not available on this deployment
(disabled, misconfigured, or the caller-visible origin is not trusted). Report that and
stop. Do not scrape owner pages or invent a bearer.

## Step 2 — Owner approval via device authorization

Onboarding is an RFC 8628 device-authorization flow. The reliable path is
`pdpp owner-agent onboard <entrypoint>`, which runs every sub-step below and writes the
credential without printing it. The manual shape, for reference, is:

1. **Start device authorization.** POST the `device_authorization_endpoint`. The response
   carries a `device_code`, a `user_code`, and a `verification_uri_complete` — the
   `owner_approval_url` with the code attached (`<RS>/device?user_code=...`).

   ```bash
   curl -fsS -X POST "$DEVICE_AUTHORIZATION_ENDPOINT" \
     -H "Content-Type: application/x-www-form-urlencoded" \
     | jq '{user_code, verification_uri_complete, interval, expires_in}'
   ```

2. **Relay the approval URL and wait.** Show the operator the
   `verification_uri_complete` and stop until they confirm:

   > "To act as you against your PDPP instance, open <verification_uri_complete> and approve
   > owner-agent access. I can't approve this for you. Tell me when it's done."

   The operator approves in an owner-authenticated browser context. You cannot approve on
   their behalf.

3. **Poll the token endpoint.** POST the `token_endpoint` with
   `grant_type=urn:ietf:params:oauth:grant-type:device_code` and the `device_code`, at the
   advertised `interval`. Honor `authorization_pending` / `slow_down` (keep polling),
   `access_denied` (operator denied — stop), and `expired_token` (start over). On success
   the response contains the owner `access_token`; hand it straight to local storage
   (Step 3) without printing it.

If the operator denies or the request expires, you get a non-secret failure status — stop,
do not retry silently.

## Step 3 — Store and verify the local credential

The approved flow writes the owner credential to:

`~/applications/daisy/.pi/agent/pdpp-owner-agent.json`

The file is JSON, mode `0600`, and contains the bearer as `access_token`. Verify by
reading it at call time and hitting schema — without echoing the token:

```bash
TOKEN="$(jq -r '.access_token' "$HOME/applications/daisy/.pi/agent/pdpp-owner-agent.json")"
curl -fsS "$RS_URL/v1/schema" -H "Authorization: Bearer $TOKEN" | jq '.connectors[].name'
unset TOKEN
```

Report success as non-secret metadata only: token kind (`owner`), subject/client id,
expiry, revocation handle. Never the bearer.

Confirm the boundary holds (this should fail, and that is correct):

```bash
TOKEN="$(jq -r '.access_token' "$HOME/applications/daisy/.pi/agent/pdpp-owner-agent.json")"
curl -s -o /dev/null -w '%{http_code}\n' "$RS_URL/mcp" -H "Authorization: Bearer $TOKEN"
unset TOKEN
# Expect a rejection. /mcp is the grant-scoped client transport, not owner-agent REST.
```

## Step 4 — Initial sync (metadata first, bounded)

1. Fetch `/v1/schema`; record the connectors, streams, fields, and capability flags.
2. Enumerate streams and connections. `/v1/streams` returns a list envelope —
   `{ "object": "list", "has_more": ..., "data": [...] }`. The stream entries are under
   **`data`**, not a top-level `streams` key. Parse `data` and cache the catalog locally so
   you do not re-list before every read:

   ```bash
   TOKEN="$(jq -r '.access_token' "$HOME/applications/daisy/.pi/agent/pdpp-owner-agent.json")"
   curl -fsS "$RS_URL/v1/streams" -H "Authorization: Bearer $TOKEN" \
     | jq '.data | map({name, connection_id})'
   unset TOKEN
   ```

3. For each stream, page through with the declared pagination cursor and request only the
   fields you need. In multi-connection deployments, pass the stable `connection_id` as a
   query parameter (`?connection_id=...`) to scope a read, and attribute every record by its
   `connection_id`.
4. Persist sync state **per `(stream, connection_id)`** — the latest pagination cursor and
   the last `changes_since` value — to Daisy's local state. This is what makes future syncs
   cheap.

Do not pull full record bodies or blobs you do not need. Fetch attachment bytes only by
following `blob_ref.fetch_url`.

## Step 5 — Incremental sync (the steady state)

On every refresh, do not rescan. For each stream/connection, resume from the stored cursor:

```bash
TOKEN="$(jq -r '.access_token' "$HOME/applications/daisy/.pi/agent/pdpp-owner-agent.json")"
curl -fsS \
  "$RS_URL/v1/streams/<stream>/records?connection_id=<id>&changes_since=<stored-cursor>&limit=200" \
  -H "Authorization: Bearer $TOKEN" \
  | jq '{records: .data, has_more, next_cursor, next_changes_since}'
unset TOKEN
```

Records come back in the same list envelope: rows under **`data`**, with `has_more`,
`next_cursor` (pagination), and `next_changes_since` (the delta cursor to store).

- Bootstrap a brand-new stream with `changes_since=beginning`.
- Page with `next_cursor` while `has_more` is true; request only the fields you need and
  apply only filters `/v1/schema` advertises for the stream.
- Persist `next_changes_since` per `(stream, connection_id)` after each successful page.
- Periodically re-fetch `/v1/schema` and `/v1/streams` so newly added streams and
  connections appear without guessing — that is how "future data" stays in view.

## Step 6 — Staying current: poll or subscribe

Decide once, per `sync.md`:

- **Durable valid-TLS HTTPS receiver available** → optionally create event subscriptions
  with the registered owner-agent bearer where advertised; on each
  `pdpp.records.changed` event, run Step 5 using the event's source identity and
  `changes_since` cursor. **Create/rotate returns a one-time `whsec_` signing secret in the
  response body.** Persist it securely at that moment — the server stores only a hash and
  will not return it again. If you lose it, rotate to get a new one.
- **No durable receiver** (typical for a laptop-resident Daisy) → poll Step 5 on a backoff
  schedule plus periodic metadata refresh. Do not point a subscription at an unreachable
  local callback.

## Step 7 — Revocation hygiene

The operator can revoke the owner-agent credential from the dashboard at any time. If
introspection reports inactive, or a call returns revoked/inactive, stop using the
credential and tell the operator. Do not silently re-onboard.

## Prompt to give Daisy

A concise, copy-pasteable first-run prompt for the public reference deployment at
`https://pdpp.vivid.fish`. It encodes the entrypoint-first flow without leaking any secret:

> You are my trusted owner agent for my PDPP reference instance at
> `https://pdpp.vivid.fish`. Read
> `https://pdpp.vivid.fish/.well-known/oauth-protected-resource` and find the
> `pdpp_owner_agent_onboarding` block. If it is absent, tell me onboarding is unavailable
> and stop. Otherwise start owner-agent device authorization at its
> `device_authorization_endpoint`, show me the `verification_uri_complete` (the
> `/device?user_code=...` page) to approve in my browser, and wait. After I approve, poll
> the `token_endpoint`, and store the issued credential at
> `~/applications/daisy/.pi/agent/pdpp-owner-agent.json` with mode 0600. Never print the
> bearer; confirm with non-secret status only (token kind, subject, expiry).
>
> From then on, read the credential from that file at call time without printing it. Pull
> `/v1/schema` and `/v1/streams` (the stream catalog is under `data`), cache it, and use
> the stable `connection_id` to scope reads. Query records at
> `/v1/streams/{stream}/records` with `data` rows, `next_cursor` for pagination, and
> `changes_since` (bootstrap `beginning`, then store `next_changes_since`) for deltas. Keep
> per-`(stream, connection_id)` cursors so refreshes are incremental, and re-list streams
> periodically so new data appears. Don't use `/mcp` with this credential — it's
> owner-level REST only.
