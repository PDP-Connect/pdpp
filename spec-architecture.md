# System Architecture: How the Spec Components Relate

Status: Informative
Date: 2026-07-07

## Components

```
┌───────────────────────────────────────────────────────────────┐
│                         User                                  │
│  (owns data, approves grants, may revoke)                     │
└──────────┬───────────────────────────────┬────────────────────┘
           │ consents                      │ operates
           ▼                               ▼
┌─────────────────────┐       ┌─────────────────────────┐
│  Client             │       │   Connector Runtime     │
│  (app or AI agent)  │       │   (Collection Profile)  │
│                     │       │                         │
│ Sends selection     │       │ Runs polyfill           │
│ request (RFC 9396   │       │ connectors:             │
│ authorization_      │       │ START → RECORD/STATE/   │
│ details with a      │       │ INTERACTION → DONE      │
│ source binding)     │       │                         │
│                     │       │ Writes records to the   │
│ Uses the access     │       │ personal server         │
│ token bound to the  │       │ (owner-authenticated    │
│ issued grant        │       │ ingest)                 │
└────────┬────────────┘       └───────────┬─────────────┘
         │ access token                   │ RECORD messages
         ▼                                ▼
┌───────────────────────────────────────────────────────────────┐
│              Personal Server (AS + RS roles co-located)       │
│                                                               │
│  Stores:                                                      │
│  - Records (flat relational streams)                          │
│  - Sync state (per-stream cursors for incremental sync)       │
│  - Grants (issued; lifecycle tracked by the AS)               │
│  - Connector manifests (registered connectors + versions)     │
│                                                               │
│  Enforces on every request:                                   │
│  - Grant parameters (streams, fields, time_range, resources)  │
│  - Grant expiry and revocation (via token introspection)      │
│  - Selection validation against the manifest at issuance      │
│                                                               │
│  Serves:                                                      │
│  - Records to clients, filtered by grant (access token)       │
│  - Owner self-export via the same query endpoints             │
│    (owner token)                                              │
│                                                               │
│  Accepts:                                                     │
│  - Records from the connector runtime (Collection Profile     │
│    ingest)                                                    │
│  - Grant initiation and revocation requests                   │
└──────────────────────────┬────────────────────────────────────┘
                           │ collects from (polyfill path)
                           ▼
┌───────────────────────────────────────────────────────────────┐
│                    Data Sources                               │
│                                                               │
│  Addressed by the grant's source binding:                     │
│  source: { kind: "connector" | "provider_native", id }        │
│                                                               │
│  - kind "connector": a polyfill connector bridges a platform  │
│    that does not speak PDPP (browser automation, official     │
│    APIs, file import)                                         │
│  - kind "provider_native": the platform hosts its own         │
│    PDPP-speaking AS + RS and serves records directly; no      │
│    connector runtime involved                                 │
└───────────────────────────────────────────────────────────────┘
```

The reference also exposes an MCP surface for agent hosts. Agent access through it uses grant packages with the reference-defined `mcp_package` token kind; Core defines the `owner` and `client` kinds, and unrecognized kinds are unauthorized for Core operations (spec-core Section 8).

## Flows

### Flow A: client requests pre-collected data

The common flow once data is present.

1. Client sends a selection request (RFC 9396 `authorization_details` with a `source` binding)
2. User consents; the grant is issued and an access token is bound to it
3. Client queries the resource server with the access token
4. The resource server serves stored records, filtered by the grant parameters

No connector runs. Data was already collected.

### Flow B: grant-driven collection

For `kind: "connector"` sources, collection is a Collection Profile concern, separate from disclosure.

1. Client sends a selection request; user consents; the grant is issued
2. A grant-driven run derives its collection `scope` from the grant as a normalized, non-broadening projection (the connector never receives the raw grant or access token)
3. The connector emits RECORD/STATE messages; the runtime writes records through owner-authenticated ingest
4. The resource server serves stored records to the client, filtered by the grant

Whether and when a deployment runs collection for a grant is fulfillment policy, not protocol. The resource server reports what it knows through freshness metadata (see Freshness below).

### Flow C: owner-initiated collection

The owner collects before any client asks.

1. The owner starts a run from the operator console, or the scheduler starts one on the configured cadence
2. The runtime sends START to the connector with a collection `scope` derived from owner configuration (no grant involved)
3. The connector emits RECORD/STATE; the runtime writes records to the personal server
4. The data is available to future grants

