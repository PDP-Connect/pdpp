# Owner-agent control surface reference

This is the reference for the owner-agent **control plane** — discovering what
control actions a reference instance supports, listing and labeling connection
instances, and initiating a new connection as a typed intent. Read `SKILL.md`
and `daisy-runbook.md` first; `sync.md` covers reading data once a connection
exists. Everything here assumes a valid owner-level bearer read at call time
from `~/applications/daisy/.pi/agent/pdpp-owner-agent.json` and never echoed.

The control plane is owner-bearer `/v1/owner/*` REST. It is **not** `/mcp`, and
it is not for routine grant-scoped agents (see "Boundary" below). A trusted owner
agent uses it to help an operator manage current and future connections; it never
bypasses a provider login, upload, or device-enrollment step.

## Principle: discover capabilities, never guess routes

The reference projects every supported owner-agent control action from one
server-side catalog. Read the catalog instead of probing routes: a non-supported
action is named explicitly with a typed `status`, so you never hit a surprise 404.

`pdpp owner-agent control` is the one-shot, non-secret way to do this. It reads
the capability document and the connection listing and prints them without ever
echoing the bearer:

```bash
pdpp owner-agent control --credential-file ~/applications/daisy/.pi/agent/pdpp-owner-agent.json
```

Output is non-secret only: action families with their `status`
(`supported` / `owner_mediated` / `unsupported`), the method+URL for supported
families, and each configured connection's `connection_id`, connector, and
label/label-needed state. The bearer is sent as an `Authorization` header and is
never printed.

The same two surfaces are available directly when you need the raw JSON:

```bash
TOKEN="$(jq -r '.access_token' "$HOME/applications/daisy/.pi/agent/pdpp-owner-agent.json")"
# Capability document — the single source of truth for what this build supports:
curl -fsS "$RS_URL/v1/owner/control" -H "Authorization: Bearer $TOKEN" \
  | jq '.actions[] | {family, status, method, url}'
unset TOKEN
```

`actions[].status` is the branch point:

- `supported` — this build serves the action over the owner-agent bearer surface;
  `method` + `url` are populated. Call it.
- `owner_mediated` — the operation exists but only on the browser owner-session
  surface today (for example run-now). Tell the operator; do not fabricate a route.
- `unsupported` — no route in this build. The `reason` names why. Do not retry.

## Listing and labeling connection instances

A connector **template** (`amazon`) is not a connection **instance**. One
template can have several instances — "the owner personal" and a future "Shared
Amazon". Always operate on the instance by its stable `connection_id`, never on
the connector type.

```bash
TOKEN="$(jq -r '.access_token' "$HOME/applications/daisy/.pi/agent/pdpp-owner-agent.json")"
curl -fsS "$RS_URL/v1/owner/connections" -H "Authorization: Bearer $TOKEN" \
  | jq '.data[] | {connection_id, connector_id, display_name, label_status, status}'
unset TOKEN
```

Each row carries:

| Field | Meaning |
| --- | --- |
| `connection_id` | the stable selector for every instance-scoped action (alias: deprecated `connector_instance_id`) |
| `connector_id` / `connector_key` | the connector type identity (e.g. `amazon`) |
| `display_name` | the stored label — may be a fallback placeholder |
| `label_status` | `owner_set` (owner-meaningful) or `fallback` (label-needed) |
| `supported_actions[]` | instance-scoped actions for this exact connection, from the same catalog |

`label_status: fallback` means the `display_name` is a storage-layer placeholder
(for example a registry URL), not a name the operator chose. Treat it as
**label-needed**: surface it as needing a label, do not present it as a final
name. Give it an owner-meaningful label with the `rename_connection` action:

```bash
TOKEN="$(jq -r '.access_token' "$HOME/applications/daisy/.pi/agent/pdpp-owner-agent.json")"
curl -fsS -X PATCH "$RS_URL/v1/owner/connections/<connection_id>" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"display_name": "the owner personal"}' | jq '{connection_id, display_name, label_status}'
unset TOKEN
```

