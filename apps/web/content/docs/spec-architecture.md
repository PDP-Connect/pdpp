---
title: "Reference Topology"
description: "How the current PDPP reference components relate — native provider, polyfill path, runtime, CLI, and client flows."
---

This is a **reference implementation note**, not normative protocol text. It describes the current topology used in
`reference-implementation/` so readers can evaluate, fork, or operate this repo's implementation without mistaking its
deployment choices for PDPP requirements.

The important architectural split in the live reference is:

- **Native provider path**: `Northstar HR` exposes PDPP directly and public requests identify the source with `provider_id`
- **Polyfill path**: collected sources still use connector manifests, runtime orchestration, and public `connector_id`

## Components

```
┌───────────────────────────────────────────────────────────────┐
│                         User                                  │
│  (owns data, grants access, may revoke)                       │
└──────────┬──────────────────────────┬──────────────────────────┘
           │ consents / approves      │ logs in / self-exports
           ▼                          ▼
┌─────────────────────┐      ┌─────────────────────────┐
│      Longview       │      │       PDPP CLI          │
│  (reference client) │      │  (owner + debug tool)  │
└────────┬────────────┘      └───────────┬─────────────┘
         │                               │
         │ RFC 9396 request via PAR      │ device flow / owner token
         ▼                               ▼
┌───────────────────────────────────────────────────────────────┐
│             PDPP AS + RS reference substrate                  │
│                                                               │
│  Authorization server                                         │
│  - /.well-known/oauth-authorization-server                    │
│  - /oauth/par                                                 │
│  - /consent + /consent/approve                                │
│  - /oauth/device_authorization + /oauth/token                 │
│  - /introspect                                                │
│                                                               │
│  Resource server                                              │
│  - /.well-known/oauth-protected-resource                      │
│  - /v1/streams/...                                            │
│  - /_ref/traces / _ref/grants / _ref/runs (reference only)    │
└───────────────┬───────────────────────────────┬───────────────┘
                │                               │
                │ native provider path          │ polyfill path
                ▼                               ▼
┌───────────────────────────────┐   ┌───────────────────────────┐
│         Northstar HR          │   │   Connector Runtime       │
│   provider_id = northstar_hr  │   │ START → RECORD/STATE/     │
│   public native source        │   │ INTERACTION → DONE        │
└───────────────────────────────┘   └────────────┬──────────────┘
                                                 │
                                                 │ connector-scoped ingest/state
                                                 ▼
                                 ┌───────────────────────────────┐
                                 │     Collected data sources    │
                                 │ Spotify, ChatGPT, Instagram…  │
                                 └───────────────────────────────┘
```

## Current reference flows

### Flow A: Longview requests native provider data

1. Longview stages a request through `POST /oauth/par`
2. The request identifies the source with `provider_id`
3. The AS renders `GET /consent?request_uri=...`
4. `POST /consent/approve` issues the grant and client token
5. Longview queries `/v1/streams/...` without public `connector_id`

### Flow B: Longview requests polyfill data

1. Longview stages the same kind of request through `POST /oauth/par`
2. The request identifies the source with `connector_id`
3. The AS issues a connector-scoped grant after consent
4. The RS serves any already-collected records under that grant
5. If data must be refreshed, the runtime uses the Collection Profile to collect it

### Flow C: Owner self-export

1. The CLI discovers provider metadata from the RS and AS
2. The owner authenticates through the OAuth device flow
3. The CLI calls `/v1/streams/...` with an owner token
4. Native owner reads do not require `connector_id`
5. Polyfill owner reads still require `connector_id`

## What the reference is proving

- One engine substrate can support both native and polyfill realizations.
- Public source identity stays honest:
  - `provider_id` for native providers
  - `connector_id` for polyfill sources
- The website is a consumer of the reference, not the implementation boundary itself.

## What the spec defines vs what it doesn't

| Component | Defined by this spec? | Notes |
|-----------|----------------------|-------|
| Grant object | **Yes** | The parameterized consent artifact |
| Record model | **Yes** | Streams, schemas, keys, blob_ref, resource_ref |
| Connector manifest | **Yes** | The consent and collection surface for connector-based realizations |
| Connector run protocol | **Yes** | START/RECORD/STATE/INTERACTION/DONE |
| Selection request format | **Yes** | RFC 9396 authorization_details |
| Native provider deployment shape | **No** | The reference uses one, but PDPP does not require this exact topology |
| Resource server storage | **No** | Implementation choice |
| Consent screen UX | **No** | Surface-specific |
| Trust verification | **No** | Separate registry/policy concern |
| Reference-only trace endpoints | **No** | Useful for debugging, not part of core PDPP |

## How connector versioning works

Connector versioning matters only for the polyfill path. Native providers such as Northstar HR do not expose a public `connector_id` in the current reference contract.

For connector-based realizations, the resource server stores connector manifests. A grant references a specific connector by `connector_id` (a fully qualified URI). The manifest has a `protocol_version` and the connector itself has a version.

**When a connector is updated:**

1. New manifest is published with a new version
2. Existing grants continue to work — they reference streams by name, and the stream schemas are what the grant was validated against at consent time
3. If the new version adds streams: existing grants don't include them (streams were frozen at consent time). New grants can include them.
4. If the new version removes streams: the personal server still has the old data. Existing grants can still serve it. New collection runs for removed streams will fail; the runtime should handle this gracefully.
5. If the new version changes a stream schema: this is a breaking change. The personal server may have records in the old schema and the connector now produces records in the new schema. Two approaches:
   - **Versioned streams**: `spotify.playlists.v1` and `spotify.playlists.v2` are different streams. Grants reference the specific version.
   - **Schema evolution**: the personal server accepts both old and new shapes, widens types as needed (Fivetran's approach).

For v0.1: the grant stores the `manifest_version` it was validated against. The personal server can detect schema mismatches. The spec recommends additive-only schema changes (new fields are fine, removing or changing fields is breaking).

## How standing authorization works for AI agents

A grant with `streams: [{ "name": "*" }]` is expanded at consent time into the explicit list of streams from the connector's manifest. This list is frozen in the grant.

**Future resources within a stream:** Yes. If the user creates a new Spotify playlist after the grant is issued, it appears in the `playlists` stream. The grant authorized the stream, not specific playlists.

**Future streams:** No. If the connector adds a `listening_history` stream in a new version, existing grants don't include it. The user must create a new grant (or amend the existing one, if the personal server supports grant amendment — not specified in v0.1).

**Enforcement:** The personal server checks each data request against the grant's `streams` list. If the requested stream isn't in the grant, access is denied. The personal server doesn't need to know about the manifest to enforce this — the grant is self-contained.

## Freshness

When an app requests data via a grant, how does the personal server decide whether to serve from cache or trigger a fresh collection?

Options (implementation choice, not spec-mandated):
1. **Always serve from cache.** App gets whatever's stored. Fast, simple.
2. **Check age.** If the newest record in a stream is older than X, trigger collection first. The app specifies acceptable staleness in the selection request.
3. **Always collect fresh.** Every grant fulfillment triggers a connector run. Slow but guaranteed fresh.

The spec should include an optional `freshness` hint on the selection request:

```json
{
  "freshness": { "max_age": "PT1H" }
}
```

This says "data older than 1 hour is not acceptable." The personal server decides how to fulfill it. This is a hint, not a guarantee — the personal server may not be able to collect fresh data (connector unavailable, user offline, etc.).
