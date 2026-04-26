# First-Party Blob Hydration Coverage

Status: open
Owner: owner/connectors
Created: 2026-04-25
Updated: 2026-04-26
Related: hydrate-first-party-blob-streams

## Purpose

Track which first-party connector streams can plausibly collect binary
bytes and how this change classifies them. The audit covers every shipped
manifest under `packages/polyfill-connectors/manifests/` (31 connectors,
111 streams as of 2026-04-26) so that gaps are visible rather than hidden
behind a single "Gmail done" headline.

## Classification Key

- `hydrate now`: implement byte hydration in this change. Manifest already
  declares (or trivially can declare) `blob_ref`, `content_sha256`, and
  `hydration_status`; the connector path can fetch source bytes safely.
- `metadata only`: the stream is intentionally non-binary; metadata is the
  product. No `blob_ref` is appropriate now or expected later.
- `deferred`: bytes plausibly exist and would be valuable, but the work
  needs a focused per-connector slice (auth, size policy, source-availability
  audit, or storage-substrate reconciliation). Each deferred row links to a
  concrete follow-up note rather than a vague TODO.
- `not binary`: there is no collectible binary payload at all.

## Per-Connector Audit (2026-04-26)

The table below classifies every stream that surfaced in the manifest audit
as having any plausible binary candidate. Streams that are obviously pure
metadata (e.g. `accounts`, `labels`, `users`) are summarized at the bottom
under "Streams treated as `not binary` without per-row entries" so the
table stays readable.

