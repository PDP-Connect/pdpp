---
title: "Reference Implementation"
description: "The forkable PDPP reference implementation: native provider, polyfill path, Longview client, CLI, and reference-only traces."
---

The `reference-implementation/` package is the forkable PDPP reference substrate in this repo. It is where the current authorization server, resource server, runtime, CLI, and black-box tests prove the protocol.

For repo-level orientation, start with the root `README.md`. For runnable package details, see `reference-implementation/README.md`.

## Current topology

The live reference implementation is organized around four first-class actors:

- **Northstar HR**: the native PDPP provider path
- **Personal-server polyfill path**: the connector/runtime realization for collected sources
- **Longview**: the reference client application
- **PDPP CLI**: the owner/debug consumer

Those actors share one engine substrate but expose two different source-realization models:

- **Native provider**: public requests identify the source with `provider_id`
- **Polyfill source**: public requests identify the source with `connector_id`

## Primary surfaces

### Provider discovery

The current provider-connect story starts with standards-based discovery:

- `GET /.well-known/oauth-protected-resource`
- `GET /.well-known/oauth-authorization-server`

The authorization-server metadata truthfully advertises:

- `pushed_authorization_request_endpoint`
- `registration_endpoint`
- `device_authorization_endpoint`
- `token_endpoint`
- `introspection_endpoint`
- `pdpp_registration_modes_supported`
- `pdpp_authorization_details_types_supported`

The same metadata intentionally does **not** advertise a full generic OAuth authorization-code client-connect surface yet. In the live reference today, there is still no published `authorization_endpoint`, no published `response_types_supported`, and no published PKCE/browser redirect flow.

### Client request start

Client requests are staged through:

- `POST /oauth/par`

### Client registration

The current reference also supports a protected dynamic registration path:

- `POST /oauth/register`

It is intentionally narrow:

- public-client metadata only (`token_endpoint_auth_method: "none"`)
- protected by an initial access token
- meant to coexist with the pre-registered client path, not replace it

The current reference contract expects a single RFC 9396 `authorization_details` entry of type `https://pdpp.org/data-access`.

### Consent and grant issuance

The staged request is reviewed through:

- `GET /consent?request_uri=...`
- `POST /consent/approve`
- `POST /consent/deny`

The current reference approval surface returns the issued grant and client bearer token directly. It is a deliberate reference shortcut, not a full generic authorization-code profile.

### Owner self-export

Owner login is a separate device flow:

- `POST /oauth/device_authorization`
- `GET /device`
- `POST /device/approve`
- `POST /oauth/token`

That flow yields an **owner bearer token** for self-export and direct owner queries.

### Resource server queries

Clients and owners both query the resource server through `/v1`.

The main distinction is source realization:

- **Native provider mode**: no public `connector_id` is required for owner reads or client grant reads
- **Polyfill mode**: owner reads still require `connector_id`, because the source identity is connector-scoped

In the current reference, successful and route-level rejected `/v1/streams`, `/v1/streams/:stream`, `/v1/streams/:stream/records`, and `/v1/streams/:stream/records/:id` responses also expose:

- `Request-Id`
- `PDPP-Reference-Trace-Id`

That header pair is a reference-only correlation aid. It lets a caller jump from a live read response to the existing `GET /_ref/traces/:traceId` reader without adding a broader trace-listing surface.

### Reference-only introspection and traces

The implementation also exposes narrow reference-only surfaces for debugging and replay:

- `GET /_ref/traces/:traceId`
- `GET /_ref/grants/:grantId/timeline`
- `GET /_ref/runs/:runId/timeline`

These are intentionally reference artifacts. They are not part of the core PDPP protocol.

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

- `provider_id` for native sources such as Northstar HR
- `connector_id` for collected/polyfill sources such as Spotify

## What is still intentionally thin

The current reference is strong enough to fork and evaluate today. The remaining deliberate gaps are about scope control, not about whether a real substrate exists.

Notably:

- the provider-connect profile is still thin and intentionally conservative
- the current metadata proves request staging, protected DCR, and owner self-export, not a complete third-party authorization-code ecosystem profile
- the control-plane / dashboard layer is not built yet
- the website consumes the reference but does not define its primary contract

The most trustworthy description of the live system remains:

1. root PDPP specs for protocol semantics
2. `reference-implementation/` code and tests for current implementation behavior
3. OpenSpec change/spec artifacts for project-level planning and boundaries
