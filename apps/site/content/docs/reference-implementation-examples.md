---
title: "Reference Implementation Examples"
description: "Current end-to-end examples from the live PDPP reference implementation. Not normative protocol documentation."
---

These examples document the **current reference implementation**, not a hypothetical future deployment. They show the real surfaces exposed by `reference-implementation/server`, `reference-implementation/runtime`, and `reference-implementation/cli` today.

If you want the public explainer and run/deploy posture first, start with [/reference](/reference). If you want the detailed implementation notes, continue to [/docs/reference-implementation](/docs/reference-implementation).

Two boundaries matter when reading them:

- Client requests are staged through `POST /oauth/par`, then approved through the current consent shell at `GET /consent?request_uri=...` and `POST /consent/approve`.
- Owner self-export is a separate OAuth device flow using `POST /oauth/device_authorization`, `POST /device/approve`, and `POST /oauth/token`.

Two things remain deliberately out of scope in these examples:

- a generic third-party authorization-code redirect flow

The current reference proves request staging, public-client self-registration, consent, issued grants, owner self-export, and honest native-versus-polyfill source identity.

## Example 1: Longview requests compensation data from Northstar HR

This is the native-provider path. Longview requests compensation records from `Northstar HR`, so the request identifies the source with `source: { kind: "provider_native", id: "northstar_hr" }`.

### Step 1: Longview stages the request through PAR

```http
POST /oauth/par
Content-Type: application/json

{
  "client_id": "longview_planning_v1",
  "client_display": {
    "name": "Longview",
    "uri": "https://longview.example",
    "policy_uri": "https://longview.example/privacy",
    "tos_uri": "https://longview.example/terms"
  },
  "authorization_details": [
    {
      "type": "https://pdpp.org/data-access",
      "source": {
        "kind": "provider_native",
        "id": "northstar_hr"
      },
      "purpose_code": "https://longview.example/purpose/career-move-planning",
      "purpose_description": "Compare salary, equity, benefits, and tax tradeoffs before a career move",
      "access_mode": "continuous",
      "retention": { "duration": "P90D", "on_expiry": "delete" },
      "streams": [
        { "name": "pay_statements", "necessity": "required", "view": "summary" },
        { "name": "equity_grants", "necessity": "required", "view": "summary" },
        { "name": "benefits_enrollments", "necessity": "optional", "view": "summary" }
      ]
    }
  ]
}
```

Reference response:

```json
{
  "request_uri": "urn:pdpp:pending-consent:dc_4f5f7c0f9b6a4f31",
  "authorization_url": "http://localhost:7662/consent?request_uri=urn%3Apdpp%3Apending-consent%3Adc_4f5f7c0f9b6a4f31",
  "expires_in": 300
}
```

### Step 2: The user reviews the consent shell

The authorization server renders the request with:

```http
GET /consent?request_uri=urn%3Apdpp%3Apending-consent%3Adc_4f5f7c0f9b6a4f31
```

The consent surface is server-rendered. It reads the staged request, shows the client identity and requested streams, and lets the user approve or deny it.

### Step 3: Approval creates the grant and returns the client token

The current reference implementation uses a direct approval shortcut instead of a full authorization-code redirect.

```http
POST /consent/approve
Content-Type: application/json

{
  "request_uri": "urn:pdpp:pending-consent:dc_4f5f7c0f9b6a4f31",
  "subject_id": "owner_local"
}
```

Reference response:

```json
{
  "grant_id": "grt_3ce1d18c8b6f4f9b",
  "token": "9de5...opaque bearer token...",
  "grant": {
    "version": "0.1.0",
    "grant_id": "grt_3ce1d18c8b6f4f9b",
    "subject": { "id": "owner_local" },
    "client": {
      "client_id": "longview_planning_v1",
      "client_display": { "name": "Longview" }
    },
    "source": {
      "kind": "provider_native",
      "id": "northstar_hr"
    },
    "purpose_code": "https://longview.example/purpose/career-move-planning",
    "access_mode": "continuous",
    "streams": [
      { "name": "pay_statements", "view": "summary", "fields": ["employer", "pay_period_start", "pay_period_end", "gross_pay", "net_pay", "currency"] },
      { "name": "equity_grants", "view": "summary", "fields": ["employer", "grant_type", "quantity", "currency", "granted_at", "vesting_start_date", "vesting_end_date"] },
      { "name": "benefits_enrollments", "view": "summary", "fields": ["employer", "plan_name", "coverage_level", "effective_date", "employee_cost_monthly", "currency"] }
    ]
  }
}
```

### Step 4: Longview queries the resource server

Because this is the native-provider path, the client relies on the grant-bound source object.

```http
GET /v1/streams/pay_statements/records?limit=10
Authorization: Bearer 9de5...opaque bearer token...
```

Representative response:

