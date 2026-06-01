---
name: pdpp-owner-agent
description: Use ONLY when you are a trusted local owner agent that the operator has explicitly authorized to act as themselves against their own PDPP reference instance — for example a local assistant such as Daisy running on the owner's machine. This profile uses an owner-level REST/control-plane credential obtained through browser-mediated owner approval, and teaches token-efficient initial and incremental sync of all current and future owner data. This is owner-level local automation, not the default agent path. Routine third-party, coding-agent, and task-scoped assistants MUST use the grant-scoped pdpp-data-access skill instead.
---

# PDPP Owner-Agent Onboarding

You are a **trusted local owner agent**. The operator runs their own PDPP reference
instance and has explicitly decided to let you act as themselves against it — read
any of their connected data, now and in the future, on their own machine. This is a
deliberate local-admin mode, not the default.

There are two distinct agent profiles on a PDPP reference instance. Pick the right
one before you do anything:

| Profile | Who | Credential | Transport | Skill |
| --- | --- | --- | --- | --- |
| **Grant-scoped agent** | external clients, coding agents, task-scoped assistants | scoped PDPP client grant (per task, per source) | `/mcp` or scoped `/v1/*` | `pdpp-data-access` |
| **Trusted owner agent** | a local agent the operator authorizes to act as themselves | owner-level REST/control-plane bearer, after explicit owner approval | owner-bearer `/v1/*` REST only | this skill |

**If you are not certain you are the trusted local owner agent the operator
authorized, you are a grant-scoped agent.** Stop and use `pdpp-data-access`. Owner
credentials collapse least-privilege boundaries; they are correct only for this
narrow profile.

This skill has four jobs:

1. Start you from an entrypoint URL and let you discover the owner-agent onboarding
   surfaces without guessing routes.
2. Get the operator to approve owner-level access in a browser — without anyone
   pasting bearer material into chat.
3. Store the resulting owner credential in a local credential target under restrictive
   permissions, and never echo it.
4. Maintain a token-efficient local view of all current and future owner data through
   metadata-first discovery, cursors, and incremental sync.
5. When the operator asks, manage connections through the typed control plane: discover
   supported actions, list and label connection instances, and initiate new connections as
   typed, owner-mediated intents — without ever bypassing a provider step.

The companion runbook in `references/daisy-runbook.md` walks the end-to-end flow from
an entrypoint URL through initial and incremental sync. `references/sync.md` is the
deeper reference for query shapes, cursors, and the callback-vs-polling decision.
`references/control-surface.md` covers the owner-agent control plane — discovering
supported control actions, listing and labeling connection instances, and initiating
a new connection as a typed intent — for when the operator asks you to *manage*
connections, not just read data.

## Hard rules

- **You are owner-level local automation, not an external client.** Never present an
  owner bearer as appropriate for `/mcp`, for external MCP clients, or for routine
  task-scoped agents. `/mcp` rejects owner bearers by design; that is correct.
- **Never ask the operator to paste a bearer token into chat or a terminal.** Approval
  happens in a browser/dashboard owner-authenticated flow. The credential is written to
  a local credential target. You read it at call time and never echo it.
- **Never print the bearer.** Status output prints only non-secret metadata: token kind,
  client id / subject, expiry, and the revocation handle. Refer to the credential by its
  revocation handle, never by value.
- **Owner credentials are REST/control-plane credentials.** Use them only on the
  owner-bearer-supported `/v1/**` REST routes. Do not attempt to use them over `/mcp`.
- **Drive every request from discovered metadata and schema.** Prefer the
  discovered `schema_compact_endpoint` for token-efficient metadata refreshes,
  use `schema_endpoint` only when you need exhaustive JSON Schema, and do not
  invent endpoints, streams, fields, or filters from memory.
- **Be incremental.** "All current and future data" is only practical if you store
  cursors and sync deltas. A full rescan on every question is not token-efficient and is
  not the owner-agent pattern. See §4 and `references/sync.md`.
- **Respect revocation.** If introspection reports the credential inactive or a call
  returns revoked/inactive, stop. The operator revoked you. Do not re-request silently.

## Core workflow

### 1. Start from the entrypoint URL and discover the onboarding profile

You are given an entrypoint URL — the operator's reference instance origin. Discover the
owner-agent onboarding surfaces before doing anything else. The reference advertises an
advisory `pdpp_owner_agent_onboarding` block from the cold-start root pointer and from
protected-resource metadata **only when owner-agent onboarding is safely configured**:

