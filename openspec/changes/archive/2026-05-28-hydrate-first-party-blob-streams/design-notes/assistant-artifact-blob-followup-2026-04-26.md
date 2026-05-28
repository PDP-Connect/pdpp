# Assistant Artifact Blob Hydration — Follow-Up (ChatGPT, Claude Code, Codex, iMessage, WhatsApp)

Status: open
Owner: owner/connectors
Created: 2026-04-26
Related: hydrate-first-party-blob-streams, polyfill-connectors:chatgpt, polyfill-connectors:claude_code, polyfill-connectors:codex, polyfill-connectors:imessage, polyfill-connectors:whatsapp

## Why this is its own note

These five connectors share a structural problem: their "attachment-like"
surfaces are a mix of (a) source-hosted bytes accessible via auth, (b)
local-filesystem bytes already on the user's machine, and (c) opaque
metadata IDs that point at neither. Each requires the same design
clarification before any byte hydration is safe.

## ChatGPT

- Current state: `chatgpt.messages.attachment_ids[]` is a string array.
  No `attachments` stream exists.
- Design question: are these download-via-API artifacts (file_ids the
  Files API can resolve) or in-conversation references that only render
  in the web UI? Answer determines whether a sibling
  `chatgpt.attachments` stream with `blob_ref` makes sense.
- Risk: ChatGPT's downloadable artifact API has been rate-limited and
  selectively gated for non-Plus accounts. Hydration must not break
  metadata-only sync when the artifact endpoint refuses; preserve
  `hydration_status: "unavailable"`.
- Default: defer until a consumer asks. The metadata-only ID list is
  honest about what we have today.

## Claude Code

- Current state: `claude_code.attachments` is misnamed — it's mostly
  non-message events (hook outputs, tool uses, file-history snapshots)
  plus persisted tool-result files written to disk. `content_bytes` and
  `content_preview` fields exist; `content_preview` is truncated, full
  bytes for tool-result files live under the user's `.claude/` tree.
- Design question: split the stream. Two cleaner options:
  - Rename current `attachments` to `events` and add a new
    `claude_code.tool_result_blobs` stream that strictly carries
    file-on-disk → `blob_ref` rows.
  - Keep one stream with a `kind` discriminator (`event` vs `blob`) and
    only populate `blob_ref` on `kind: "blob"` rows.
- Risk: changing the existing stream name is a breaking manifest change.
  The split-stream option is the right long-term answer; the
  discriminator option is the lower-friction interim move.

## Codex

- Current state: no file-attachment surface. If Codex adds one (e.g. a
  function-call result that persists a file), treat it like Claude Code's
  `tool_result_blobs` stream from day one — don't repeat the misnamed-
  `attachments` mistake.

## iMessage

- Current state: `imessage.messages.has_attachments` boolean exists; the
  macOS `chat.db` SQLite store has actual attachment file paths in the
  `attachment` and `message_attachment_join` tables, with bytes on disk
  under `~/Library/Messages/Attachments/`.
- Design question: add a sibling `imessage.attachments` stream with FK
  to `messages.id`, `blob_ref`, `content_sha256`, `hydration_status`. The
  source is filesystem, not network, so `hydration_error` taxonomy
  differs (no signed URLs to scrub; instead, missing-file or
  permission-denied cases dominate).
- Local-vs-network parallel: the local-source path needs the same
  `enforceMaxBytes` guard so a runaway attachment doesn't OOM the upload
  body. Re-use the Gmail helper.

## WhatsApp

- Current state: `whatsapp.messages.has_attachment` boolean exists.
  Export-bundle path includes media files in a sibling directory.
- Design question: same as iMessage. Add `whatsapp.attachments` stream
  whose source is the export-bundle filesystem layout.

## Common decisions across all five

1. **Filesystem-source vs network-source.** The Gmail upload helper
   accepts an `AsyncIterable<Buffer | Uint8Array | string>`. Filesystem
   sources should wrap `fs.createReadStream` in that contract; do NOT
   load the file into memory.
2. **Failure taxonomy.** Add `unavailable` (file missing on disk) and
   `blocked` (permission denied) to the per-connector `hydration_status`
   enum once the connector actually exercises those branches. Don't
   pre-add enum values that aren't reachable.
3. **No `hydration_error` leakage.** For iMessage/WhatsApp the path
   itself can be sensitive (it leaks attachment filenames). Use the same
   `boundedHydrationError` truncation pattern Gmail uses; do not include
   raw paths.

## Out of scope for this follow-up

- OCR / transcription. Audio/video assistant artifacts are a downstream
  capability, not part of byte hydration.
- Cross-connector dedup. Content-addressed sha256 already de-dups within
  the RS substrate; no extra logic needed.

## Exit criteria for any of the five to land

- Stream-shape decision documented (split vs discriminator for Claude
  Code; new sibling stream for iMessage/WhatsApp; new sibling stream
  for ChatGPT once the API answer is settled).
- Manifest fields added.
- Connector emits `blob_ref` for at least one real attachment in a
  fixture-backed run.
- Query test gates `expand=attachments.blob_ref` correctly.
- `enforceMaxBytes` reused (do not reinvent).