```json
{
  "object": "list",
  "data": [
    {
      "object": "record",
      "id": "ps_2026_04_15",
      "stream": "pay_statements",
      "data": {
        "employer": "Northstar HR",
        "pay_period_start": "2026-04-01",
        "pay_period_end": "2026-04-15",
        "gross_pay": 5400,
        "net_pay": 3912,
        "currency": "USD"
      },
      "emitted_at": "2026-04-16T12:00:00Z"
    }
  ],
  "has_more": false
}
```

### Step 5: Longview performs incremental sync

```http
GET /v1/streams/pay_statements/records?changes_since=cursor_01
Authorization: Bearer 9de5...opaque bearer token...
```

The resource server returns only records whose **grant-authorized projection** changed since `cursor_01`, plus a `next_changes_since` token on the terminal page.

## Example 2: CLI owner login and self-export against the same provider

This is the owner path. It proves that a generic CLI can consume the provider’s metadata, authenticate the owner, and export records without using Longview at all.

### Step 1: Discover the provider

The CLI starts from the resource server URL:

```bash
pdpp provider show --rs-url http://localhost:7762 --format json
```

Representative output:

```json
{
  "resource_server": "http://localhost:7762",
  "authorization_server": "http://localhost:7662",
  "pushed_authorization_request_supported": true,
  "pushed_authorization_request_endpoint": "http://localhost:7662/oauth/par",
  "device_authorization_supported": true,
  "device_authorization_endpoint": "http://localhost:7662/oauth/device_authorization",
  "pdpp_self_export_supported": true,
  "pdpp_token_kinds_supported": ["owner", "client"]
}
```

### Step 2: Start the owner device flow

```http
POST /oauth/device_authorization
Content-Type: application/x-www-form-urlencoded

client_id=pdpp-cli
```

Reference response:

```json
{
  "device_code": "dc_owner_2f58...",
  "user_code": "A1B2C3",
  "verification_uri": "http://localhost:7662/device",
  "verification_uri_complete": "http://localhost:7662/device?user_code=A1B2C3",
  "interval": 5,
  "expires_in": 300
}
```

### Step 3: The user approves the device code

```http
POST /device/approve
Content-Type: application/x-www-form-urlencoded

user_code=A1B2C3&subject_id=owner_local
```

### Step 4: The CLI polls for the owner token

```http
POST /oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=urn:ietf:params:oauth:grant-type:device_code&
device_code=dc_owner_2f58...&
client_id=pdpp-cli
```

Reference response:

```json
{
  "access_token": "1b9b...owner bearer token...",
  "token_type": "Bearer",
  "expires_in": 3600
}
```

### Step 5: Export data as the owner

Native owner reads use the provider-native source:

```bash
pdpp owner export pay_statements --rs-url http://localhost:7762 --owner-token 1b9b...
```

Polyfill owner reads are different:

- they use the same owner token model
- they identify the source as `{ "kind": "connector", "id": "<registry URI>" }` because the public source identity is connector-scoped

## Example 3: Polyfill source access uses a connector source object

The reference also supports a polyfill path for collected sources like Spotify. In that path:

- the request sent to `/oauth/par` includes `source: { kind: "connector", id }`
- the resulting grant has `source.kind = "connector"`
- owner reads and runtime ingest/state operations remain connector-scoped

That split is intentional. The reference implementation is proving one engine substrate with two honest realizations:

- native provider access identified with `source.kind = "provider_native"`
- polyfill access identified with `source.kind = "connector"`

## Example 4: Token introspection — verify an issued token and read its grant

The AS exposes RFC 7662-style token introspection at `POST /introspect` with PDPP
extensions. The RS uses this endpoint internally to authorize every request; third
parties (e.g., an RS operator building a proxy layer) can call it directly.

`grant_storage_binding` is the one internal field the AS redacts before returning
the response — the public envelope never exposes storage-layer connector ids.

### Step 1: Introspect a live client token

```bash
# TOKEN = the opaque bearer token returned by /consent/approve
curl -sX POST "$AS_URL/introspect" \
  -H 'Content-Type: application/json' \
  -d "{\"token\": \"$TOKEN\"}" | jq .
```

Reference response for a **valid, active client-scoped token**:

```json
{
  "active": true,
  "pdpp_token_kind": "client",
  "subject_id": "owner_local",
  "exp": 1749081600,
  "grant_id": "grt_3ce1d18c8b6f4f9b",
  "client_id": "longview_planning_v1",
  "grant": {
    "version": "0.1.0",
    "grant_id": "grt_3ce1d18c8b6f4f9b",
    "subject": { "id": "owner_local" },
    "client": {
      "client_id": "longview_planning_v1",
      "client_display": { "name": "Longview" }
    },
    "source": {
      "kind": "provider_native",
      "id": "northstar_hr"
    },
    "purpose_code": "https://longview.example/purpose/career-move-planning",
    "access_mode": "continuous",
    "streams": [
      {
        "name": "pay_statements",
        "view": "summary",
        "fields": ["employer", "pay_period_start", "pay_period_end", "gross_pay", "net_pay", "currency"]
      }
    ]
  },
  "trace_id": "trc_a1b2c3d4e5f60001",
  "scenario_id": null
}
```

