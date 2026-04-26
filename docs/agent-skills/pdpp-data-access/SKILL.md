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

| Situation | Read |
| --- | --- |
| Designing a grant request (purpose, streams, retention) | `references/grant-design.md` |
| Querying records, search, blobs, changes, aggregations | `references/query-cookbook.md` |
| Anything secret-handling, cache, or refusal | `references/security.md` |
| The owner says no, the token expired, the call fails | `references/troubleshooting.md` |

The patterns in this skill are derived from PAR (RFC 9126), RAR (RFC 9396), DCR (RFC 7591), the device flow (RFC 8628, used only for the owner-token escape hatch), MCP's local-public-client guidance, and the local-cache UX of `gh auth`, AWS CLI SSO, and Google ADC. PDPP-specific extensions are flagged here when used.

## Hard rules

- **Do not ask for, use, or persist an owner bearer token** for routine data access. Owner tokens collapse least-privilege boundaries. The default agent path is a scoped client grant.
- **Do not write tokens into prompts, logs, shell history, transcripts, comments, commit messages, or PR descriptions.** Read tokens from the project cache only when you need to call PDPP, and never echo them.
- **Do not commit `.pdpp/`, `.env*`, or anything under it.** If you create the cache, ensure `.gitignore` excludes it.
- **Do not silently broaden access.** If the current grant cannot answer the task, request an explicit upgrade and explain to the owner why.
- **Do not invent endpoints.** Drive every request from `/v1/schema` capability flags, not from memory.
- **Do not retry an `invalid_token` or `insufficient_scope` response in a tight loop.** Stop, report, and ask for grant action.

## Core workflow

### 1. Discover before you do anything else

You need an AS URL and an RS URL. The user provides at least one. Resolve both via metadata:

```bash
# Given an RS URL:
curl -fsS "$RS_URL/.well-known/oauth-protected-resource" | jq .
# This returns the authorization-server URL and capability flags.

# Given an AS URL:
curl -fsS "$AS_URL/.well-known/oauth-authorization-server" | jq .
# This returns token, par, registration, device-authorization, and introspection endpoints.
```

Check `pdpp_token_kinds_supported` and the `pdpp_provider_connect_capabilities` array. If `cli_device_connect` or the registration endpoint is missing, fall back to `references/troubleshooting.md`.

### 2. Check the project cache before requesting a new grant

The project keeps an agent-scoped cache at `<repo>/.pdpp/`:

```text
.pdpp/
  agent-access.json          # non-secret: AS/RS URLs, project label
  clients/<client-id>.json   # non-secret: registered client metadata
  grants/<grant-id>.json     # non-secret: grant scope, expiry, source
  tokens/<grant-id>.token    # secret: opaque client token, mode 0600
```

If a `grants/*.json` exists whose `source`, `streams`, and `expiry` cover the current task, reuse it. Read the corresponding `tokens/<grant-id>.token` only when you make the actual HTTP call. Do not read it for any other reason.

If no usable grant exists, continue.

### 3. Register a project-local client (one-time per project)

If `clients/` is empty, register:

```bash
curl -fsS -X POST "$AS_URL/oauth/register" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $PDPP_INITIAL_ACCESS_TOKEN" \
  -d '{
    "client_name": "Claude Code · myproject",
    "token_endpoint_auth_method": "none"
  }'
```

`PDPP_INITIAL_ACCESS_TOKEN` is required only when the AS is configured to protect registration. Personal-deployment ASes often allow open registration; if the AS rejects with `invalid_request`, ask the owner once for an initial access token rather than escalating to an owner bearer token.

Save the `client_id` and the full registration response into `clients/<client_id>.json` (chmod 0600 the file). **Do not save any owner credential.** The registration response does not contain one.

### 4. Build a narrow grant request

A grant request goes to `POST /oauth/par`. It must say, in owner-readable language: which source, which streams, what fields/views, what time range, what retention, and *why*. See `references/grant-design.md` for how to choose each field. Minimum viable request:

```json
{
  "client_id": "<your-registered-client-id>",
  "client_display": {
    "name": "Claude Code · myproject",
    "context": "Reading the user's last 30 days of GitHub commits to draft a status update."
  },
  "authorization_details": [
    {
      "type": "https://pdpp.org/data-access",
      "connector_id": "github",
      "purpose_code": "assist.summarize",
      "purpose_description": "Summarize recent GitHub activity for the user.",
      "access_mode": "time_bounded",
      "streams": [
        { "name": "commits" }
      ]
    }
  ]
}
```

Notes:

- `purpose_description` is read by the owner. Write it as one sentence the owner would accept on a consent screen.
- Pick the smallest set of streams that can answer the current task. Adding fields later is cheap; explaining why you grabbed extra is expensive.
- `access_mode` should be `single_use` or `time_bounded` for one-shot tasks. Long-lived agents use `continuous` only when the user has explicitly asked for it.
- Pick `connector_id` (polyfill-style providers) **or** `provider_id` (native PDPP providers), never both. Use `/v1/schema` (after you have *any* token) or the AS metadata to learn which form applies.

Send it:

```bash
PAR_RESPONSE=$(curl -fsS -X POST "$AS_URL/oauth/par" \
  -H "Content-Type: application/json" \
  --data-binary @grant-request.json)
echo "$PAR_RESPONSE" | jq -r '.authorization_url'
```