```bash
curl -fsS "$ENTRYPOINT/.well-known/oauth-protected-resource" \
  | jq '.pdpp_owner_agent_onboarding'
# or the cold-start root pointer:
curl -fsS "$ENTRYPOINT/" | jq '.pdpp_owner_agent_onboarding'
```

The advisory block, when present, names every surface you need by field, so you never guess
a route: `resource` (RS origin) and `authorization_server` (AS issuer); the
`device_authorization_endpoint`, `owner_approval_url`, and `token_endpoint` for browser
approval; `schema_compact_endpoint`, `schema_endpoint`, `streams_endpoint`, and
`query_base` for reads; `introspection_endpoint` and `revocation_path_template` for lifecycle; and
`event_subscriptions_endpoint` for push delivery. `mcp_owner_bearer_rejected: true` states
that `/mcp` is not the owner-agent transport.

If the block is **absent**, this deployment does not support trusted owner-agent
onboarding (it may be misconfigured, disabled, or behind an untrusted forwarded origin).
Do not fall back to scraping owner pages for a bearer. Report that owner-agent onboarding
is unavailable on this deployment and stop. Ordinary grant-scoped access via
`pdpp-data-access` remains available where the grant-scoped workflow is advertised.

### 2. Get browser-mediated owner approval (device authorization)

Onboarding is an RFC 8628 device-authorization flow. POST the
`device_authorization_endpoint` to start it; the response carries a `device_code` and a
`verification_uri_complete` — the `owner_approval_url` with a `user_code` attached
(`<RS>/device?user_code=...`). Relay that approval URL prominently — terminal, your tool's
UI, or a chat reply — and wait. The operator approves in an owner-authenticated browser
context; you cannot approve on their behalf. Never relay the URL anywhere it would persist
past the operator's session.

After the operator approves, poll the `token_endpoint` with
`grant_type=urn:ietf:params:oauth:grant-type:device_code` and the `device_code`, honoring
`authorization_pending` / `slow_down` (keep polling), `access_denied` (denied — stop), and
`expired_token` (start over). On success the response contains the owner `access_token`;
write it to the local credential target (see §3) and surface only non-secret status.
`pdpp owner-agent onboard <entrypoint>` performs all of this without printing the bearer.

**Do not ask the operator to copy a bearer string out of the dashboard and paste it to
you.** A dashboard bearer-copy path may exist for low-level debugging; it is not the
onboarding path for this profile.

### 3. Store the credential locally, read it at call time

The credential lands in the operator's local credential target with restrictive file
permissions. For Daisy, the first supported target is:

`~/applications/daisy/.pi/agent/pdpp-owner-agent.json`

The file is JSON and contains the bearer as `access_token`; it must be written with mode
`0600`.

Read it only at the moment of a call, and never echo it:

```bash
TOKEN="$(jq -r '.access_token' "$HOME/applications/daisy/.pi/agent/pdpp-owner-agent.json")"
curl -fsS "$RS_URL/v1/schema" -H "Authorization: Bearer $TOKEN" | jq .
unset TOKEN
```

When showing the operator "what access do I have?", print the token kind, subject/client
id, expiry, and revocation handle — never the bearer.

### 4. Sync efficiently: metadata first, then incremental

This is the heart of the owner-agent profile. Do not rescan everything to answer each
question. See `references/sync.md` for the full reference; the shape is:

1. **Metadata first.** Fetch `schema_compact_endpoint` (or
   `/v1/schema?view=compact` when the endpoint is absent), then enumerate
   `/v1/streams` and cache the
   catalog before any record read. `/v1/streams` returns a list envelope
   (`{ "object": "list", "has_more": ..., "data": [...] }`); the stream entries are under
   **`data`**, not a top-level `streams` key. Build all queries off that response.
2. **Attribute by `connection_id`.** In multi-connection deployments, pass the stable
   `connection_id` query parameter to scope a read and attribute records. Store sync state
   per stream **and** per connection.
3. **Initial sync, bounded.** Page through each stream with the declared pagination
   cursor (`next_cursor` while `has_more`) and field projection. Request only the fields
   you need.
4. **Incremental sync.** On refresh, prefer `changes_since=<stored cursor>` (bootstrap
   with `changes_since=beginning`), declared filters, and pagination over rescanning all
   records. Records also arrive under `data`; persist the returned `next_changes_since`
   cursor per stream/connection.
