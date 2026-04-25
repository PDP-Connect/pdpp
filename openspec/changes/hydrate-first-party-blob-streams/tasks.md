# Tasks

## 1. Audit

- [ ] 1.1 Inventory every shipped first-party manifest for streams that may contain collectible binary content.
- [ ] 1.2 Classify each candidate stream as `hydrate now`, `metadata only`, `deferred`, or `not binary`.
- [ ] 1.3 Document per-stream rationale in `design-notes/blob-hydration-coverage-2026-04-25.md`.
- [ ] 1.4 Identify the first implementation slice and any streams that require separate design before byte collection.

## 2. Gmail Attachment Vertical Slice

- [ ] 2.1 Confirm the current Gmail connector path can access attachment bytes for messages already collected.
- [ ] 2.2 Add connector-side byte fetch for Gmail attachments behind a bounded size policy.
- [ ] 2.3 Store fetched bytes through the existing reference blob storage seam.
- [ ] 2.4 Emit `blob_ref`, `content_sha256`, and `hydration_status: "hydrated"` for successfully hydrated attachments.
- [ ] 2.5 Preserve metadata-only attachment records with a truthful hydration status when byte fetch is unavailable, skipped, blocked, too large, or failed.
- [ ] 2.6 Ensure logs, run timeline data, and errors do not include attachment bytes or sensitive signed source URLs.

## 3. Contract And Query Tests

- [ ] 3.1 Add or extend Gmail connector tests with fixture-backed hydrated and metadata-only attachments.
- [ ] 3.2 Add reference query tests proving `expand=attachments` exposes `blob_ref.fetch_url` only when the grant includes `attachments.blob_ref`.
- [ ] 3.3 Add reference query tests proving `GET /v1/blobs/{blob_id}` returns bytes for visible blobs and rejects hidden blobs.
- [ ] 3.4 Add restart/idempotency coverage showing repeated hydration does not duplicate stored bytes.

## 4. Broader First-Party Follow-Ups

- [ ] 4.1 Apply the audit classification to Slack file-like surfaces and decide whether Slack hydration is a safe second slice.
- [ ] 4.2 Apply the audit classification to financial/commerce document surfaces such as Chase, USAA, and Amazon.
- [ ] 4.3 Apply the audit classification to ChatGPT, Claude Code, Codex, GitHub, Reddit, and other shipped first-party connectors.
- [ ] 4.4 For each deferred stream, open a focused follow-up change or design note rather than hiding the gap.

## 5. Documentation

- [ ] 5.1 Update public/query docs to make `blob_ref.fetch_url` the prominent byte-discovery path.
- [ ] 5.2 Add a cookbook example for finding an attachment record, requesting a grant-visible `blob_ref`, and fetching `/v1/blobs/{blob_id}`.
- [ ] 5.3 Clarify that resource-specific `/content` or `/download` URL guesses are not part of the PDPP API.
- [ ] 5.4 Update reference connector authoring docs with the hydration status and blob upload pattern.

## 6. Validation

- [ ] 6.1 Run `openspec validate hydrate-first-party-blob-streams --strict`.
- [ ] 6.2 Run `openspec validate --all --strict`.
- [ ] 6.3 Run the Gmail connector test suite.
- [ ] 6.4 Run relevant reference query-contract tests.
- [ ] 6.5 Run package-level typecheck/lint/verify for touched packages.
