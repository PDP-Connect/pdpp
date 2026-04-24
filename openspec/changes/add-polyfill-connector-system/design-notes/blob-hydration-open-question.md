# Open question: blob-hydration as a protocol primitive

Status: sprint-needed
Owner: project owner
Created: 2026-04-19
Updated: 2026-04-24
Related: `openspec/changes/add-polyfill-connector-system/tasks.md` (Gmail attachment blob collection), `openspec/changes/add-polyfill-connector-system/design-notes/layer-2-coverage-gmail-ynab-usaa-github.md`, `pdpp-trust-model-framing.md`

**Status:** open
**Raised:** 2026-04-19
**Framing (added 2026-04-20):** How blobs are addressed and whether self-export includes bytes both depend on whether the primary consumer is the owner or a third-party client. See `pdpp-trust-model-framing.md`.
**Trigger:** Layer 2 audits (`layer-2-coverage-gmail-ynab-usaa-github.md`, `layer-2-coverage-chatgpt-claude-codex.md`) found that every connector dealing with binary payloads invents its own handling; the spec is silent on how records reference bytes, and recent work on Gmail `message_bodies` made this explicit enough to be worth naming.

## What blob-hydration means

"Blob-hydration" is the pattern where a stream's records reference a larger binary (or large-text) payload that is addressable separately from the record itself. Today every polyfill connector invents its own answer:

- **Gmail attachments** — metadata stream carries size, mimetype, filename; body bytes are not fetched.
- **Gmail message bodies** — just promoted to their own stream (`message_bodies`) so body text/HTML is grantable separately from headers (see `packages/polyfill-connectors/manifests/gmail.json` and `connectors/gmail/index.js`). The stream *inlines* body strings today; no `blob_ref` handle, no content hash.
- **USAA statements** — manifest declares `document_url` and `pdf_sha256`; both always null because the connector does not drive PDF download.
- **ChatGPT uploaded files** — `/backend-api/files/{id}` has metadata; byte retrieval requires a separate auth-gated `download_url` request.
- **Slack files** — metadata is captured (URL, size, mimetype, uploader); bytes require a session-authed fetch.
- **iMessage attachments** — file paths reference `~/Library/Messages/Attachments/`; no declared retrieval path.
- **Claude Code tool results** — some outputs are large text blobs already in the jsonl, some reference `tool-results/*.txt`; no consistent handle.
- **Google Takeout / Twitter archive** — file-based connectors already own the paths; no fetch surface at all.

`spec-core.md` defines `GET /v1/streams/{stream}/records/{key}` as returning a record with fields. If a field references a binary, today the client has to guess: sometimes it's a URL, sometimes a filesystem path, sometimes there's nothing to chase.

## Why this is a spec question

- **Consent presentation.** "This grant includes Gmail message bodies" reads differently from "This grant includes Gmail attachment bytes"; current manifests cannot express the distinction cleanly.
- **Bandwidth.** Record queries should be fast; blobs can be huge. Conflating them bloats the query contract.
- **Authorization.** A client granted the `attachments` stream may not automatically be granted the bytes behind them — this is a grant-scope concern.
- **Freshness.** Metadata is incremental and cursor-addressed; blobs are typically immutable by content-hash. Different caching/versioning semantics.
- **Portability.** When the owner self-exports, is a blob reference a URL (valid only while the RS runs) or a content-addressable handle that survives relocation?

## What a primitive would need to supply

1. A way for a manifest to declare "this field references a blob you can fetch separately."
2. A way for a record to carry an opaque `blob_ref` handle.
3. An endpoint (proposed shape: `GET /v1/streams/{stream}/records/{key}/blobs/{ref}`) that returns the bytes with a useful `Content-Type`.
4. A grant-scope affordance — "blobs requested" vs "metadata only."
5. An optional content-hash field so blob references are verifiable across transports.

## Candidate shapes

### A. Sibling endpoint

`GET /v1/streams/{stream}/records/{key}/blobs/{blob_name}` returns bytes with `Content-Type` from the manifest. Manifests declare `blob_refs: ["body_html", "body_text"]` on the record. Grant scope gains a boolean per blob. Pro: smallest surface; records stay thin. Con: introduces a second record-keyed endpoint class.

