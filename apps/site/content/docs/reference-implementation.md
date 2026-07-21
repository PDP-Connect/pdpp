---
title: "Reference Implementation Notes"
description: "Current implementation behavior for the forkable PDPP reference stack. Not normative protocol documentation."
---

<Callout type="info" title="Page status">
  Status: **Informative**

  Date: 2026-07-07

  Scope: Implementation notes for the `reference-implementation/` package; describes current behavior, not protocol requirements.
</Callout>

These are implementation notes for the current `reference-implementation/` package. The public explainer and run/deploy entrypoint is [/reference](/reference). For protocol semantics, use the protocol docs under [/docs](/docs).

The `reference-implementation/` package is the forkable PDPP reference substrate in this repo. It is where the current authorization server, resource server, runtime, CLI, and black-box tests exercise the protocol.

For repo-level orientation, start with the root `README.md`. For runnable package details, see `reference-implementation/README.md`.

## Current topology

The live reference implementation is organized around four first-class actors:

- **Northstar HR**: the native PDPP provider path
- **Personal-server polyfill path**: the connector/runtime realization for collected sources
- **Longview**: the reference client application
- **Reference operator CLI**: the repo-local owner/debug consumer
- **Public PDPP CLI**: the installable client/agent connect consumer

Those actors share one engine substrate but expose two different source-realization models:

- **Native provider**: public requests identify the source with `source: { kind: "provider_native", id }`
- **Polyfill source**: public requests identify the source with `source: { kind: "connector", id }`

## Primary surfaces

### Provider discovery

The current provider-connect story starts with standards-based discovery:

- `GET /.well-known/oauth-protected-resource`
- `GET /.well-known/oauth-authorization-server`

The protected-resource metadata also includes advisory agent discovery at
`pdpp_agent_discovery`. Its CLI command is generated from the published package
metadata:

```bash
npx -y @pdpp/cli connect <provider-url>
```

The `pdpp_agent_discovery.cli.no_owner_token` flag is `true` when the reference
AS supports owner-approved scoped handoff without an owner bearer token; while
it is true, the command above is the no-owner-token connect flow.

The operator console also shows reference diagnostics such as
`pdpp ref run timeline <run-id>`, `pdpp ref grant timeline <grant-id>`, and
`pdpp ref trace show <trace-id>`. These use the `pdpp ref` namespace from the
same `@pdpp/cli` package (`npx -y @pdpp/cli --help`) and inspect `_ref`
operator routes for a running reference deployment. When placeholder owner auth
is enabled, set `PDPP_OWNER_SESSION_COOKIE` to a valid `pdpp_owner_session`
cookie before using those commands.

The authorization-server metadata truthfully advertises:

- `pushed_authorization_request_endpoint`
- `registration_endpoint`
- `device_authorization_endpoint`
- `token_endpoint`
- `introspection_endpoint`
- `agent_connect_endpoint`
- `pdpp_registration_modes_supported`
- `pdpp_pre_registered_public_clients`
- `pdpp_authorization_details_types_supported`

The same metadata intentionally does **not** advertise a full generic OAuth authorization-code client-connect surface yet. In the live reference today, there is still no published `authorization_endpoint`, no published `response_types_supported`, and no published PKCE/browser redirect flow.

### Client request start

Client requests are staged through:

- `POST /oauth/par`

The live reference uses PAR to persist the RFC 9396 `authorization_details` request, then sends the user through the reference consent shell. Approval returns the grant and client bearer token directly. That direct-token return is a reference shortcut; it is not a generic OAuth authorization-code redirect profile.

### Client registration

The current reference also supports public-client self-registration:

- `POST /oauth/register`

It is intentionally narrow:

- public-client metadata only (`token_endpoint_auth_method: "none"`)
- no initial access token required for the public path
- optional initial-access tokens remain available for operator/bootstrap use
- registration creates a public `client_id` only; data access still requires owner-approved consent
- meant to coexist with the pre-registered client path as fallback and examples

The current reference contract expects a single RFC 9396 `authorization_details` entry of type `https://pdpp.org/data-access`.

### Consent and grant issuance

The staged request is reviewed through:

- `GET /consent?request_uri=...`
- `POST /consent/approve`
- `POST /consent/deny`

Approval returns the issued grant and client bearer token directly (the reference shortcut noted under Client request start).

### Owner self-export

Owner login is a separate device flow:

- `POST /oauth/device_authorization`
- `GET /device`
- `POST /device/approve`
- `POST /oauth/token`

That flow yields an **owner bearer token** for self-export and direct owner queries.