| Connector | Stream | Classification | Rationale |
| --- | --- | --- | --- |
| gmail | `attachments` | hydrate now | Shipped vertical slice. Manifest already declares `blob_ref`, `content_sha256`, `hydration_status` enum (`hydrated|deferred|failed|too_large`). IMAP path fetches bytes under the owner's authenticated session; size cap defaults to 25 MiB with `PDPP_GMAIL_MAX_ATTACHMENT_BYTES` override. Idempotent at the content-addressed blob substrate. |
| gmail | `messages` | metadata only | Body bytes live in `message_bodies`; this row carries envelope + attachment-presence signal. No file payload of its own. |
| gmail | `threads` / `labels` / `message_bodies` | metadata only | Pure structured text. No byte payload. |
| slack | `files` | deferred | High value (PDFs, images, snippets). `url_private` requires a Slack token, requests are auth-redirected, and source-side retention is not always permanent. Manifest does not yet declare `blob_ref`. Slack hydration also has to decide whether to also pull `thumb_*` derivatives or only the canonical original. See `slack-blob-followup-2026-04-26.md`. |
| slack | `canvases` | deferred | Canvas bodies live behind `files.slack.com` authenticated URLs and a `quip` doc backend. `content_markdown` is sometimes captured today; the byte payload is a follow-up. Same Slack note. |
| slack | `message_attachments` | not binary | Link-preview unfurls and bot-rendered rich attachments. Image URLs are third-party (`image_url`, `thumb_url`); not owner-controlled and out of grant scope for byte fetch. Capture URLs as metadata only. |
| slack | other streams (workspace, channels, users, messages, reactions, stars, user_groups, reminders, dm_read_states, channel_memberships) | not binary | Pure structured records. |
| chase | `statements` | deferred | Statement PDFs are real binary payload. Current shape stores PDFs at `~/.pdpp/chase-statements/<account>/<YYYY-MM>-<sha8>.pdf` and exposes `pdf_path` + `pdf_sha256` rather than a `blob_ref`. Reconciling this with the reference RS blob substrate is the deferred design question (`blob-hydration-open-question.md` predates this change). See `financial-statement-blob-followup-2026-04-26.md`. |
| chase | `accounts` / `transactions` / `balances` | not binary | Pure structured ledger data. |
| usaa | `statements` | deferred | Same shape and same blocker as Chase: stores PDFs locally with `pdf_path`/`pdf_sha256` rather than emitting a reference `blob_ref`. Tier A scrape refactor is in flight; this row will need a `blob_ref` migration once the on-disk archive policy is reconciled with the RS substrate. See `financial-statement-blob-followup-2026-04-26.md`. |
| usaa | `accounts` / `transactions` / `inbox_messages` / `credit_card_billing` | not binary | Structured ledger and inbox text. `inbox_messages` could in principle carry attachments later; nothing observed in current scrape. |
| amazon | `order_items` | metadata only | `item_image_url` is a third-party CDN URL, not an owner-controlled artifact, and the pixel itself has very low assistant value vs. the per-item metadata already captured. No invoice PDF stream exists yet. |
| amazon | (potential) order invoices/receipts | deferred | Real binary payload (invoice PDFs, gift receipts) would be valuable; no manifest stream declares them today. Adding an `order_invoices` stream is a separate scope-bearing change, not a tweak to this one. See `commerce-receipt-blob-followup-2026-04-26.md`. |
| heb / wholefoods / doordash / shopify / uber | `orders` / `order_items` / `trips` | metadata only | All currently model purely-structured order or trip records. No invoice/receipt PDF stream exists. Add such a stream only when there's a concrete consumer. |
| chatgpt | `messages` | deferred | `attachment_ids[]` exists on the schema but the connector emits IDs only; no separate `attachments` stream exists yet, and ChatGPT's downloadable artifact API is gated. Promoting from "string ID list" to "attachments stream with `blob_ref`" is a follow-up. See `assistant-artifact-blob-followup-2026-04-26.md`. |
| chatgpt | other streams (conversations, memories, custom_gpts, custom_instructions, shared_conversations) | not binary | Structured text. |
| claude_code | `attachments` | deferred | Despite the name, this stream is "non-message events" (hook outputs, tool uses, file snapshots) plus tool-result blob files written to disk. `content_bytes` and `content_preview` exist; full byte payload lives on local disk under the user's `.claude/` tree. Promoting persisted tool-result files to `blob_ref` is plausible but the stream's mixed nature (events vs. true blobs) needs its own design pass. Same follow-up note as ChatGPT. |
| claude_code | other streams (sessions, messages, skills, memory_notes, slash_commands) | not binary | Structured text/log records. |
| codex | all streams (sessions, messages, function_calls, rules, prompts, skills) | not binary | No file-attachment surface today. If codex grows file-snapshot capture later, treat it like Claude Code's deferred row. |
| github | `gists` | deferred | Gist files are textual but can be binary; current `files` array carries lightweight metadata. Promoting binary gist contents to `blob_ref` requires deciding whether textual gists should be records vs. blobs. Most gist file contents fit under structured text and are better as records, but binary gists exist. See `source-host-blob-followup-2026-04-26.md`. |
| github | `pull_requests` | metadata only at PR level | The PR record itself is metadata. Diff/patch payloads are derivable via a separate API call and are not represented in this manifest. Adding a "pr_artifacts" stream (release assets, raw patches) is a separate change. Same follow-up note. |
| github | other streams (user, repositories, starred, issues) | not binary | Structured records and metadata. |
| reddit | all streams (submitted, comments, saved, upvoted, downvoted, hidden, gilded) | metadata only | Schema captures URLs and link metadata; image/video payload lives on Reddit's CDN behind owner-agnostic URLs. Hydrating media is plausible but low priority and would mirror social-media archival rather than data-as-evidence use cases. See `social-media-blob-followup-2026-04-26.md`. |
| meta | `posts` | metadata only | Schema captures `media_type` only. Source bytes live on Meta CDN; treat as social-media archival follow-up alongside Reddit. |
| twitter_archive | `tweets` | metadata only | Schema records `media_count` only; archive bytes are user-supplied via Twitter's exporter and out of scope for live hydration. Same social-media follow-up. |
| google_takeout | `youtube_watch_history` | not binary | History row only references the upstream video URL; no owner-collectible binary. |
| google_takeout | other streams (location_history, search_history) | not binary | Structured records. |
| imessage | `messages` | deferred | `has_attachments` boolean already exists; the macOS chat.db backing store has the actual attachment files at known on-disk paths. Promoting these to a sibling `attachments` stream with `blob_ref` is feasible (filesystem-source rather than network-source). Local-vs-source boundary parallels Claude Code; see assistant-artifact follow-up. |
| whatsapp | `messages` | deferred | `has_attachment` boolean exists; export bundles include media files. Same on-disk hydration pattern as iMessage. Same follow-up. |
| linkedin / loom / anthropic / spotify / strava / oura / apple_health / pocket / notion / ical / ynab | all streams | not binary or metadata only | Either structured-only by design (ynab explicitly excludes statements; oura/apple_health are sensor streams) or scaffolded without observed binary surfaces. Loom video bytes are deferred-eligible if the stream ever ships beyond scaffold; tracked in social-media-blob follow-up. |

### Streams treated as `not binary` without per-row entries

Every stream in `accounts`, `users`, `channels`, `labels`, `categories`,
`balances`, `transactions`, `payees`, `category_groups`, `payee_locations`,
`scheduled_transactions`, `months`, `month_categories`, `subscriptions`,
`memberships`, `reminders`, `playlists`, `saved_tracks`, `top_artists`,
`recently_played`, `events` (ical), `experience`, `education`, `skills`
(linkedin/claude_code/codex), `transcripts` (loom metadata-only row),
`videos` (loom metadata-only row), `posts` (meta — already addressed),
`activities` (strava), `sleep` / `readiness` / `activity` (oura),
`location_history` / `search_history` (google_takeout) is structured
metadata with no collectible binary payload. They are intentionally not
listed individually — they have no decision to make. If a future stream
in any of these connectors gains a binary surface, add a row above.

## Implementation Slice And Sequencing

