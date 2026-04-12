# System Architecture: How the Spec Components Relate

Date: 2026-04-11

## Components

```
┌───────────────────────────────────────────────────────────────┐
│                         User                                  │
│  (owns data, grants access, may revoke)                       │
└──────────┬───────────────────────────────┬────────────────────┘
           │ consents                     │ collects via CLI
           ▼                              ▼
┌─────────────────────┐       ┌─────────────────────────┐
│   App / AI Agent    │       │   Connector Runtime     │
│                     │       │                         │
│ Requests data via   │       │ Runs connectors using   │
│ selection request   │       │ the run protocol:       │
│ (RFC 9396)          │       │ START → RECORD/STATE/   │
│                     │       │ INTERACTION → DONE      │
│ Receives data from  │       │                         │
│ personal server     │       │ Writes records to       │
│ filtered by grant   │       │ personal server         │
└────────┬────────────┘       └───────────┬─────────────┘
         │                                │
         │ presents grant                 │ RECORD messages
         │ + selection params             │
         ▼                                ▼
┌───────────────────────────────────────────────────────────────┐
│                    Personal Server                            │
│                                                               │
│  Stores:                                                      │
│  - Records (flat relational streams)                          │
│  - State (per-stream cursors for incremental sync)            │
│  - Grants (issued, active, expired, revoked)                  │
│  - Connector manifests (registered connectors + versions)     │
│                                                               │
│  Enforces:                                                    │
│  - Grant parameters (streams, time_range, fields, limit)      │
│  - Grant expiry and revocation                                │
│  - Selection validation against manifest                      │
│                                                               │
│  Serves:                                                      │
│  - Records to apps, filtered by grant                         │
│  - Records to connector runtime (state for incremental sync)  │
│                                                               │
│  Accepts:                                                     │
│  - Records from connector runtime (collection results)        │
│  - Records from webhooks (future)                             │
│  - Grant creation/revocation requests                         │
└───────────────────────────────────────────────────────────────┘
         │
         │ collects from
         ▼
┌───────────────────────────────────────────────────────────────┐
│                    Data Sources                               │
│                                                               │
│  Spotify, ChatGPT, Instagram, Uber, Oura, GitHub, ...         │
│                                                               │
│  Accessed via:                                                │
│  - Browser automation (scraping, current connectors)          │
│  - Official APIs (Spotify API, future DMA portability APIs)   │
│  - Webhooks (Shopify, GitHub — future)                        │
│  - File import (Timelinize, data exports — future)            │
└───────────────────────────────────────────────────────────────┘
```

## Flows

### Flow A: App requests data (pre-collected)

Most common flow once a user is onboarded.

1. App sends selection request (RFC 9396 `authorization_details`)
2. User consents → grant is created and stored in personal server
3. App presents grant to personal server
4. Personal server queries stored records, filtered by grant parameters
5. App receives records

No connector runs. Data was already collected.

### Flow B: App requests data (needs fresh collection)

When data isn't in the personal server yet, or is stale.

1. App sends selection request
2. User consents → grant is created
3. Personal server checks: do I have fresh enough data for this grant?
4. No → personal server (or user's runtime) triggers a connector run
5. Connector runtime sends START (portable collection `scope` + state + bindings) to connector
6. Connector collects data, emits RECORD/STATE messages
7. Runtime writes records to personal server
8. Personal server serves records to app, filtered by grant

### Flow C: User proactively collects (CLI / background sync)

User decides to collect data before any app requests it.

1. User runs `vana collect spotify` (or background scheduler triggers it)
2. Runtime sends START to connector with an explicit collection `scope` derived from user preferences or local policy (no raw grant)
3. Connector collects, emits RECORD/STATE
4. Runtime writes records to personal server
5. Data is now available for future grants

### Flow D: Webhook push (future)

1. User sets up a webhook subscription with a platform (e.g., GitHub)
2. Platform sends events to the personal server's webhook endpoint
3. Personal server normalizes events into records, stores them
4. Records are available for grants, same as pre-collected data

## What the spec defines vs what it doesn't

| Component | Defined by this spec? | Notes |
|-----------|----------------------|-------|
| Grant object | **Yes** | The parameterized consent artifact |
| Record model | **Yes** | Streams, schemas, keys, blob_ref, resource_ref |
| Connector manifest | **Yes** | What a connector produces and requires |
| Connector run protocol | **Yes** | START/RECORD/STATE/INTERACTION/DONE |
| Selection request format | **Yes** | RFC 9396 authorization_details |
| Personal server API | **No** (reference only) | How apps query records by grant |
| Personal server storage | **No** | Implementation choice |
| Webhook ingestion | **No** | Future extension |
| Consent screen visual design | **No** | Surface-specific; semantic rendering obligations remain in scope |
| Trust verification | **No** | DTI Trust Registry |

For the Collection Profile, the standardized `START` message carries a portable collection `scope`: explicit stream targets plus optional `resources`, `time_range`, and `fields`. It does not carry the raw grant or access token. For grant-driven runs, the runtime derives this scope from the grant as a normalized, non-broadening projection and may narrow it further according to local fulfillment policy; for proactive runs, it derives the scope from user preferences or local policy.

## How connector versioning works

The personal server stores connector manifests. A grant references a specific connector by `connector_id` (a fully qualified URI). The manifest has a `protocol_version` and the connector itself has a version.

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

The core spec should define freshness first as response metadata, not as a grant constraint. A client needs to know whether the server's data is current, stale, or unknown even when the authorization itself is perfectly valid.

Current v0.1 direction:
1. **Expose response freshness metadata.** The resource server reports `captured_at`, `status`, and optionally `last_attempted_at` on stream and record-list responses.
2. **Let the personal server decide how to fulfill reads.** Freshness status reflects local observation and policy, not a guarantee that the source has not changed since `captured_at`.

Fulfillment strategies remain an implementation choice:
1. **Always serve from cache.** App gets whatever's stored. Fast, simple.
2. **Check age.** If the newest record in a stream is older than X, trigger collection first according to local policy.
3. **Always collect fresh.** Every grant fulfillment triggers a connector run. Slow but guaranteed fresh.

Request-side freshness requirements remain future work. One possible future shape is an optional selection-request hint:

```json
{
  "freshness": { "max_age": "PT1H" }
}
```

This would say "data older than 1 hour is not acceptable." Even then, the personal server may be unable to collect fresh data (connector unavailable, user offline, source throttling), which is why the response metadata comes first: it closes the honesty gap without pretending collection can always satisfy the request.