PDPP extension fields in the response:

| Field | Meaning |
| --- | --- |
| `pdpp_token_kind` | `"client"` for grant-scoped tokens, `"owner"` for owner self-export tokens, `"mcp_package"` for MCP grant-package tokens |
| `grant_id` | The grant that backs this token (client tokens only) |
| `grant` | Full persisted grant object — source, streams, access_mode, purpose |
| `subject_id` | The data owner who approved the grant |
| `exp` | Unix timestamp at which the token expires (null if no expiry) |
| `trace_id` | Audit trace id from the original consent ceremony; null if none |
| `scenario_id` | Test/scenario tag when present; null in production flows |

### Step 2: Token inactive — grant revoked

When the underlying grant is revoked (or has already been consumed for a
`single_use` grant), introspection returns `active: false` with a typed reason:

```json
{
  "active": false,
  "inactive_reason": "grant_revoked",
  "grant_id": "grt_3ce1d18c8b6f4f9b",
  "client_id": "longview_planning_v1",
  "subject_id": "owner_local"
}
```

Possible `inactive_reason` values:

| Value | Cause |
| --- | --- |
| `grant_revoked` | Grant was explicitly revoked; token is now dead |
| `grant_expired` | Token's `expires_at` has passed |
| `token_revoked` | Token itself was revoked (owner tokens) |
| `token_expired` | Owner/mcp_package token past expiry |
| `grant_invalid` | Grant's persisted state no longer matches the registered manifest contract |

### Step 3: Introspect an MCP grant-package token

MCP grant-package tokens return a different active shape — `grant_package_id`
instead of `grant_id`, and a `package` object instead of `grant`:

```json
{
  "active": true,
  "pdpp_token_kind": "mcp_package",
  "subject_id": "owner_local",
  "exp": 1749081600,
  "grant_package_id": "gpkg_7f8a9b0c1d2e3f40",
  "client_id": "my_mcp_client",
  "package": {
    "package_id": "gpkg_7f8a9b0c1d2e3f40",
    "grants": [
      { "grant_id": "grt_abc1", "source": { "kind": "connector", "id": "https://registry.pdpp.org/connectors/gmail" } },
      { "grant_id": "grt_abc2", "source": { "kind": "connector", "id": "https://registry.pdpp.org/connectors/github" } }
    ]
  },
  "trace_id": "trc_b2c3d4e5f6a70002"
}
```

## Example 5: Record-level audience binding with `resources[]`

`resources[]` on a stream scopes a grant to specific record keys, implementing
RFC 8707-style resource indicators at the record level. The RS enforces the list
as a SQL `WHERE record_key IN (...)` predicate — records not in the list return
`blob_not_found` or are simply absent from query results. This is how a client
requesting "just these three invoices" can receive a narrower grant than one
requesting an entire stream.

### Step 1: Stage a PAR request with record-scoped `resources[]`

```bash
curl -sX POST "$AS_URL/oauth/par" \
  -H 'Content-Type: application/json' \
  -d '{
    "client_id": "my_client",
    "authorization_details": [{
      "type": "https://pdpp.org/data-access",
      "source": { "kind": "connector", "id": "https://registry.pdpp.org/connectors/spotify" },
      "purpose_code": "assist.summarize",
      "purpose_description": "Retrieve the three named artists for a comparison task.",
      "access_mode": "single_use",
      "streams": [{
        "name": "top_artists",
        "fields": ["id", "name", "popularity"],
        "resources": ["artist_01", "artist_02", "artist_03"]
      }]
    }]
  }' | jq -r .request_uri
```

### Step 2: Owner approves — grant has resources[] embedded

```bash
APPROVED=$(curl -sX POST "$AS_URL/consent/approve" \
  -H 'Content-Type: application/json' \
  -d "{\"request_uri\": \"$REQUEST_URI\", \"subject_id\": \"owner_local\"}")
TOKEN=$(echo $APPROVED | jq -r .token)
```

The issued grant embeds `resources` on the stream:

```json
{
  "streams": [{
    "name": "top_artists",
    "fields": ["id", "name", "popularity"],
    "resources": ["artist_01", "artist_02", "artist_03"]
  }]
}
```

### Step 3: RS enforces the resources[] list — only those records are visible

```bash
curl -s "$RS_URL/v1/streams/top_artists/records" \
  -H "Authorization: Bearer $TOKEN" | jq '.data[].id'
# → "artist_01"
# → "artist_02"
# → "artist_03"
# records outside resources[] are absent from results even if they exist
```

Aggregate queries are equally scoped: a `sum` over `popularity` on this token
counts only those three records. The enforcement is in SQL (`record_key IN (?)`
pushdown), so the RS never loads the hidden records into application memory.
