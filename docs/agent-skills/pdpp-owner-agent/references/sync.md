# Owner-agent sync reference

This is the deeper reference for keeping a trusted local owner agent's view of all
current and future owner data token-efficient. Read `SKILL.md` and
`daisy-runbook.md` first. Everything here assumes a valid owner-level bearer read at
call time and never echoed.

The owner-agent profile reuses the same `/v1/*` read shapes as the grant-scoped
`pdpp-data-access` skill; the difference is the credential and the goal (a durable,
incremental local mirror rather than a single task-scoped read). The query-cookbook in
`pdpp-data-access/references/query-cookbook.md` remains the source of truth for exact
query shapes; this file covers the owner-agent sync strategy that sits on top of them.

## Principle: discover, then read deltas

A correct owner-agent never answers a question by scanning every record. The pattern is:

1. **Metadata first.** `/v1/schema` → connectors, streams, fields, capability flags.
   Then `/v1/streams` → the streams and connections currently visible. Build every query
   off this response, not from memory.
2. **Stable identity.** Use `connection_id` to attribute records and key your local sync
   state. A multi-connection deployment (two Gmail accounts, two banks) needs per-connection
   cursors, not one global cursor.
3. **Deltas, not scans.** After the first bounded pass, every refresh uses
   `changes_since=<cursor>` plus declared filters, pagination, and field projection.
4. **Refresh metadata on a cadence.** New streams and connections appear over time;
   re-fetch schema/stream metadata periodically so "future data" is discovered, not guessed.

## Token-efficient levers (use all that the schema advertises)

| Lever | What it saves | How |
| --- | --- | --- |
| Metadata-first | avoids reading data you can't interpret | `/v1/schema`, `/v1/streams` before record reads |
| Stable `connection_id` | avoids re-attributing / re-scanning per source | key cursors by `(stream, connection_id)` |
| `changes_since` cursors | avoids re-reading unchanged records | `?changes_since=<cursor>`; bootstrap `=beginning` |
| Pagination cursors | bounds each call, enables resume | follow the declared next-page cursor |
| Declared filters | server-side narrowing | only filters `/v1/schema` advertises for the stream |
| Field projection | smaller payloads | request only fields you need |
| Blob references | defers large bytes | follow `blob_ref.fetch_url` only when needed |
| Event subscriptions | low-latency push, no poll loop | only with a durable HTTPS receiver (below) |

Do not invent filters, fields, or endpoints. If `/v1/schema` does not advertise a
capability, do not use it; trust the schema.

## Local sync state

Persist, per `(stream, connection_id)`:

- the latest pagination position reached in initial sync;
- the latest `changes_since` cursor returned;
- the timestamp of the last successful sync;
- the last schema/stream-metadata refresh time.

Keep this in Daisy's local state store (the operator's machine), not in prompts or logs.
Cursors are not secrets, but the records they let you fetch are the operator's data —
treat the local mirror with the same care as the credential's directory.

## Callback vs. polling — the decision

Both keep you current. The choice is determined by whether you have a **durable, reachable,
valid-TLS HTTPS callback receiver** — not by preference.

### Use event subscriptions only when ALL of these hold

- You have a callback URL that is **HTTPS with a valid TLS certificate** (not self-signed,
  not plain HTTP).
- The receiver is **durable and reachable from the reference server** — it stays up and is
  not behind NAT/localhost the server cannot reach.
- The deployment **advertises** event-subscription support in its discovery metadata.

When all hold, you MAY create subscriptions for low-latency notification. Event payloads
carry a `changes_since` cursor and **never** record bodies — on each event, run an
incremental sync (below) from that cursor.

### Otherwise, poll with backoff

Most local owner agents — including a laptop-resident Daisy with no public callback — do
**not** have a durable valid-TLS HTTPS receiver. In that case:

- Use cursor polling: periodically run the incremental sync from stored cursors.
- Back off when nothing changes (e.g. widen the interval up to a cap), and tighten it after
  a burst of changes.
- Refresh schema/stream metadata on a slower cadence than record polling.
- **Do not** point a subscription at an unreachable local endpoint "just in case." A
  subscription the server cannot deliver to is worse than honest polling: it churns
  delivery failures and may auto-disable.

If you are unsure whether your receiver qualifies, you do not qualify — poll.

## Incremental sync recipe

For each `(stream, connection_id)` with a stored cursor:

```bash
TOKEN="$(read-owner-cred)"
curl -fsS \
  "$RS_URL/v1/streams/<stream>/records?changes_since=<stored-cursor>&limit=200&order=asc" \
  -H "Authorization: Bearer $TOKEN" | jq '{records: .records, next: .cursor}'
unset TOKEN
```

- Bootstrap a never-synced stream with `changes_since=beginning`.
- Page until the response stops advancing the cursor; persist the final cursor.
- Apply only schema-declared filters and request only needed fields.
- Fetch `blob_ref.fetch_url` lazily, for blobs you actually surface.

## Failure handling

- `invalid_token` / inactive introspection → the operator revoked or the credential
  expired. Stop; surface non-secret status; do not loop. Re-onboarding is an operator
  decision.
- `unsupported_capability` → you used a lever the schema did not advertise. Re-read
  `/v1/schema` and drop the lever.
- A subscription transitions to `disabled_failure` → your receiver was unreachable. Switch
  to polling; do not recreate the subscription against the same unreachable endpoint.
- A subscription transitions to `disabled_revoked` → the underlying authority was revoked;
  it is not recoverable. Stop and tell the operator.
