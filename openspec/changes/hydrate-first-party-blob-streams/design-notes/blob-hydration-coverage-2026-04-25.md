# First-Party Blob Hydration Coverage

Status: open
Owner: owner/connectors
Created: 2026-04-25
Updated: 2026-04-25
Related: hydrate-first-party-blob-streams

## Purpose

Track which first-party connector streams can plausibly collect binary bytes and how this change classifies them.

## Classification Key

- `hydrate now`: implement byte hydration in this change.
- `metadata only`: keep metadata records only; bytes are unavailable or inappropriate for the current connector.
- `deferred`: likely valuable, but needs a focused design or connector-specific slice.
- `not binary`: no collectible binary payload.

## Initial Candidates

| Connector | Stream / surface | Classification | Notes |
| --- | --- | --- | --- |
| Gmail | `attachments` | hydrate now | First vertical slice. Real records currently expose metadata without `blob_ref`; manifest already declares `blob_ref`, `content_sha256`, and `hydration_status`. |
| Slack | uploaded files / message file surfaces | deferred | Needs audit to distinguish Slack message attachments, remote files, snippets, and uploaded binaries. |
| Chase | statements / documents | deferred | Existing manifest history references local PDF paths; needs reconciliation with the RS blob substrate and size/retention policy. |
| USAA | statements / documents | deferred | Browser/download reliability and account-risk handling need review. |
| Amazon | receipts / invoices / exports | deferred | High assistant value; browser download flow and source availability need audit. |
| ChatGPT | uploaded files / artifacts if available | deferred | Need to distinguish API-visible metadata from downloadable source bytes. |
| Claude Code | attachments / local artifacts if available | deferred | May be local filesystem content rather than source-hosted bytes. |
| Codex | attachments / local artifacts if available | deferred | Same local-vs-source boundary question as Claude Code. |
| GitHub | gists, release assets, files | deferred | Some content may be better modeled as text records; binary assets need auth/rate-limit review. |
| Reddit | media / attachments | deferred | Current first-party scope appears thin; audit after real-shape pilot. |
| YNAB | transactions/accounts/etc. | not binary | Current manifest explicitly excludes bank statements/receipts. |

## Open Questions

- ~~What default max blob size is safe for local reference deployments?~~ Settled for the Gmail slice: **25 MiB** (Gmail's per-message attachment cap). Operator override via `PDPP_GMAIL_MAX_ATTACHMENT_BYTES` (positive integer; non-positive/unparseable values fall back to default). Other connectors should pick their own conservative defaults aligned with their source caps.
- Should blob hydration be configurable per connector/profile? Open. The current Gmail slice gates only by env var; per-profile gating likely belongs in the manifest layer rather than connector code.
- Should failed hydration have a standard `hydration_error_code` field shape? Open. The current implementation truncates `hydration_error` to 240 chars and uses an enum status (`hydrated|deferred|failed|too_large`). A separate `hydration_error_code` is likely needed once a second connector hits non-overlapping failure modes.
- Which streams should later add extracted text, OCR, or document parsing as a separate capability? Out of scope for this change; pull when a downstream consumer needs structured content.

## Gmail Slice — Implementation Snapshot (2026-04-25)

- Hydration is gated by a bounded size cap enforced **twice**: once before download (when `attachment.size_bytes` declares the source size) and once during streaming (against under-reported source sizes), via `enforceMaxBytes`. Tests cover both paths.
- Status enum on the Gmail manifest is now `hydrated | deferred | failed | too_large`. Other "missing bytes" reasons (`unavailable`, `blocked`, `skipped`) are not yet used by Gmail; add them to other connectors only when those connectors actually hit those branches so the enum reflects observable behavior.
- Idempotency is content-addressed at the reference blob substrate (`INSERT OR IGNORE` keyed on sha256). Reruns of the same attachment produce the same `blob_id` without duplicating storage; verified by the connector-level test "rerun hydration preserves attachment identity and idempotent blob identity" plus the reference-side "blob upload is content-addressed, idempotent, and fetch-safe through visible blob_ref" test.
- IMAP error surfaces never carry signed URLs (the connector uses an authenticated IMAP session, not signed-URL HTTP), so no redaction is needed in this slice. Other connectors that download via signed URLs MUST scrub before populating `hydration_error`.
