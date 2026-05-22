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

- "give me the last N items": `GET /v1/streams/<stream>/records?limit=N&order=desc`
- "show changes since cursor X": `GET /v1/streams/<stream>/records?changes_since=<cursor>` (bootstrap with `changes_since=beginning`)
- "find records matching free text": `GET /v1/search?q=…` or, when the server advertises it, `GET /v1/search/hybrid?q=…` (experimental hybrid retrieval extension; scope with repeated `streams=` or `streams[]=` values, not CSV)
- "fetch an attachment": follow `blob_ref.fetch_url` from the record body, never construct it
- "count or sum": `GET /v1/streams/<stream>/aggregate?metric=count` or `metric=sum&field=<field>` (when advertised)

Default to filtered queries over full-table scans. If `/v1/schema` declares a filter or `expand[]` that answers the task, prefer it.

### 8. Optional: MCP adapter over the same scoped token

If your harness supports the [Model Context Protocol](https://modelcontextprotocol.io/),
you can wrap the same scoped client token in an MCP stdio server instead of issuing
raw HTTP requests. The adapter is a thin read-only client of the RS — every tool
forwards to an existing `/v1/*` endpoint under the cached scoped token. There are
no new credentials, scopes, or wire contracts.

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
adapter exposes `schema`, `list_streams`, `query_records`, `search`, and
`fetch_blob` tools plus the `pdpp://stream/{name}` resource template, all backed
by the RS endpoints described in §7.

Constraints (these mirror the hard rules above):

- **stdio only.** Hosted/Streamable HTTP is intentionally out of scope; a separate
  OpenSpec change is required to add it.
- **No owner credentials.** The adapter refuses `PDPP_OWNER_TOKEN` and other
  owner bearer tokens.
- **No grant issuance.** If the cache is empty or the token is invalid, the
  adapter surfaces an MCP error directing the operator to run `pdpp connect`.
- **No new query semantics.** Unknown query arguments are rejected rather than
  silently dropped.
- **Read-only.** No tool mutates data, triggers collection, or modifies grants.

The MCP adapter is a convenience for MCP-aware harnesses; the raw-HTTP path in
this skill remains the canonical interface and the source of truth for query
shapes. If `@pdpp/mcp-server` is not yet published to npm, consume it from the
in-repo workspace package or use the raw-HTTP path.

### 9. Renew, revoke, or forget when done

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