You get back `{ request_uri, authorization_url, expires_in }`. Print the `authorization_url` to the user. **You cannot approve for them. Do not try.**

### 5. Relay the approval URL to the owner

Print the URL prominently. Examples of acceptable phrasing:

> "I need access to your GitHub commits to do this. Open <approval URL> and approve the request — it expires in 5 minutes. Reply 'approved' here when done."

Acceptable channels: terminal output, tmux pane, chat reply, your tool's UI surface. Never: shell history that contains the request_uri alone, log files, third-party services, anywhere the URL would persist past the owner's session.

### 6. Get the issued token after approval

The reference does not yet expose a public polling endpoint for PAR-staged grants. After the owner approves, get the token by either:

- (Preferred when available) Checking the cache the user's CLI wrote — many environments run a helper that captures the token at approval time and drops it at `tokens/<grant-id>.token`.
- (Fallback) Asking the user to paste the token once. Receive it via a single-message channel, write it to `tokens/<grant-id>.token` with mode 0600, and never repeat it.

If neither works, stop and report. Do not fall back to an owner bearer token.

### 7. Verify the grant before relying on it

Before issuing the first data call, introspect:

```bash
curl -fsS -X POST "$AS_URL/introspect" \
  -H "Content-Type: application/json" \
  -d "{\"token\": \"$(cat .pdpp/tokens/<grant-id>.token)\"}"
```

Confirm `active=true`, `pdpp_token_kind=client`, and that `scope`/`grant_json` matches what you requested. Persist the non-secret fields into `grants/<grant-id>.json`.

Then call `/v1/schema`:

```bash
curl -fsS "$RS_URL/v1/schema" -H "Authorization: Bearer $TOKEN"
```

This returns the connectors, streams, fields, and capabilities **this specific grant** can see. Build all subsequent queries off this response, not off memory.

### 8. Use the data efficiently

See `references/query-cookbook.md`. Quick map:

- "give me the last N items": `GET /v1/streams/<stream>/records?limit=N&order=newest`
- "show changes since cursor X": `GET /v1/streams/<stream>/records?changes_since=<cursor>` (when the schema declares `changes` capability)
- "find records matching free text": `GET /v1/search?q=…` or `GET /v1/search/hybrid?q=…` (when advertised)
- "fetch an attachment": follow `blob_ref.fetch_url` from the record body, never construct it
- "count or sum": `GET /v1/streams/<stream>/aggregate?…` (when advertised)

Default to filtered queries over full-table scans. If `/v1/schema` declares a filter or `expand[]` that answers the task, prefer it.

### 9. Renew, revoke, or forget when done

- Token near expiry and the task continues → request a fresh grant. Do not introspect-then-extend; client tokens are not refreshable in the current reference.
- Task complete → revoke: `POST $AS_URL/grants/<grant-id>/revoke`.
- Project archived → delete `.pdpp/` and revoke any grants whose IDs you cached.

Revocation is cheap and auditable. Use it.

## Stop conditions (do not push past these)

- The user explicitly asks you to use their owner token. Acknowledge, but request the scoped grant instead and explain why. If they insist, document the owner-token use in the response and proceed only with their direct confirmation.
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
    "connector_id": "gmail",
    "purpose_code": "assist.summarize",
    "purpose_description": "Summarize emails from <sender> for the past 7 days.",
    "access_mode": "single_use",
    "streams": [{ "name": "messages", "fields": ["from","subject","received_at","snippet"] }]
  }]
}
```

After approval, query `/v1/streams/messages/records?from=<sender>&since=<7d>&limit=50`. Don't fetch full bodies until the summary needs them; fetch via `blob_ref.fetch_url` only for messages you actually surface.

### Finance triage

User: "Did anything weird hit my checking account this month?"

Use `connector_id: "usaa"` (or whichever finance connector the user has), stream `transactions`, fields `posted_at`, `amount`, `merchant`, `category`, time-bounded to the current month. `purpose_code: "assist.review"`, `access_mode: time_bounded`. Don't request `account_number`, `routing_number`, or any field not needed for the answer.

### Coding history

User: "Draft my weekly status update from this week's commits."

`connector_id: "github"` (or `claude-code` if you want assistant memory), streams `commits` and optionally `pull_requests`, fields `repo`, `message`, `committed_at`, `additions`, `deletions`, time-bounded to 7 days. `purpose_code: "assist.summarize"`.

### Cross-connector assistant memory

User: "What did I tell you yesterday about the Acme launch?"

If a `claude-code` (or equivalent assistant-memory) connector exists, prefer it. Stream `conversations` filtered to `topic ~= "Acme"` and `started_at >= yesterday`. If it does not exist, do not improvise across email + chat + docs. Stop and ask the user where their assistant memory lives.

## Owner-readable purpose strings

The `purpose_description` ends up on the user's consent screen. Write each one for a non-protocol audience.

- Bad: `"Get records for analysis."`
- Bad: `"data_access scope=read"`
- Good: `"Read your last 30 days of GitHub commits so I can draft a status update."`
- Good: `"Look up your Spotify listens from yesterday so I can recommend a new playlist."`

If you cannot write a one-sentence purpose the owner would approve at a glance, the request is too broad. Narrow it.
