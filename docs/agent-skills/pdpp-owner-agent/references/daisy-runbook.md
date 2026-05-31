# Daisy owner-agent runbook

This runbook is the end-to-end path for a trusted local owner agent — Daisy is the
worked example — from a single entrypoint URL through approval, local credential
storage, initial sync, and incremental sync. It is owner-level local automation. Read
`SKILL.md` first; read `sync.md` for the deeper query and callback-vs-polling reference.

Conventions used below:

- `$ENTRYPOINT` — the operator's reference instance origin (what the operator hands Daisy).
- `$RS_URL`, `$AS_URL` — resolved from discovery, not assumed.
- `read-owner-cred` — a stand-in for whatever command reads the local owner credential
  target. Confirm the real command/path with the operator; do not hard-code a guess.

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

Expect a block that names: the profile, the AS issuer and RS resource origin, the owner
approval surface, the schema endpoint, the stream-discovery endpoint, the query base, the
token-introspection endpoint, the revocation path, and the event-subscription discovery
link — and that states `/mcp` is not the owner-agent transport.

Resolve `$RS_URL` (RS resource origin) and `$AS_URL` (AS issuer) from this block.

**If the block is absent:** owner-agent onboarding is not available on this deployment
(disabled, misconfigured, or the caller-visible origin is not trusted). Report that and
stop. Do not scrape owner pages or invent a bearer.

## Step 2 — Owner approval in the browser

Initiate the owner-agent bootstrap through the approval surface from Step 1, then relay the
approval URL to the operator and wait:

> "To act as you against your PDPP instance, open <approval URL> and approve owner-agent
> access. I can't approve this for you. Tell me when it's done."

The operator approves in an owner-authenticated browser/dashboard context. The flow writes
the credential to the local target (Step 3). You never receive a pasted bearer.

If the operator denies or later revokes, you get a non-secret failure/revocation status —
stop, do not retry silently.

## Step 3 — Store and verify the local credential

The approved flow writes the owner credential to the operator's local credential target
with mode `0600` in a directory the operator controls. For Daisy that lives under
`~/applications/daisy`; confirm the exact filename/path with the operator rather than
assuming. Verify by reading it at call time and hitting schema — without echoing the token:

```bash
TOKEN="$(read-owner-cred)"
curl -fsS "$RS_URL/v1/schema" -H "Authorization: Bearer $TOKEN" | jq '.connectors[].name'
unset TOKEN
```

Report success as non-secret metadata only: token kind (`owner`), subject/client id,
expiry, revocation handle. Never the bearer.

Confirm the boundary holds (this should fail, and that is correct):

```bash
TOKEN="$(read-owner-cred)"
curl -s -o /dev/null -w '%{http_code}\n' "$RS_URL/mcp" -H "Authorization: Bearer $TOKEN"
unset TOKEN
# Expect a rejection. /mcp is the grant-scoped client transport, not owner-agent REST.
```

## Step 4 — Initial sync (metadata first, bounded)

1. Fetch `/v1/schema`; record the connectors, streams, fields, and capability flags.
2. Enumerate streams and connections:

   ```bash
   TOKEN="$(read-owner-cred)"
   curl -fsS "$RS_URL/v1/streams" -H "Authorization: Bearer $TOKEN" | jq .
   unset TOKEN
   ```

3. For each stream, page through with the declared pagination cursor and request only the
   fields you need. Attribute every record by `connection_id` in multi-connection setups.
4. Persist sync state **per stream and per connection** — the latest cursor and the last
   `changes_since` value — to Daisy's local state. This is what makes future syncs cheap.

Do not pull full record bodies or blobs you do not need. Fetch attachment bytes only by
following `blob_ref.fetch_url`.

## Step 5 — Incremental sync (the steady state)

On every refresh, do not rescan. For each stream/connection, resume from the stored cursor:

```bash
TOKEN="$(read-owner-cred)"
curl -fsS "$RS_URL/v1/streams/<stream>/records?changes_since=<stored-cursor>&limit=200&order=asc" \
  -H "Authorization: Bearer $TOKEN" | jq .
unset TOKEN
```

- Bootstrap a brand-new stream with `changes_since=beginning`.
- Use declared filters and field projections to narrow further.
- Persist the new cursor after each successful page.
- Periodically re-fetch `/v1/schema` and `/v1/streams` so newly added streams and
  connections appear without guessing — that is how "future data" stays in view.

## Step 6 — Staying current: poll or subscribe

Decide once, per `sync.md`:

- **Durable valid-TLS HTTPS receiver available** → optionally create event subscriptions
  where advertised; on each `pdpp.records.changed` event, run Step 5 from the event's
  `changes_since` cursor.
- **No durable receiver** (typical for a laptop-resident Daisy) → poll Step 5 on a backoff
  schedule plus periodic metadata refresh. Do not point a subscription at an unreachable
  local callback.

## Step 7 — Revocation hygiene

The operator can revoke the owner-agent credential from the dashboard at any time. If
introspection reports inactive, or a call returns revoked/inactive, stop using the
credential and tell the operator. Do not silently re-onboard.
