# Slack Blob Hydration — Follow-Up

Status: open
Owner: owner/connectors
Created: 2026-04-26
Related: hydrate-first-party-blob-streams, polyfill-connectors:slack

## Why this is its own note

The Slack manifest has the most file-shaped surfaces of any first-party
connector (`files`, `canvases`, `message_attachments`) and is the natural
second slice after Gmail. It is **not** safe to roll into the Gmail PR:
Slack hydration introduces decisions Gmail did not have to make.

## Decisions required before byte collection

1. **Auth path.** Slack `url_private` and canvas binaries require the
   workspace token. The current connector wraps `slackdump` (subprocess),
   so we have to choose between (a) calling `files.info` + signed URL via
   the same token Slackdump already holds, or (b) post-processing the
   Slackdump archive on disk. (b) avoids extra API quota; (a) hydrates
   incrementally rather than after a full archive run. Default leans (a).
2. **Derivative policy.** Slack returns `thumb_64`/`thumb_360`/etc.
   alongside the original. The reference contract is one `blob_ref` per
   record, so derivatives have to either (i) be ignored, (ii) become
   sibling records on a `file_thumbnails` stream, or (iii) be served
   on-demand by the RS via image-resize. Default: ignore derivatives in
   the first slice; only the canonical original is hydrated.
3. **External / hidden-source files.** `is_external: true` files point at
   third-party hosts (Google Drive, Dropbox). Owner-authorized fetch is
   not guaranteed; emit metadata-only with `hydration_status: "unavailable"`
   and a non-secret reason.
4. **Canvas bodies.** `canvases` already captures `content_markdown`
   opportunistically. The byte payload behind `files.slack.com` is the
   "real" canvas. Hydrating canvases requires either re-using the file
   path (treat canvas as a file) or a separate canvas API call. Default
   leans treat-as-file, status `deferred` until the file slice ships.
5. **Size policy.** Slack supports very large files (1 GB on enterprise
   plans). Mirror Gmail's twice-enforced cap: a per-message size check
   before download and an `enforceMaxBytes` stream guard. Conservative
   default: 100 MiB; operator override via
   `PDPP_SLACK_MAX_FILE_BYTES`. Anything larger goes to
   `hydration_status: "too_large"` with metadata preserved.

## Manifest changes required

- Add `blob_ref` (object|null), `content_sha256` (string|null),
  `hydration_status` (enum), `hydration_error` (string|null) to
  `slack.files`. The enum should be `hydrated | deferred | failed |
  too_large | unavailable | blocked` — Slack actually exercises
  `unavailable` (external files) and `blocked` (workspace policy denies
  download).
- Decide whether `slack.canvases` declares the same fields now or stays
  metadata-only until canvas hydration is in scope. Default: metadata-only
  for canvases until the file slice ships.

## Risks and gotchas

- `slackdump` already writes file bytes to its archive directory. The
  connector must not double-store: either upload from the Slackdump
  on-disk file (and treat it as the source of truth) or skip Slackdump
  for files entirely. Decide before writing code.
- `hydration_error` MUST scrub the Slack signed-URL query string. Unlike
  Gmail's IMAP path, Slack downloads use signed URLs that are sensitive
  if logged.
- Slack rate limits file fetches separately from message fetches; the
  connector needs `p-retry`-style backoff distinct from message pagination.

## Out of scope for this follow-up

- OCR / PDF text extraction.
- `message_attachments` hydration: those are link-preview unfurls, not
  owner-controlled artifacts. They stay metadata-only.
- Derivative thumbnails (see decision 2).

## Exit criteria for the follow-up to land

- Manifest updated with the fields above.
- Connector emits `blob_ref` for at least one real file in a Slackdump-backed
  fixture run.
- `expand=files` exposes `fetch_url` only when the grant includes
  `slack.files.blob_ref` (parallel to the Gmail attachments query test).
- Idempotent rerun does not duplicate stored bytes.
- `hydration_status: "unavailable"` is exercised by an external-file fixture.
