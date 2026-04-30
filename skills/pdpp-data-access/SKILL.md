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

Use the `pdpp connect` command when provider metadata advertises token completion as available. It is the intended CLI-first path for discovery, scoped grant approval, project-local cache layout, `.gitignore` hygiene, token storage, and token-use checks. Raw HTTP is a fallback, not the happy path.
The current beta command is published in metadata as:

```bash
npx -y @pdpp/cli@beta connect <provider-url>
```

Gating: if `pdpp_agent_discovery.cli.no_owner_token` is `false`, token completion is not safe to treat as a complete no-owner-token flow. Use the command as the generated source of truth, but report that this provider has not enabled completion yet. Do not switch to an owner bearer token.

`connect` creates an agent-scoped cache at `<repo>/.pdpp/` when the flow is enabled:

```text
.pdpp/
  agent-access.json          # non-secret: AS/RS URLs, project label
  clients/<client-id>.json   # non-secret: registered client metadata
  grants/<grant-id>.json     # non-secret: grant scope, expiry, source
  tokens/<grant-id>.token    # secret: opaque client token, mode 0600
```

If the CLI status shows a usable grant whose source, streams, and expiry cover the current task, reuse it. Read the token only at call time:

```bash
TOKEN="$(pdpp agent use <grant-id>)"
curl -fsS "$RS_URL/v1/schema" -H "Authorization: Bearer $TOKEN" | jq .
unset TOKEN
```

The CLI rejects missing, expired, and locally revoked grants. Do not bypass that by reading `.pdpp/tokens/` directly unless you are debugging the CLI itself.

### 2. Request the narrowest grant that can answer the task

If no usable grant exists, request one with an owner-readable purpose:

```bash
pdpp agent request \
  --connector-id "https://registry.pdpp.org/connectors/github" \
  --streams "issues,pull_requests" \
  --purpose "Read your recent GitHub issues and pull requests so I can draft a status update." \
  --access-mode single_use
```

Notes:

- `purpose_description` is read by the owner. Write it as one sentence the owner would accept on a consent screen.
- Pick the smallest set of streams that can answer the current task. Adding fields later is cheap; explaining why you grabbed extra is expensive.
- `access_mode` should be `single_use` for one-shot tasks. The reference consumes the grant at first token issuance, but the issued token remains usable for pagination and retries until token expiry or revocation. Long-lived agents use `continuous` only when the user has explicitly asked for it.
- Set one `source` object: `{ "kind": "connector", "id": "<registry URI>" }` for polyfill-style providers or `{ "kind": "provider_native", "id": "<provider id>" }` for native PDPP providers. Use the exact connector source id from `/v1/schema` or `/v1/connectors` (for example `https://registry.pdpp.org/connectors/github`), not a guessed short name.

Previously known as: older docs used top-level `connector_id` for connector sources and `provider_id` for native providers. Those names now map to `source.id` under the matching `source.kind`; do not send them as public request fields.

The command prints an approval URL and access summary. You cannot approve for the owner. Do not try.

### 3. Relay the approval URL to the owner

Print the URL prominently. Examples of acceptable phrasing:

> "I need access to your GitHub issues and pull requests to do this. Open <approval URL> and approve the request — it expires in 5 minutes. Reply 'approved' here when done."

Acceptable channels: terminal output, tmux pane, chat reply, your tool's UI surface. Never: shell history that contains the request_uri alone, log files, third-party services, anywhere the URL would persist past the owner's session.

### 4. Store the approved token

The current reference has no public AS polling endpoint for PAR-staged client grants. `pdpp agent wait` deliberately polls only the local cache; it does **not** contact the AS.

After the owner approves, either another trusted local helper writes the token into `.pdpp/`, or the owner provides the token shown on the consent page once. Prefer stdin/env over putting the token in shell history:

```bash
PDPP_CLIENT_TOKEN="$(cat)" pdpp agent store --grant-id <grant-id>
# paste token, then Ctrl-D
```

If you are waiting in another pane:

```bash
pdpp agent wait --grant-id <grant-id> --timeout-seconds 300
```

If neither path produces a token, stop and report. Do not fall back to an owner bearer token.

### 5. Verify the grant before relying on it

Before issuing the first data call, use the CLI status and schema surface:

```bash
pdpp agent status
TOKEN="$(pdpp agent use <grant-id>)"
curl -fsS "$RS_URL/v1/schema" -H "Authorization: Bearer $TOKEN" | jq .
unset TOKEN
```

This returns the connectors, streams, fields, and capabilities **this specific grant** can see. Build all subsequent queries off this response, not off memory.

### 6. Missing-CLI fallback

If the CLI is unavailable locally, prefer the generated npm command before raw HTTP:

```bash
npx -y @pdpp/cli@beta connect <provider-url>
```

If provider metadata reports `pdpp_agent_discovery.cli.no_owner_token: false`, stop after discovery and report that public token completion is unavailable on that provider. Only then, if the task requires manual debugging, follow the same workflow manually: discover AS/RS metadata, register a public client, stage a PAR request, relay the `authorization_url`, store the approved client token under `.pdpp/`, introspect it, then call `/v1/schema`. Do not use raw HTTP to widen scope, skip approval, or cache owner tokens. See `references/troubleshooting.md` before attempting this path.

### 7. Use the data efficiently

See `references/query-cookbook.md`. Quick map:

- "give me the last N items": `GET /v1/streams/<stream>/records?limit=N&order=desc`
- "show changes since cursor X": `GET /v1/streams/<stream>/records?changes_since=<cursor>` (bootstrap with `changes_since=beginning`)
- "find records matching free text": `GET /v1/search?q=…` or, when the server advertises it, `GET /v1/search/hybrid?q=…` (experimental hybrid retrieval extension; scope with repeated `streams=` or `streams[]=` values, not CSV)
- "fetch an attachment": follow `blob_ref.fetch_url` from the record body, never construct it
- "count or sum": `GET /v1/streams/<stream>/aggregate?metric=count` or `metric=sum&field=<field>` (when advertised)

Default to filtered queries over full-table scans. If `/v1/schema` declares a filter or `expand[]` that answers the task, prefer it.

### 8. Renew, revoke, or forget when done

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
