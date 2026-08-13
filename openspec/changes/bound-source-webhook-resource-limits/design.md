## Context

The Fastify transport currently accepts up to 200 MiB by default. The source
webhook route receives either a parsed object or a string, normalizes it to a
string, parses it again, and for record pushes constructs NDJSON before the
canonical ingest operation parses every record again. Existing repository
precedent provides a 1 MiB hard byte ceiling and 500-row candidate bound for
detail-gap paging, while the collector's default ingest batch is 500 records.

## Goals / Non-Goals

**Goals:**

- Reject oversized wire bodies at transport parsing, before the route handler.
- Reject overlarge record arrays before the idempotency claim and before
  per-record serialization.
- Preserve current HMAC, target namespace, replay, ingest, and scheduler
  semantics for bounded requests.
- Exercise the actual Fastify route-option path, not only a pure helper.

**Non-Goals:**

- Changing the global 200 MiB transport default or public `/v1/ingest`.
- Bounding device-exporter ingest in this change.
- Introducing an operator override before measured compatibility feedback.
- Reworking streaming parsing; the 1 MiB transport ceiling makes that a
  separate optimization rather than a prerequisite for this fix.

## Decisions

### Use a route-local 1 MiB body limit

Register the source-webhook route with the existing `{ bodyLimit }` route
option. This makes Fastify reject both `application/json` and `text/plain`
requests by wire bytes before `normalizeBody`, HMAC, or JSON parsing. Changing
the global default would affect unrelated routes, so it is rejected.

### Validate record count before claim

After signature verification and body parsing, validate the action-specific
shape before target resolution. For `ingest_records`, reject an array longer
than 500 before `claimEvent` and before `.map(JSON.stringify).join("\\n")`. Keep
the existing action validation order for bounded payloads. A count limit is not
needed for `schedule_run`, but that action remains protected by the route byte
limit.

### Map resource failures to typed 413

Use `SourceWebhookError("resource_limit", ..., 413)` for the operation-level
record-count rejection. Fastify's route body-limit error happens before the
handler; add the smallest transport error mapping needed to emit the same
standard PDPP error envelope and `resource_limit` code for this URL. Do not
make broad global error changes. If the transport cannot identify the route
without widening existing error state, retain Fastify's 413 status and add a
route-specific test documenting the honest envelope behavior.

### Keep constants local and explicit

Export `SOURCE_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024` and
`SOURCE_WEBHOOK_MAX_RECORDS = 500` from the operation/route boundary so tests
and the route registration share one source of truth. These are reference
deployment resource policy values, not PDPP Core protocol constants.

## Risks / Trade-offs

- [Compatibility] Existing valid callbacks above either limit receive 413.
  → Document chunking and distinct event ids; preserve the global limit for
  unrelated endpoints.
- [Error mapping] Fastify rejects body overflow before the source operation.
  → Test actual HTTP behavior and keep the mapping narrowly scoped to the
  source-webhook URL.
- [Partial state] Existing downstream ingest can reject individual records.
  → Resource checks happen before claim, so a resource-rejected callback does
  not consume its `(source_id,event_id)` replay slot.

## Migration Plan

Deploy the route and operation limits together with the OpenSpec delta and
tests. Source adapters should emit one signed callback per bounded chunk. A
rollback is a code revert; no durable schema or replay-row migration is
required.