After a rename the row reports `label_status: owner_set`, and a public/read
listing agrees on the same `connection_id` and `display_name`. With two Amazon
instances labeled `the owner personal` and `Shared Amazon`, a later instance-scoped
action (rename, schedule pause/resume) addresses the right one by `connection_id`.

## Initiating a new connection as a typed intent

New connections are created as an **intent**, not a silent headless login.
`POST /v1/owner/connections/intents` returns an auditable workflow object with a
typed `next_step`; it never marks a connection active and never performs the
provider step for you.

```bash
TOKEN="$(jq -r '.access_token' "$HOME/applications/daisy/.pi/agent/pdpp-owner-agent.json")"
curl -fsS -X POST "$RS_URL/v1/owner/connections/intents" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"connector_id": "<connector>", "display_name": "Shared Amazon"}' \
  | jq '{connector_modality, connection_active, next_step: .next_step.kind, reason: .next_step.reason}'
unset TOKEN
```

`connection_active` is always `false` on an intent. Branch on `next_step.kind`:

- `enroll_local_collector` — a proven local-collector connector (`claude-code`,
  `codex`). The response carries a single-use `enrollment_code` and an
  `enroll_endpoint`. Hand the `enrollment_code` to the operator's local collector
  machine-to-machine; the collector runs the connector and any provider login
  **locally**. Do not print the `enrollment_code` to chat or logs — treat it like
  the bearer. The connection materializes only when the device enrolls and ingests.
- `unsupported` — browser-bound (`amazon`, `chase`), API/network-only (`gmail`,
  `github`), or unknown connectors in this build. The `reason` names the exact
  missing primitive. Relay the reason to the operator and stop; do not attempt to
  fake the connection or drive the provider yourself.
- `open_url` / `complete_browser_assistance` / `upload_file` — reserved in the
  contract for future primitives this build does not yet emit. If you see one,
  follow the typed step; do not invent it.

For the **Amazon second-account** acceptance case, the honest path today is:
initiate the intent, receive `unsupported` with the reason naming the browser-
collector primitive gap, and report that owner-mediated next step to the operator.
That is the correct stopping point until the browser-collector enrollment
primitive ships (see the OpenSpec change `add-owner-agent-control-surface`,
"Resolved: Amazon second-account implementation packet").

## Boundary: owner-agent control vs. scoped grants / MCP

This control plane is for the **trusted local owner agent only**. Keep the two
profiles distinct:

- **Trusted local owner agents** (Daisy/Simon-style, running on the operator's
  machine, explicitly authorized to act as the operator) MAY use the owner-bearer
  `/v1/owner/*` control surface and owner-bearer `/v1/*` reads.
- **Routine chat-hosted agents, external clients, and task-scoped assistants**
  MUST NOT use an owner bearer. They use a scoped PDPP client grant over `/mcp` or
  scoped `/v1/*`, via the `pdpp-data-access` skill. A scoped grant is least-
  privilege and per-task; an owner bearer collapses that boundary.
- **`/mcp` rejects owner bearers by design.** The advisory onboarding block states
  `mcp_owner_bearer_rejected: true`. Sending an owner bearer to `/mcp` is an error,
  not a fallback. If you catch yourself about to do it, stop and use owner-bearer
  `/v1/*` REST instead.

If you are not certain you are the authorized local owner agent, you are a
grant-scoped agent: stop and use `pdpp-data-access`.

## Secret hygiene on the control plane

- Never print the owner bearer. Read it at call time, send it as an
  `Authorization` header, and refer to the credential by its revocation handle.
- Never print a connection-intent `enrollment_code`. It is single-use enrollment
  material; hand it to the local collector, not to chat or logs.
- Never print owner-session cookies, webhook signing secrets (`whsec_`), or owner
  record bodies you were only asked to count or summarize.
- `pdpp owner-agent control` and `pdpp owner-agent status` are safe by
  construction: they emit only non-secret capability, connection, and
  introspection metadata.