### B. Field-level blob declaration

Fields that are blobs are marked in the manifest schema with `{"type": "blob", "max_size": ..., "mime_types": [...]}`. Records carry `{"body_html": {"blob_ref": "sha256:abc...", "bytes": "...maybe inlined..."}}`. Pro: one schema describes both metadata and bytes; inline-or-deferred is a transport detail. Con: schema gets union-y; clients must branch on field shape.

### C. Separate stream convention

Any field-level blob is promoted to its own stream — exactly what the Gmail `message_bodies` split did. Pro: no spec change; reuses existing grant/scope machinery. Con: stream count fans out; the "metadata/binary pair" idea stays implicit (see `slackdump-design-gaps.md` Gap 3).

### D. Punt — let connectors handle bytes out-of-band

The spec does not mandate a blob primitive; the RS exposes records, and consumers figure it out. Pro: zero spec work. Con: every connector keeps inventing a shape; consent cards cannot say anything consistent about binary payloads.

## Concrete scale data from the Slack connector (2026-04-20)

One workspace, 10-year history, yielded a real measurement that sharpens the choice between candidate shapes:

- **24 GB of file attachments** (`__uploads/` dir from slackdump), 15,410 files
- **Largest single file: 810 MB** (IMG_8109.MOV — a user-uploaded video)
- Top 10 files = ~5 GB, all videos or screen recordings
- **305 files over 10 MB**, 1,940 between 1–10 MB, 13,130 under 1 MB
- Distribution by channel is long-tailed: top 6 channels = 13 GB (56%); 50+ channels under 0.5 GB each

**What this rules out:**

Shape B's optional "...maybe inlined..." path is not viable for Slack attachments. An 810 MB video cannot be inlined in a record payload; a client querying `/v1/streams/files/records` would be forced to stream gigabytes it didn't ask for. Any chosen shape MUST have a deferred/separate fetch path for the actual bytes.

**What this reinforces:**

Content-addressing is already how Slack (and Gmail, iMessage, Google Takeout, etc.) organize their own binaries on disk. slackdump stores files under `__uploads/<file_id>/`, where `file_id` is Slack's hash. Candidate A (sibling endpoint with `sha256:...` handles) and Candidate B (field-level blob declaration with content hash) both align with existing disk layouts; Candidate C (separate stream) punts the problem but doesn't solve "where do the bytes actually live."

**What this opens:**

The `rs-storage-topology-open-question.md` decision compounds with this one. The reference impl's `blobs` SQLite table schema currently has a `data BLOB` column — SQLite can nominally hold 1 GB per BLOB, but 24 GB of video files in a SQLite column is operationally untenable (VACUUM is impossible, backups unmanageable, mmap thrashes). This suggests: whatever shape wins, **the reference impl likely cannot implement it by stuffing bytes into the existing `blobs.data` column** — it needs filesystem-or-object-store backing behind the same HTTP surface. That's a concrete nudge toward the hybrid "content-addressed filesystem, SQLite metadata" pattern slackdump itself uses.

## Cross-cutting

- **Authored artifacts vs. activity streams** (`layer-2-coverage-chatgpt-claude-codex.md`, cross-cutting #1): user-authored blobs (uploaded images, docs, custom-GPT profile images) likely want different provenance than activity-log blobs.
- **Semantic classes:** blobs may need their own class (candidate: `content_addressed`).
- `slackdump-design-gaps.md` Gap 3 (metadata/binary stream pairs as a first-class pattern).
- `owner-self-export-open-question.md`: if blob URLs are transport-bound they break portable self-export.
- `rs-storage-topology-open-question.md`: where bytes live affects how they are addressed.

## Action items

- [ ] Decide blob-primitive shape (A, B, C, or D).
- [ ] If A or B wins, draft a spec section for records-with-blob-refs and the fetch endpoint.
- [ ] Align current Gmail `message_bodies` work with the chosen approach — the stream is in place and can adopt a handle shape without breaking its schema.
- [ ] Cross-check against USAA statements and ChatGPT files as the next two candidates.