### Flow D: webhook push (not implemented)

Event-driven ingestion (a platform pushes events to the personal server) is deferred; see the deferred-concerns register. Nothing in the current reference implements it.

## What the spec defines vs what it doesn't

| Component | Defined by the spec? | Notes |
|-----------|----------------------|-------|
| Grant object | **Yes** | The parameterized consent artifact (Core Section 6) |
| Record model | **Yes** | Streams, schemas, keys, blob_ref, resource_ref (Core Section 4) |
| Source binding | **Yes** | `source: { kind, id }` on requests and grants (Core Section 5) |
| Connector manifest | **Yes** | What a connector produces and requires (Core Section 7) |
| Connector run protocol | **Yes** | START/RECORD/STATE/INTERACTION/DONE (Collection Profile) |
| Selection request format | **Yes** | RFC 9396 authorization_details (Core Section 5) |
| Resource server query interface | **Yes** | How clients query records under a grant (Core Section 8) |
| Personal server storage | **No** | Implementation choice |
| Webhook ingestion | **No** | Deferred; see spec-deferred |
| MCP agent surface | **No** | Reference implementation feature (grant packages) |
| Consent screen visual design | **No** | Surface-specific; semantic rendering obligations remain in scope |
| Trust registry / connector certification | **No** | Deferred (Core Section 11) |

For the Collection Profile, the standardized `START` message carries a portable collection `scope`: explicit stream targets plus optional `resources`, `time_range`, and `fields`. It does not carry the raw grant or access token. For grant-driven runs, the runtime derives this scope from the grant as a normalized, non-broadening projection and may narrow it further according to local fulfillment policy; for owner-initiated runs, it derives the scope from owner configuration or local policy.

## How connector versioning works

The personal server stores connector manifests. A grant carries a `source` binding; for `kind: "connector"`, `source.id` is the connector identifier as defined by the deployment's connector registry (Core Section 5). The grant also pins `manifest_version`, the version of the source's manifest it was validated against.

When a connector is updated:

1. A new manifest is published with a new version
2. Existing grants continue to work: they reference streams by name, and the stream schemas are what the grant was validated against at consent time
3. If the new version adds streams, existing grants do not include them (streams were frozen at consent time); new grants can
4. If the new version removes streams, the personal server still has the old data and existing grants can still serve it; new collection runs for removed streams fail, and the runtime should handle that without corrupting state
5. If the new version changes a stream schema, that is a breaking change. Two approaches: versioned streams (`playlists_v2` as a distinct stream) or schema evolution (the server accepts both shapes and widens types)

The spec recommends additive-only schema changes: new fields are fine; removing or changing fields is breaking (Core Section 7, Versioning).

## How standing authorization works for AI agents

A request with `streams: [{ "name": "*" }]` is expanded at consent time into the explicit stream list from the manifest. This list is frozen in the grant.

**Future records within a stream:** included. If the user creates a new playlist after a `continuous` grant is issued, it appears in the granted `playlists` stream, subject to any `time_range` constraint.

**Future streams:** not included. If the connector adds a stream in a new version, existing grants do not cover it. Scope changes use revoke-and-reissue; grant amendment is not defined in v0.1 (Core Section 6, Grant narrowing).

**Enforcement:** the resource server checks each request against the grant's `streams` list and rejects streams outside it. The grant is self-contained; enforcement does not require fetching the manifest at request time.

## Freshness

When a client reads under a grant, how does it know whether the data is current?

Core Section 8 defines response-side freshness metadata: the resource server MAY attach `captured_at`, `status` (`current`, `stale`, `unknown`), and `last_attempted_at` to stream listings, stream metadata, and record-list responses. Implementations claiming Collection Profile support publish it (Core Section 9, Tier 2). Freshness reports local observation; it does not guarantee the source has not changed since `captured_at`.

Fulfillment remains an implementation choice: serve from storage, collect on a schedule, or collect before serving. The reference schedules collection per connection and serves stored records with freshness metadata.

Request-side freshness requirements (a client demanding data no older than some age) are future work; see the deferred-concerns register. Response metadata comes first because the server may be unable to collect on demand (connector unavailable, user offline, source throttling), and reporting what it knows closes the honesty gap without promising collection it cannot guarantee.
