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

The current reference proves request staging, protected dynamic client registration, consent, issued grants, owner self-export, and honest native-versus-polyfill source identity.

## Example 1: Longview requests compensation data from Northstar HR

This is the native-provider path. Longview requests compensation records from `Northstar HR`, so the request identifies the source with `provider_id`, not `connector_id`.

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
      "provider_id": "northstar_hr",
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
      "binding_kind": "provider_native",
      "provider_id": "northstar_hr"
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

Because this is the native-provider path, the client does **not** pass `connector_id`.

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

Native owner reads also omit `connector_id`:

```bash
pdpp owner export pay_statements --rs-url http://localhost:7762 --owner-token 1b9b...
```

Polyfill owner reads are different:

- they use the same owner token model
- they still require `--connector-id <registry URI>` because the public source identity is connector-scoped

## Example 3: Polyfill source access still uses connector_id

The reference also supports a polyfill path for collected sources like Spotify. In that path:

- the request sent to `/oauth/par` includes `connector_id`
- the resulting grant has `source.binding_kind = "connector"`
- owner reads and runtime ingest/state operations remain connector-scoped

That split is intentional. The reference implementation is proving one engine substrate with two honest realizations:

- native provider access identified with `provider_id`
- polyfill access identified with `connector_id`
