# Grant Design

The PDPP grant request is the contract you offer the owner. Get it right and you can re-use the resulting token confidently. Get it wrong and you've either over-asked (owner denies) or under-asked (owner approves but you can't answer the task without re-asking).

## Structure of `authorization_details[]`

Each entry binds the grant to one source. Cross-source tasks need multiple entries (or, more often, multiple grants). One entry has:

| Field | Meaning | Common values |
| --- | --- | --- |
| `type` | Grant family | `"https://pdpp.org/data-access"` for read access |
| `source` | Which source | `{ "kind": "connector", "id": "https://registry.pdpp.org/connectors/github" }` or `{ "kind": "provider_native", "id": "northstar_hr" }` |
| `purpose_code` | Coarse intent | `assist.summarize`, `assist.review`, `assist.search`, `assist.draft`, `assist.export` |
| `purpose_description` | Owner-readable why | One sentence, plain English, scoped to the task |
| `access_mode` | Access pattern | `single_use`, `continuous` |
| `streams[]` | Streams + fields | `[{ "name": "pull_requests", "fields": ["repository_full_name","title","updated_at"] }]` |
| `streams[].time_range` | When applicable | `{ "since": "2026-04-01T00:00:00Z" }` or relative window |

Set exactly one source object. The reference will reject legacy top-level `connector_id` or `provider_id` fields in public requests. For connector-backed access, use the exact connector source `id` value from `/v1/schema` or `/v1/connectors`; do not guess short aliases like `github`.

## Choosing each field

### Source

- Use the *narrowest* source that contains the data. If both `gmail` and a generic `mail` connector exist, prefer the specific one — its manifest is usually tighter.
- A "search across all my data" intent is almost never legitimate as one grant. Split the task by source.
- Older docs may call connector sources `connector_id` and native sources `provider_id`; those names now map to `source.id` under the matching `source.kind`.

### `purpose_code`

Stable, machine-readable. The reference accepts any string today, but you should pick from the assistant-task family so the consent UI can group them sensibly:

- `assist.summarize` — produce a digest the user reads.
- `assist.review` — flag/triage items for the user.
- `assist.search` — find specific items the user named.
- `assist.draft` — produce content the user will edit and send.
- `assist.export` — copy data into a user-owned destination they will use elsewhere.

Avoid `assist.train`, `assist.export.third_party`, `assist.improve_model` etc. They imply retention or third-party flow that this skill does not support and that the consent UI cannot honestly approve.

### `purpose_description`

Read like a UI label. One sentence. Concrete subject. Concrete time bound. Concrete output.

- ✅ "Summarize last week's GitHub issues and pull requests in the `acme/api` repo so I can draft your weekly update."
- ✅ "Find the Spotify track you played the most last month."
- ❌ "Need data for analysis." (too vague)
- ❌ "Get all messages." (no scope)
- ❌ "Train embeddings for memory." (out of scope; do not request)

### `access_mode`

| Mode | Use when | Notes |
| --- | --- | --- |
| `single_use` | One task, bounded retrieval session | The grant is consumed at first token issuance. The issued token remains usable for pagination, retries, and resumable reads until token expiry or revocation. Safest default. |
| `continuous` | The user explicitly asked for an ongoing assistant | Long-lived or recurring access until expiry or revocation. The consent UI must show this clearly. |

If you don't know, pick `single_use`. Current PDPP core keeps grant lifetime (`expires_at`) separate from access pattern (`access_mode`); do not invent a `time_bounded` access mode. A short-lived non-single-use grant is a protocol-candidate feature, not the reference happy path.

### `streams[]`

This is where most agents over-ask. For each stream:

- Set `name` to a stream the user's connector actually exposes (`/v1/schema` is authoritative).
- Set `fields` to the smallest set that answers the task. If you know you only need `from`, `subject`, `received_at`, list those three. Don't expand to `["*"]` because it's convenient.
- If the stream supports time filters, include `time_range` with `since` and `until` ISO timestamps. Owners are far more comfortable approving a windowed grant than an open one.

If you need a relationship (e.g., Gmail messages with message bodies), prefer the connector's declared `relationships[]` and request `expand[]` capability via `/v1/schema` rather than asking for a second stream.

### What *not* to put in the grant

- `client_secret` — you are using `token_endpoint_auth_method: "none"` for public clients; there is no secret.
- Owner email, owner subject id, or any owner identifier — the AS resolves the owner from the session.
- Free-form retention policies (`"keep_for_days": 90`). The reference does not honor them today; including them gives a false sense of control. If the user wants retention, that's a project-side rule, not a grant field.

## Patterns

### Cross-stream task on one source

GitHub issues + PRs:

```json
{
  "authorization_details": [{
    "type": "https://pdpp.org/data-access",
    "source": {
      "kind": "connector",
      "id": "https://registry.pdpp.org/connectors/github"
    },
    "purpose_code": "assist.summarize",
    "purpose_description": "Summarize my last 7 days of GitHub issues and pull requests on acme/api.",
    "access_mode": "single_use",
    "streams": [
      { "name": "issues", "fields": ["number","repository_full_name","title","state","updated_at"], "time_range": { "since": "<7d>" } },
      { "name": "pull_requests", "fields": ["number","repository_full_name","title","merged_at","state","updated_at"], "time_range": { "since": "<7d>" } }
    ]
  }]
}
```

### Cross-source task

Two grants, two requests, two approvals. The owner sees each one explicitly.

```text
Grant A: source={kind: connector, id: https://registry.pdpp.org/connectors/gmail}, streams=[messages], time_range=last 24h
Grant B: source={kind: connector, id: https://registry.pdpp.org/connectors/ical}, streams=[events], time_range=next 24h
```

Don't try to bundle these into one `authorization_details[]` array entry — the reference treats one entry as one source binding.

### Upgrade flow

Existing grant covers `issues`. New task needs `pull_requests`. Don't request a brand-new full-source grant. Build a smaller request that names only the *additional* streams and present it as an upgrade in the purpose description:

```json
"purpose_description": "Extend the existing GitHub issue-summary grant with PR data so the digest can include reviewer assignments."
```

Two grants now exist, the user can revoke the upgrade alone, and the audit trail stays clean.

## Estimating "is this too broad?"

Quick sniff test before you POST:

- Could a careful user explain in their own words what you'll see? If not, the request is unclear.
- Would the user expect to need to revoke this? If yes, prefer `single_use`. Use `continuous` only when ongoing access is part of the user’s explicit request.
- Does the request name fields you won't use? Drop them.
- Does the time range reach further back than the task needs? Tighten it.
- Would you be comfortable if the user shared this consent screen with a friend? If not, narrow it.
