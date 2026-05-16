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
- [x] Expose the explicit backfill *request* through the collector-runner CLI as `--backfill-streams attachments` for `--connector gmail`, with sensible defaults (`tsx connectors/gmail/index.ts`, full Gmail stream set, `network` runtime binding) so operators do not need to hand-build the START envelope. Scope: the CLI threads `streamsToBackfill` into the connector's START envelope. The CLI does not yet persist or replay `STATE` between runs — `runCollectorConnector` filters only `RECORD` messages — so a resumable multi-window backfill loop is a separate follow-up that needs a state load/replay/put contract on `LocalDeviceClient`.

## 4. Idempotency And Persistence

- [x] Prove rerunning backfill for the same attachment produces the same record id, `content_sha256`, and content-addressed `blob_id`.
- [x] Prove the blob store does not duplicate bytes and retains correct `(blob_id, connector_id, stream, record_key)` bindings across repeated backfill runs.
- [x] Ensure backfill does not inline attachment bytes into records, logs, stdout diagnostics, or run timelines.

## 5. Failure And Gap Reporting

- [x] Add a non-secret gap summary for attachment backfill runs with counts for hydrated, too large, failed, unavailable/skipped, and remaining historical gaps; omit `already_hydrated` until the runtime can measure existing blob/record state directly.
- [x] Surface the summary in connector output and the reference `_ref` run timeline or existing equivalent run-inspection surface.
- [x] Do not advance `attachments.all_mail.backfilled_through_uid` past a window until the window's records and gap summary are durable.

## 6. Tests And Docker Proof

- [x] Add Gmail tests for a historical metadata-only attachment after `messages.all_mail.uidnext` has advanced (see backfill-mode tests in `connectors/gmail/integration.test.ts`; tests drive `emitMessagesPass` in the same attachment-only mode `runAllMailPasses` uses, not the full IMAP-backed pass).
- [x] Add idempotency tests for repeated attachment backfill of the same UID (covered in `connectors/gmail/integration.test.ts`).
- [ ] Add resume tests for interrupted attachment backfill (crash mid-window, replay from durable cursor). Requires either an IMAP test double for `runAllMailPasses` or collector-runner `STATE` persistence/replay; both are out of scope for this branch.
- [x] Add preflight tests for missing Gmail credentials, missing `PDPP_RS_URL`, missing `PDPP_OWNER_TOKEN`, and invalid max-size env.
- [x] Add CLI tests proving `--backfill-streams attachments` threads into `START.streamsToBackfill` via `buildCollectorStartMessage` (`bin/collector-runner.test.ts`). Scope: START envelope wire only — collector-runner discards `STATE` today.
- [ ] Add or update reference query/blob tests proving a rehydrated historical Gmail attachment can be fetched via `expand=attachments` and `blob_ref.fetch_url`.
- [ ] Document and run a Docker acceptance path that proves historical Gmail attachment backfill, or records explicit setup constraints when live Gmail credentials are unavailable.

## 7. Acceptance Checks

- [x] Run `openspec validate add-gmail-attachment-backfill --strict`.
- [x] Run the Gmail connector test suite.
- [x] Run relevant blob/query/reference tests touched by the implementation.
- [ ] Run the Docker acceptance path, or record the exact missing env/credential blocker and the local test substitute used.
