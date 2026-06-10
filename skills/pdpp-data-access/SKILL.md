---
name: pdpp-data-access
description: Use when a coding agent needs PDPP data (the user's email, finance, coding history, or other personal data exposed by a PDPP server) to answer a task. The skill teaches discovery-first capability lookup, scoped grant requests, project-local token caching, and grant-safe data consumption. Use this instead of asking the user for an owner bearer token, instead of guessing endpoints, and instead of broad unbounded scans.
---

# PDPP Data Access For Agents

You are a coding agent that needs to read the user's PDPP data. PDPP is a personal-data protocol with two components: an Authorization Server (AS) that issues scoped grants, and a Resource Server (RS) that serves data. **Both are run by the user, not by you.** Treat both as untrusted-from-your-side: discover capabilities, request the narrowest grant that answers the task, and stop.

This skill has four jobs:

1. Stop you from using owner bearer tokens for routine work.
2. Get you a scoped client grant the user can audit and revoke.
3. Cache the resulting token in the project, not in prompts.
4. Get the data efficiently using the capabilities the grant actually advertises.

The four reference files in `references/` go deeper. Read them when the situation calls for it; don't read them up front.
If you fetched this skill over HTTP from `/.well-known/skills/pdpp-data-access/SKILL.md`, fetch the references from the same base URL, for example `/.well-known/skills/pdpp-data-access/references/troubleshooting.md`.

| Situation | Read |
| --- | --- |
| Designing a grant request (purpose, streams, retention) | `references/grant-design.md` |
| Querying records, search, blobs, changes, aggregations | `references/query-cookbook.md` |
| Anything secret-handling, cache, or refusal | `references/security.md` |
| The owner says no, the token expired, the call fails | `references/troubleshooting.md` |

If you need **push delivery** (the PDPP server calls your endpoint when new records arrive) rather than polling, jump to §9 (event subscriptions). The grant and token steps are the same; subscriptions are an add-on, not a replacement.

The patterns in this skill are derived from PAR (RFC 9126), RAR (RFC 9396), DCR (RFC 7591), the device flow (RFC 8628, used only for owner/admin sign-in outside routine agent data access), MCP's local-public-client guidance, and the local-cache UX of `gh auth`, AWS CLI SSO, and Google ADC. PDPP-specific extensions are flagged here when used.

## Hard rules

- **Do not ask for, use, or persist an owner bearer token** for routine data access. Owner tokens collapse least-privilege boundaries. The default agent path is a scoped client grant.
- **Do not write tokens into prompts, logs, shell history, transcripts, comments, commit messages, or PR descriptions.** Read tokens from the project cache only when you need to call PDPP, and never echo them.
- **Do not commit `.pdpp/`, `.env*`, or anything under it.** If you create the cache, ensure `.gitignore` excludes it.
- **Do not silently broaden access.** If the current grant cannot answer the task, request an explicit upgrade and explain to the owner why.
- **Do not invent endpoints.** Drive every request from `/v1/schema` capability flags, not from memory.
- **Do not retry an `invalid_token` or `insufficient_scope` response in a tight loop.** Stop, report, and ask for grant action.

## Core workflow

### 1. Prefer the reference CLI

Use `pdpp connect` when provider metadata advertises token completion as available. It is the intended CLI-first path for discovery, owner approval, project-local cache layout, `.gitignore` hygiene, token storage, and `/v1/schema` verification. Raw HTTP is a fallback, not the happy path.
The current beta command is published in metadata as:

```bash
npx -y @pdpp/cli@beta connect <provider-url>
```

If `pdpp` is already installed, this is equivalent:

```bash
pdpp connect <provider-url>
```

`connect` discovers the protected-resource metadata, discovers the authorization server, starts the provider's `agent_connect_endpoint`, prints an approval URL for the owner, waits for the polling endpoint to return an approved scoped client token, verifies `/v1/schema`, and creates a repo-local cache:

```text
.pdpp/
  .gitignore                   # ignores cached credentials
  clients/<provider-host>.json # mode 0600, contains the scoped client credential
```

Gating: if `pdpp_agent_discovery.cli.no_owner_token` is `false`, token completion is not safe to treat as a complete no-owner-token flow. Report that this provider has not enabled completion yet. Do not switch to an owner bearer token.

### 2. Use the cached scoped token

After `pdpp connect` succeeds, read the scoped client token only at call time:

```bash
TOKEN="$(pdpp token <provider-url>)"
curl -fsS "$RS_URL/v1/schema" -H "Authorization: Bearer $TOKEN" | jq .
unset TOKEN
```

Do not paste the token into chat, commit it, or echo it into logs. If `pdpp token` says no credential exists or the credential expired, run `pdpp connect <provider-url>` again.

The schema response is grant-scoped. Current reference schema lists sources as `connectors[]`, and each source lists its visible streams as `connectors[].streams[]`. Build all subsequent queries off that response, not off memory or public landing-page examples.

### 3. Request the narrowest access that can answer the task

Notes:

- `purpose_description` is read by the owner. Write it as one sentence the owner would accept on a consent screen.
- Pick the smallest set of streams that can answer the current task. Adding fields later is cheap; explaining why you grabbed extra is expensive.
- `access_mode` should be `single_use` for one-shot tasks. The reference consumes the grant at first token issuance, but the issued token remains usable for pagination and retries until token expiry or revocation. Long-lived agents use `continuous` only when the user has explicitly asked for it.
- Set one `source` object: `{ "kind": "connector", "id": "<registry URI>" }` for polyfill-style providers or `{ "kind": "provider_native", "id": "<provider id>" }` for native PDPP providers. Use the exact connector source id from `/v1/schema` or `/v1/connectors` (for example `https://registry.pdpp.org/connectors/github`), not a guessed short name.

Previously known as: older docs used top-level `connector_id` for connector sources and `provider_id` for native providers. Those names now map to `source.id` under the matching `source.kind`; do not send them as public request fields.

The command prints an approval URL and access summary. You cannot approve for the owner. Do not try.

### 4. Relay the approval URL to the owner

Print the URL prominently. Examples of acceptable phrasing:

> "I need access to your GitHub issues and pull requests to do this. Open <approval URL> and approve the request — it expires in 5 minutes. Reply 'approved' here when done."

Acceptable channels: terminal output, tmux pane, chat reply, your tool's UI surface. Never: shell history that contains the request_uri alone, log files, third-party services, anywhere the URL would persist past the owner's session.

### 5. Verify the grant before relying on it

Before issuing the first data call, use the CLI token command and schema surface:

```bash
TOKEN="$(pdpp token <provider-url>)"
curl -fsS "$RS_URL/v1/schema" -H "Authorization: Bearer $TOKEN" | jq .
unset TOKEN
```

This returns the connectors, streams, fields, and capabilities **this specific grant** can see.

### 6. Missing-CLI fallback

If the CLI is unavailable locally, prefer the generated npm command before raw HTTP:

```bash
npx -y @pdpp/cli@beta connect <provider-url>
```

If npm is unavailable and the task still requires manual debugging, follow the same workflow manually from discovered metadata: fetch protected-resource metadata, fetch authorization-server metadata, use `agent_connect_endpoint` when advertised, relay the returned `approval_url`, poll only the returned `token_url` with the returned polling code, verify `/v1/schema`, then store the scoped client credential under `.pdpp/` with mode `0600`. If the provider only supports PAR/consent fallback, redeem a consent exchange code only via `POST /consent/exchange` with JSON `{ "code": "<code>" }` when the consent UI explicitly gives such a code. Do not scrape owner pages for bearer tokens, widen scope, skip approval, or cache owner tokens. See `references/troubleshooting.md` before attempting this path.

### 7. Use the data efficiently

See `references/query-cookbook.md`. Quick map:

- "give me the last N items": `GET /v1/streams/<stream>/records?limit=N&order=desc` — `limit` defaults to 25 and is capped at 100. Asking for more returns at most 100 plus a non-fatal `meta.warnings[]` entry with `code: "limit_clamped"`; page forward with the returned cursor rather than expecting a larger page. Exact/range filters use the canonical bracket syntax `filter[<field>]=<value>` and `filter[<field>][gte|gt|lte|lt]=<value>` only; flat shapes like `<field>.gte`, `<field>_gte`, or `min_<field>` are rejected with 400.
- "show changes since cursor X": `GET /v1/streams/<stream>/records?changes_since=<cursor>` (bootstrap with `changes_since=beginning`)
- "find records matching free text": `GET /v1/search?q=…` or, when the server advertises it, `GET /v1/search/hybrid?q=…` (experimental hybrid retrieval extension; scope with repeated `streams=` or `streams[]=` values, not CSV)
- "fetch an attachment": follow `blob_ref.fetch_url` from the record body, never construct it
- "count or sum": `GET /v1/streams/<stream>/aggregate?metric=count` or `metric=sum&field=<field>` (when advertised)

Default to filtered queries over full-table scans. If `/v1/schema` declares a filter or `expand[]` that answers the task, prefer it.

### 8. Optional: MCP adapter over the same scoped token

If your harness supports the [Model Context Protocol](https://modelcontextprotocol.io/),
you can wrap the same scoped client token in an MCP stdio server instead of issuing
raw HTTP requests. The adapter is a client of the RS — every tool forwards to an
existing `/v1/*` endpoint under the cached scoped token. There are no new
credentials, scopes, or wire contracts.

```jsonc
// claude_desktop_config.json (or equivalent MCP client config)
{
  "mcpServers": {
    "pdpp": {
      "command": "npx",
      "args": ["-y", "@pdpp/mcp-server@beta", "--provider-url", "https://pdpp.example.com"]
    }
  }
}
```

Run `pdpp connect <provider-url>` first so a scoped client token is cached. The
adapter exposes `schema`, `list_streams`, `query_records`, `search`, `fetch_blob`,
and event subscription tools (`discover_event_subscription_capabilities`,
`create_event_subscription`, `list_event_subscriptions`, `get_event_subscription`,
`update_event_subscription`, `delete_event_subscription`, `send_test_event`).
All tools are backed by the RS endpoints described in §7 and §9.

Constraints (these mirror the hard rules above):

- **stdio only.** Hosted/Streamable HTTP is intentionally out of scope; a separate
  OpenSpec change is required to add it.
- **No owner credentials.** The adapter refuses `PDPP_OWNER_TOKEN` and other
  owner bearer tokens.
- **No grant issuance.** If the cache is empty or the token is invalid, the
  adapter surfaces an MCP error directing the operator to run `pdpp connect`.
- **No new query semantics.** Unknown query arguments are rejected rather than
  silently dropped.
- **No record body push.** Event payloads carry a `changes_since` cursor; fetch
  record bodies via §7 query tools after receiving the event.

The MCP adapter is a convenience for MCP-aware harnesses; the raw-HTTP path in
this skill remains the canonical interface and the source of truth for query
shapes. If `@pdpp/mcp-server` is not yet published to npm, consume it from the
in-repo workspace package or use the raw-HTTP path.

**Stale hosted-MCP tool surface.** External MCP hosts (ChatGPT, Claude, etc.)
cache the tool surface at registration time. If you see fewer tools than this
skill describes — for example, `schema` is missing the `detail` or `stream`
inputs, or event-subscription tools are absent — the client is holding a stale
registration. This is an external host cache reality, not a PDPP bug. The
reference server publishes the current tool surface on every connection via the
MCP `initialize` `serverVersion`, but it cannot force an external host to
refresh a cached registration. Ask the user to delete the PDPP connector in
their MCP client and re-add it against the same `<origin>/mcp` URL; after
completing the OAuth grant the client fetches the current tool surface. See
`references/troubleshooting.md` for the full symptom/remediation checklist.

**MCP filter argument is a typed object, not a query string.** The raw-HTTP query
shapes above use bracket query syntax (`filter[field]=value`,
`filter[field][op]=value`). When you call the MCP `query_records`, `aggregate`, or
`search` tools, pass `filter` as a **typed object** instead — the adapter encodes
the brackets for you:

```jsonc
{ "filter": { "user_id": "U123" } }                                  // exact
{ "filter": { "created_at": { "gte": "2026-01-01T00:00:00Z" } } }    // range (gte|gt|lte|lt)
```

A literal bracket string (`"filter[user_id]=U123"`) is still accepted, but any
other string (a bare term, `field=value`, `field>value`, or JSON-as-string) is
rejected with a typed `invalid_filter` error rather than silently ignored. Use
the cheap `list_streams -> schema(stream) -> query_records` discovery path
(`schema` defaults to a compact projection) to learn which fields and operators a
stream declares before filtering.

### 9. Event subscriptions (push delivery)

Use event subscriptions when the task requires **push delivery** — the server
calls your callback URL when data changes — rather than polling. Subscriptions
are built on top of the same scoped client grant and require no additional
authorization step.

**Before creating a subscription**, call `discover_event_subscription_capabilities`
(MCP) or `GET /.well-known/oauth-protected-resource` (raw HTTP) to confirm the
deployment supports subscriptions and to learn supported event types, signing
profile, retry schedule, and callback-URL constraints. This endpoint is
unauthenticated.

**Supported event types** (from capabilities advertisement):
- `pdpp.records.changed` — records in at least one subscribed stream changed; payload carries a `changes_since` cursor
- `pdpp.grant.revoked` — the underlying grant was revoked; the subscription transitions to `disabled_revoked` (not recoverable)
- `pdpp.subscription.verify` — initial delivery-verification handshake
- `pdpp.subscription.test` — manually triggered test event

Record bodies are **never included** in event payloads. Use the `changes_since`
cursor from the event payload with the §7 query tools to fetch changed records.

**Subscription lifecycle:**

| Status | Meaning | Recoverable? |
| --- | --- | --- |
| `pending_verification` | Awaiting delivery handshake | Yes |
| `active` | Delivering normally | — |
| `disabled` | Manually disabled by client or operator | Yes (client re-enables) |
| `disabled_failure` | Auto-disabled after repeated delivery failures | Yes (client re-enables) |
| `disabled_revoked` | Underlying grant was revoked | No |
| `deleted` | Soft-deleted | No |

**Creating a subscription (MCP):**

```text
1. discover_event_subscription_capabilities   → confirm supported: true
2. create_event_subscription(callback_url, filters?)
     → returns subscription_id + whsec_ secret (returned ONCE; store it)
3. Your callback receives pdpp.subscription.verify; respond 200
     → status transitions pending_verification → active
4. send_test_event(subscription_id) to verify end-to-end delivery
```

**Creating a subscription (raw HTTP):**

```bash
# 1. Discover
curl -fsS "$RS_URL/.well-known/oauth-protected-resource" | jq .capabilities.client_event_subscriptions

# 2. Create
TOKEN="$(pdpp token <provider-url>)"
curl -fsS -X POST "$RS_URL/v1/event-subscriptions" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"callback_url":"https://your-host/pdpp-webhook"}'
# → {"subscription_id":"...","secret":"whsec_...","status":"pending_verification"}
# Store the secret immediately — it is never returned again.
unset TOKEN
```

**Signature verification** (Standard Webhooks format):

```
webhook-id: <event-id>
webhook-timestamp: <unix-seconds>
webhook-signature: v1,<base64-hmac-sha256>
```

Compute `HMAC-SHA256(key=base64_decode(secret_without_prefix), msg="<webhook-id>.<webhook-timestamp>.<raw-body>")`.
Reject events where the timestamp is more than 5 minutes old.

**Secret rotation:** call `update_event_subscription(subscription_id, rotate_secret: true)`.
This is NOT idempotent — each call mints a new secret. Immediately capture and
update your callback handler.

**Operator console:** The owner can inspect all subscriptions and disable them at
`/dashboard/event-subscriptions`. Operators cannot create or re-enable
subscriptions — that is a client responsibility.

**Hard rules for subscriptions:**

- Capture the `whsec_` secret at creation time. If you lose it, rotate via
  `update_event_subscription`.
- Do not store the secret in prompts, logs, commits, or PR descriptions.
- Do not rely on event payloads for record bodies. Always fetch via §7.
- If you receive `pdpp.grant.revoked`, the subscription cannot be re-enabled.
  Request a new grant and create a fresh subscription.

### 10. Renew, revoke, or forget when done

- Token near expiry and the task continues → request a fresh grant. Do not introspect-then-extend; client tokens are not refreshable in the current reference.
- Task complete → revoke: `POST $AS_URL/grants/<grant-id>/revoke`.
- Project archived → delete `.pdpp/` and revoke any grants whose IDs you cached.

Revocation is cheap and auditable. Use it.

## Stop conditions (do not push past these)

- The user explicitly asks you to use their owner token. Acknowledge, but request the scoped grant instead and explain why. If they still insist, treat that as an owner/admin workflow outside this data-access skill; do not use an owner token as a workaround for routine scoped reads.
- A request would require a stream or field the existing grant doesn't cover, *and* the task can't be completed at narrower scope. Stop, request an upgrade, and present the new request to the owner.
- The AS or RS returns `invalid_token`, `insufficient_scope`, or `grant_revoked`. Stop. Report. Don't retry.
- You see a token in any output that will be persisted (a commit, a logged stdout, a Slack thread). Stop and tell the user; the token is now considered compromised and should be revoked.

## Examples

### Email summary

User: "Summarize emails from my landlord this week."

Don't grab all email. Build:

```json
{
  "authorization_details": [{
    "type": "https://pdpp.org/data-access",
    "source": {
      "kind": "connector",
      "id": "https://registry.pdpp.org/connectors/gmail"
    },
    "purpose_code": "assist.summarize",
    "purpose_description": "Summarize emails from <sender> for the past 7 days.",
    "access_mode": "single_use",
    "streams": [{ "name": "messages", "fields": ["from_email","from_name","subject","received_at","snippet"] }]
  }]
}
```

After approval, query `/v1/streams/messages/records?filter[from_email]=<sender>&filter[received_at][gte]=<7d-iso>&limit=50&order=desc`. Don't fetch full bodies until the summary needs them; request `expand=message_bodies` only when the grant covers the related stream, and follow `blob_ref.fetch_url` only for attachment blobs you actually surface.

### Finance triage

User: "Did anything weird hit my checking account this month?"

Use the exact finance connector id from `/v1/schema` (for example `https://registry.pdpp.org/connectors/ynab` or `https://registry.pdpp.org/connectors/usaa`), stream `transactions`, fields such as `date`, `amount`, `payee_name`/`description`, and `category_name`, scoped to the current month with stream `time_range` when the stream supports it. `purpose_code: "assist.review"`, `access_mode: "single_use"`. Don't request account numbers, routing numbers, or any field not needed for the answer.

### Coding history

User: "Draft my weekly status update from this week's engineering activity."

Use the data source that actually has the activity. Current first-party GitHub exposes `issues` and `pull_requests`, not a `commits` stream; request fields such as `repository_full_name`, `title`, `state`, `updated_at`, `merged_at`, `additions`, and `deletions`. If the user wants coding-agent history, prefer `https://registry.pdpp.org/connectors/claude-code` or `https://registry.pdpp.org/connectors/codex` streams that `/v1/schema` shows as available.

### Cross-connector assistant memory

User: "What did I tell you yesterday about the Acme launch?"

If a `claude-code` (or equivalent assistant-memory) connector exists, prefer it. Stream `conversations` filtered to `topic ~= "Acme"` and `started_at >= yesterday`. If it does not exist, do not improvise across email + chat + docs. Stop and ask the user where their assistant memory lives.

## Owner-readable purpose strings

The `purpose_description` ends up on the user's consent screen. Write each one for a non-protocol audience.

- Bad: `"Get records for analysis."`
- Bad: `"data_access scope=read"`
- Good: `"Read your last 30 days of GitHub issues and pull requests so I can draft a status update."`
- Good: `"Look up your Spotify listens from yesterday so I can recommend a new playlist."`

If you cannot write a one-sentence purpose the owner would approve at a glance, the request is too broad. Narrow it.
