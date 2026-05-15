# Tasks

## 1. Preflight And Configuration

- [x] Add a Gmail attachment hydration/backfill preflight that checks Gmail credentials, `PDPP_RS_URL`, `PDPP_OWNER_TOKEN`, and blob upload availability before attachment backfill starts.
- [ ] Make Docker documentation or scripts expose the required env and fail with a clear message when attachment hydration is requested without upload capability.
- [ ] Preserve the existing `PDPP_GMAIL_MAX_ATTACHMENT_BYTES` policy and document that it applies to both incremental hydration and historical backfill.

## 2. Backfill State Model

- [x] Add an `attachments.all_mail` cursor with `uidvalidity`, `backfilled_through_uid`, and completion metadata without changing `messages.all_mail.uidnext` semantics.
- [x] Reset or invalidate the attachment backfill cursor safely when Gmail `UIDVALIDITY` changes.
- [x] Ensure normal incremental sync hydrates new attachments while the explicit backfill cursor covers historical UIDs.

## 3. Historical Rehydration

- [x] Implement an explicit attachment backfill run scope, for example `streamsToBackfill: ["attachments"]`, that revisits historical All Mail UIDs independently of the messages cursor.
- [x] Fetch message bodystructure and attachment bytes for historical attachment-bearing messages without emitting unrelated streams unless requested.
- [x] Re-emit existing attachment records with stable ids and populated `blob_ref` when hydration succeeds.
- [x] Keep metadata-only attachment records with truthful `hydration_status` when bytes cannot be fetched.

## 4. Idempotency And Persistence

- [ ] Prove rerunning backfill for the same attachment produces the same record id, `content_sha256`, and content-addressed `blob_id`.
- [ ] Prove the blob store does not duplicate bytes and retains correct `(blob_id, connector_id, stream, record_key)` bindings across repeated backfill runs.
- [ ] Ensure backfill does not inline attachment bytes into records, logs, stdout diagnostics, or run timelines.

## 5. Failure And Gap Reporting

- [ ] Add a non-secret gap summary for attachment backfill runs with counts for hydrated, already hydrated, too large, failed, unavailable/skipped, and remaining historical gaps.
- [ ] Surface the summary in connector output and the reference `_ref` run timeline or existing equivalent run-inspection surface.
- [ ] Do not advance `attachments.all_mail.backfilled_through_uid` past a window until the window's records and gap summary are durable.

## 6. Tests And Docker Proof

- [ ] Add Gmail tests for a historical metadata-only attachment after `messages.all_mail.uidnext` has advanced.
- [ ] Add resume/idempotency tests for interrupted and repeated attachment backfill.
- [ ] Add preflight tests for missing Gmail credentials, missing `PDPP_RS_URL`, missing `PDPP_OWNER_TOKEN`, and invalid max-size env.
- [ ] Add or update reference query/blob tests proving a rehydrated historical Gmail attachment can be fetched via `expand=attachments` and `blob_ref.fetch_url`.
- [ ] Document and run a Docker acceptance path that proves historical Gmail attachment backfill, or records explicit setup constraints when live Gmail credentials are unavailable.

## 7. Acceptance Checks

- [x] Run `openspec validate add-gmail-attachment-backfill --strict`.
- [x] Run the Gmail connector test suite.
- [ ] Run relevant blob/query/reference tests touched by the implementation.
- [ ] Run the Docker acceptance path, or record the exact missing env/credential blocker and the local test substitute used.
