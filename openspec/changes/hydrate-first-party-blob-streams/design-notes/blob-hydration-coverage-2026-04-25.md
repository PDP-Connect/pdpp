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

- What default max blob size is safe for local reference deployments?
- Should blob hydration be configurable per connector/profile?
- Should failed hydration have a standard `hydration_error_code` field shape?
- Which streams should later add extracted text, OCR, or document parsing as a separate capability?