5. **Periodic metadata refresh.** Re-fetch compact schema and stream metadata on a cadence so
   newly added streams and connections become visible without guessing.
6. **Blobs by reference.** Fetch attachment bytes only when needed, by following
   `blob_ref.fetch_url` — never construct blob URLs.

### 5. Future updates: subscriptions only with a durable HTTPS receiver

To stay current you can either **poll** with stored cursors or receive **push** delivery
via event subscriptions. Choose based on whether you have a durable, reachable,
valid-TLS HTTPS callback receiver:

- **You have a durable valid-TLS HTTPS receiver** → you MAY create event subscriptions
  with the registered owner-agent bearer where the reference advertises support, for
  low-latency notification. Create/rotate returns a one-time `whsec_` signing secret in the
  response body — persist it securely at that moment; the server stores only a hash and
  will not return it again (rotate to replace a lost one). Event payloads carry source
  identity plus a `changes_since` cursor, never record bodies; fetch changed records via §4.
- **You do not** (most local agents, including a laptop-resident Daisy with no public
  callback) → **use cursor polling with backoff**, plus periodic schema refresh. Do not
  attempt callback delivery to an unreachable local endpoint.

See `references/sync.md` for the full callback-vs-polling decision, backoff guidance, and
the subscription lifecycle.

### 6. Manage connections through the typed control plane

When the operator asks you to *manage* connections — not just read data — use the
owner-bearer control plane at `/v1/owner/*`. See `references/control-surface.md` for the
full reference. The shape:

1. **Discover capabilities, never guess routes.** Run
   `pdpp owner-agent control` (or read `GET /v1/owner/control`). It lists every control
   action family with a typed `status` (`supported` / `owner_mediated` / `unsupported`)
   and, for supported families, the method + URL. Branch on `status`; never probe a route
   the catalog did not mark `supported`.
2. **List connection instances, not just templates.** `GET /v1/owner/connections` returns
   each configured instance with its stable `connection_id`, connector identity, and
   `label_status`. A connector template (`amazon`) is not a connection instance; operate
   on the instance by `connection_id`.
3. **Label what needs labeling.** A row with `label_status: fallback` is label-needed —
   the `display_name` is a storage placeholder, not an owner-chosen name. Surface it as
   needing a label and set one with `rename_connection`
   (`PATCH /v1/owner/connections/{connection_id}`) so multi-connection deployments stay
   addressable by owner-meaningful names like `the owner personal` / `Shared Amazon`.
4. **Initiate new connections as a typed intent, never a silent login.**
   `POST /v1/owner/connections/intents` returns a typed `next_step` and never marks a
   connection active. `enroll_local_collector` hands a single-use `enrollment_code` to the
   operator's local collector (never print it); `unsupported` names the missing primitive
   and is the honest stopping point (this is the Amazon second-account case today). You
   never perform the provider login, upload, or device enrollment step yourself.

Every control mutation is audited server-side by actor kind, client id/name, target
`connection_id`, and outcome — without logging the bearer. Keep your output non-secret to
match: capabilities, connection ids, and labels only.

## Stop conditions

- The `pdpp_owner_agent_onboarding` advisory block is absent → onboarding unavailable.
  Report and stop; do not improvise an owner bearer.
- Introspection reports the credential inactive, or a call returns revoked/inactive →
  the operator revoked you. Stop; do not re-request silently.
- You are about to send the owner bearer to `/mcp` → stop. That is the grant-scoped
  client transport and will reject owner bearers. Use owner-bearer `/v1/*` REST instead.
- You catch yourself about to print, log, commit, or relay the bearer value → stop. Refer
  to it by revocation handle only. The same rule applies to a connection-intent
  `enrollment_code`, owner-session cookies, and webhook signing secrets (`whsec_`): hand
  them machine-to-machine, never to chat or logs.
- A control action's catalog `status` is `owner_mediated` or `unsupported` → do not probe
  a route or fake the result. Relay the typed reason to the operator and stop.
- You are not certain you are the authorized local owner agent → stop and use
  `pdpp-data-access` (grant-scoped) instead.

## Relationship to `pdpp-data-access`

`pdpp-data-access` is the default and remains correct for every ordinary agent: it forbids
owner bearers, requests scoped client grants, caches them project-locally, and uses `/mcp`
or scoped `/v1/*`. This skill does **not** weaken that guidance. It exists only because a
single trusted local agent, acting as the operator on the operator's own machine, is a
different trust boundary than an external client. If in doubt, you are an external client.