The first implementation slice is **Gmail attachments**, which is already
shipped and merged (Tasks 2.x and 3.x). It validated the end-to-end
contract: `enforceMaxBytes` size policy → content-addressed upload to
`POST /v1/blobs` → manifest `blob_ref` + `content_sha256` →
`expand=attachments` exposes `blob_ref.fetch_url` only when the grant
includes `attachments.blob_ref` → `GET /v1/blobs/{blob_id}` returns bytes
behind grant authorization.

Subsequent slices (in order of expected value × tractability):

1. **Slack `files`** — same "fetch via authenticated source session →
   upload to RS" shape as Gmail. Highest reuse of the Gmail pattern.
   Tracked in `slack-blob-followup-2026-04-26.md`.
2. **iMessage / WhatsApp message attachments** — local-filesystem source
   rather than network source. Different code path, same RS contract.
3. **Chase / USAA statements** — requires reconciling the existing
   `~/.pdpp/<bank>-statements/` on-disk archive with the RS blob substrate
   and committing to a single source of truth. The interim two-store world
   (local PDF + RS blob) is the trap to avoid; design note covers it.
4. **ChatGPT / Claude Code persisted artifacts** — deferred until the
   "events vs. true blobs" stream-shape question is resolved.
5. **Amazon order invoices, GitHub pr_artifacts** — require new manifest
   streams; only worth doing when a concrete consumer exists.
6. **Reddit / Meta / Twitter / Loom media archival** — lowest priority;
   plausible later but not part of this change's value story.

Streams that need separate design before any byte collection: Chase
statements (storage substrate reconciliation), Claude Code attachments
(stream-shape ambiguity), and any new "invoices/receipts/artifacts"
stream that doesn't exist in the manifest today.

## Open Questions

- ~~What default max blob size is safe for local reference deployments?~~
  Settled for the Gmail slice: **25 MiB** (Gmail's per-message attachment
  cap). Operator override via `PDPP_GMAIL_MAX_ATTACHMENT_BYTES` (positive
  integer; non-positive/unparseable values fall back to default). Other
  connectors should pick their own conservative defaults aligned with
  source caps.
- Should blob hydration be configurable per connector/profile? Open. The
  current Gmail slice gates only by env var; per-profile gating likely
  belongs in the manifest layer rather than connector code.
- Should failed hydration have a standard `hydration_error_code` field
  shape? Open. Current implementation truncates `hydration_error` to 240
  chars and uses an enum status (`hydrated|deferred|failed|too_large`). A
  separate `hydration_error_code` is likely needed once a second connector
  hits non-overlapping failure modes.
- Should the financial-statement on-disk archive (Chase/USAA) collapse
  into the RS blob substrate, or should the RS substrate reference local
  paths? Open and load-bearing for the next slice. See
  `financial-statement-blob-followup-2026-04-26.md`.
- Which streams should later add extracted text, OCR, or document parsing
  as a separate capability? Out of scope for this change; pull when a
  downstream consumer needs structured content.

## Gmail Slice — Implementation Snapshot (2026-04-25)

- Hydration is gated by a bounded size cap enforced **twice**: once before
  download (when `attachment.size_bytes` declares the source size) and
  once during streaming (against under-reported source sizes), via
  `enforceMaxBytes`. Tests cover both paths.
- Status enum on the Gmail manifest is now
  `hydrated | deferred | failed | too_large`. Other "missing bytes"
  reasons (`unavailable`, `blocked`, `skipped`) are not yet used by Gmail;
  add them to other connectors only when those connectors actually hit
  those branches so the enum reflects observable behavior.
- Idempotency is content-addressed at the reference blob substrate
  (`INSERT OR IGNORE` keyed on sha256). Reruns of the same attachment
  produce the same `blob_id` without duplicating storage; verified by the
  connector-level test "rerun hydration preserves attachment identity and
  idempotent blob identity" plus the reference-side "blob upload is
  content-addressed, idempotent, and fetch-safe through visible blob_ref"
  test.
- IMAP error surfaces never carry signed URLs (the connector uses an
  authenticated IMAP session, not signed-URL HTTP), so no redaction is
  needed in this slice. Other connectors that download via signed URLs
  MUST scrub before populating `hydration_error`.

## Audit Methodology (How To Re-Run)

- Inventory: `ls packages/polyfill-connectors/manifests/*.json` (31
  connectors as of 2026-04-26).
- Per-connector stream list: `jq '.streams[].name'`.
- Candidate filter (any field name matching binary/file/blob heuristics):
  ```
  jq '.streams[]
    | select((.schema | tostring)
        | test("blob_ref|attachment|file_url|download_url|media|image_url|video_url|file_path|filename|mime_type|content_type|size_bytes|byte_size|attachments|files|photos|images|videos|audio|pdf|document"; "i"))
    | .name'
  ```
- Manual classification of each candidate against the four-bucket key.
- Streams not surfaced by the filter are treated as `not binary` unless
  the connector's known semantics say otherwise (the iMessage / WhatsApp
  rows came in via `has_attachment` rather than a binary field name).

When new connectors land, re-run this filter and add a row.