Trusted local owner agents use a separate reference onboarding path rather than
copying raw owner bearers into chat. Start from the resource-server entrypoint
with `pdpp owner-agent onboard <entrypoint>` (credentials are stored at
`~/.pdpp/owner-agents/<host>.json` by default), approve in the browser, and
verify with `pdpp owner-agent status`. This is reference control-plane
behavior; ordinary agents should use scoped grants or grant-scoped MCP.

### Error envelopes

OAuth authorization-server endpoints keep RFC-shaped error bodies:

```json
{
  "error": "invalid_request",
  "error_description": "client_id is required",
  "request_id": "req_..."
}
```

The reference adds `request_id` and a matching `Request-Id` header for debugging. Resource-server and PDPP-native endpoints continue to use the nested PDPP error envelope with `error.type`, `error.code`, `error.message`, and `error.request_id`.

### Semantic retrieval diagnostics

The reference implements experimental semantic retrieval as a reference feature,
not as core PDPP. Local development uses a server-owned embedding profile; the
default operational profile is `minilm`, backed by `Xenova/all-MiniLM-L6-v2`
through Transformers.js. Operators can switch to `multilingual-minilm` for
Italian or mixed-language data without adding public `model=` or `embedding=`
request parameters.

The operator console's `/deployment` page shows the active semantic
backend, model, dimensions, distance metric, language bias, vector-index kind,
index state, model-cache state, and every participating
`(connector, stream, field)` tuple. It is the first place to check when semantic
search returns no hits: zero participation, disabled downloads, stale indexes,
and background rebuilds are visible there without reading logs.

### Resource server queries

Clients and owners both query the resource server through `/v1`.

The main distinction is source realization:

- **Native provider mode**: owner reads and client grant reads use `source.kind = "provider_native"`
- **Polyfill mode**: owner reads and client grant reads use `source.kind = "connector"`, because the source identity is connector-scoped

In the current reference, successful and route-level rejected `/v1/streams`, `/v1/streams/:stream`, `/v1/streams/:stream/records`, and `/v1/streams/:stream/records/:id` responses also expose:

- `Request-Id`
- `PDPP-Reference-Trace-Id`
- `PDPP-Reference-Revision`

`Request-Id` and `PDPP-Reference-Trace-Id` are reference-only correlation aids. They let a caller jump from a live read response to the existing `GET /_ref/traces/:traceId` reader without adding a broader trace-listing surface.

`PDPP-Reference-Revision` is reference implementation metadata, not protocol negotiation. It is emitted by the authorization server, resource server, composed proxy-visible routes, and `_ref` surfaces so operators can tell which reference build is running without overloading the protocol `PDPP-Version` header. The value uses `PDPP_REFERENCE_REVISION` when set, otherwise the package version plus git revision when available, and falls back to an `unknown` revision when build metadata is not available.

### Reference-only introspection and traces

The implementation also exposes narrow reference-only surfaces for debugging and replay:

- `GET /_ref/traces/:traceId`
- `GET /_ref/grants/:grantId/timeline`
- `GET /_ref/runs/:runId/timeline`

These are intentionally reference artifacts. They are not part of the core PDPP protocol, and the dashboard that renders them is an operator surface for a running local or self-hosted instance.

## What has been intentionally removed

The current reference no longer relies on these older helper seams:

- `POST /grants/initiate`
- `GET /consent/:deviceCode`
- `POST /consent/:deviceCode/approve`
- `POST /consent/:deviceCode/deny`
- `POST /owner-token`
- `POST /grants/:grantId/tokens`

If you see those mentioned in archival notes, treat them as historical context, not live contract.

## Why this split exists

The reference is trying to prove one specific architectural point:

- **PDPP core** should not care whether data arrived from a native provider, a browser-automation connector, a file import, or some later collection mechanism.
- **Public source identity** still needs to be honest.

That is why the same engine supports both:

- `source: { kind: "provider_native", id: "northstar_hr" }` for native sources such as Northstar HR
- `source: { kind: "connector", id: "https://registry.pdpp.org/connectors/spotify" }` for collected/polyfill sources such as Spotify

## What is still intentionally thin

The current reference is strong enough to fork and evaluate today. The remaining deliberate gaps are about scope control, not about whether a real substrate exists.

Notably:

- the provider-connect profile is still thin and intentionally conservative
- the current metadata proves request staging, protected DCR, and owner self-export, not a complete third-party authorization-code ecosystem profile
- the public website explains the reference but does not define its primary contract
- the dashboard is a live-instance operator surface, not a hosted canonical PDPP demo

The most trustworthy description of the live system remains:

1. root PDPP specs for protocol semantics
2. `reference-implementation/` code and tests for current implementation behavior
3. OpenSpec change/spec artifacts for project-level planning and boundaries
