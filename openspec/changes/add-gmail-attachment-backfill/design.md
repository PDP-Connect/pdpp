# Design

## Current State

Gmail attachment hydration exists for messages that pass through `processMessage` with the `attachments` stream requested. The hydrated record receives `blob_ref`, `content_sha256`, and `hydration_status: "hydrated"`; failures preserve metadata with a bounded error field. Blob persistence is already content-addressed and idempotent at the reference substrate.

The remaining gap is historical coverage. `selectAllMailFetchRange` no longer rewinds All Mail merely because `attachments` is requested. That avoids expensive resyncs, but it means records already past `messages.all_mail.uidnext` will not be revisited for attachment hydration unless a separate attachment backfill path exists.

## Decision

Implement Gmail attachment backfill as an explicit, resumable per-stream operation with its own cursor and reporting. Normal incremental message sync remains responsible for new mail. Attachment backfill is responsible for historical UIDs whose messages are already known or whose UID range predates the current messages cursor.

The backfill cursor should live under the `attachments` stream state, for example:

```json
{
  "attachments": {
    "all_mail": {
      "uidvalidity": 123,
      "backfilled_through_uid": 456,
      "completed_at": "2026-05-15T00:00:00.000Z"
    }
  }
}
```

The messages cursor remains under `messages.all_mail` and must not be rewound just to hydrate attachments.

## SLVP Done Criteria

The smallest lovable valuable product is done when a Docker operator can run Gmail collection and prove all accessible attachment-bearing mail is either hydrated or truthfully reported as not hydrated.

- Env preflight: Docker startup or connector-run preflight reports a clear blocker when Gmail credentials, `PDPP_RS_URL`, `PDPP_OWNER_TOKEN`, or blob upload capability are missing for attachment hydration/backfill.
- Historical rehydration: a backfill run revisits historical All Mail UIDs independently of `messages.all_mail.uidnext` and emits attachment records for pre-existing attachment-bearing messages.
- Idempotent blob persistence: rerunning the backfill does not duplicate blob bytes or create unstable attachment identities; existing hydrated records may be re-emitted with the same record id and content-addressed `blob_id`.
- Partial failure reporting: inaccessible, oversized, malformed, or transiently failed attachments remain visible as metadata records with `hydration_status` and bounded non-secret diagnostics.
- Gap reporting: run output and `_ref` timeline surfaces summarize attachment coverage with counts for hydrated, already hydrated, too large, failed, unavailable/skipped, and remaining historical gaps.
- Resume safety: interrupted backfills resume from the last committed attachment cursor and do not mark a UID range complete until records and any gap summary for that range have been durably emitted.
- Docker proof: the documented Docker validation path can seed or use a real Gmail account with an old attachment, run backfill after state has advanced, then fetch the attachment through `expand=attachments` and `blob_ref.fetch_url`.

## Operational Shape

Backfill should be opt-in at first through an explicit run scope or runtime option such as `streamsToBackfill: ["attachments"]`. The scheduler may later automate it, but this change should first make the operation deterministic and auditable.

During a backfill run, the connector should:

1. Read normal Gmail credentials and blob-upload env.
2. Select All Mail and derive `uidvalidity`.
3. Determine a bounded UID window from `attachments.all_mail.backfilled_through_uid` and the current mailbox high-water mark.
4. Fetch message structures for that window and process only attachment records unless the run scope also requests sibling streams.
5. Upload bytes through the existing blob seam.
6. Emit attachment records and progress/gap summaries.
7. Commit `attachments.all_mail.backfilled_through_uid` only after the window's records and summary are durable.

## Non-Goals

- No new public blob endpoint.
- No `/attachments/:id/content` route.
- No OCR, PDF parsing, or extracted attachment text.
- No cross-connector blob policy changes.
- No implicit full mailbox rewind during ordinary incremental sync.

## Risks And Mitigations

- Backfill can be expensive for large mailboxes. Keep windows bounded, expose progress, and make the operation resumable.
- Gmail may reject or throttle repeated fetches. Treat retryable failures as partial gaps rather than false success.
- Blob env may be absent in Docker. Fail preflight before doing mailbox work when attachment hydration is requested.
- Existing metadata-only rows may not include enough source locator detail. If needed, use Gmail message id plus decoded bodystructure part path as the stable source locator and add tests before changing record shape.

## Acceptance Checks

- `openspec validate add-gmail-attachment-backfill --strict`
- Gmail connector unit/integration tests cover historical backfill after `messages.all_mail.uidnext` has advanced.
- Blob-store or reference query tests prove rehydrated historical attachments are fetchable only through visible `blob_ref.fetch_url`.
- Docker acceptance command documents required env and produces a gap summary rather than a false green when credentials or blob upload are missing.
