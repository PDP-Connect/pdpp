# Open question: blob-hydration as a protocol primitive

**Status:** open
**Raised:** 2026-04-19
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
