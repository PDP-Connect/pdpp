# Tasks

## 1. Audit

- [x] 1.1 Inventory every shipped first-party manifest for streams that may contain collectible binary content.
- [x] 1.2 Classify each candidate stream as `hydrate now`, `metadata only`, `deferred`, or `not binary`.
- [x] 1.3 Document per-stream rationale in `design-notes/blob-hydration-coverage-2026-04-25.md`.
- [x] 1.4 Identify the first implementation slice and any streams that require separate design before byte collection.

## 2. Gmail Attachment Vertical Slice

- [x] 2.1 Confirm the current Gmail connector path can access attachment bytes for messages already collected.
- [x] 2.2 Add connector-side byte fetch for Gmail attachments behind a bounded size policy.
- [x] 2.3 Store fetched bytes through the existing reference blob storage seam.
- [x] 2.4 Emit `blob_ref`, `content_sha256`, and `hydration_status: "hydrated"` for successfully hydrated attachments.
- [x] 2.5 Preserve metadata-only attachment records with a truthful hydration status when byte fetch is unavailable, skipped, blocked, too large, or failed.
- [x] 2.6 Ensure logs, run timeline data, and errors do not include attachment bytes or sensitive signed source URLs.

## 3. Contract And Query Tests

- [x] 3.1 Add or extend Gmail connector tests with fixture-backed hydrated and metadata-only attachments.
- [x] 3.2 Add reference query tests proving `expand=attachments` exposes `blob_ref.fetch_url` only when the grant includes `attachments.blob_ref`.
- [x] 3.3 Add reference query tests proving `GET /v1/blobs/{blob_id}` returns bytes for visible blobs and rejects hidden blobs.
- [x] 3.4 Add restart/idempotency coverage showing repeated hydration does not duplicate stored bytes.
- [x] 3.5 Add route regression coverage that visible blob GET/HEAD responses include private no-store cache semantics and HEAD returns metadata without a body.

## 4. Broader First-Party Follow-Ups

- [x] 4.1 Apply the audit classification to Slack file-like surfaces and decide whether Slack hydration is a safe second slice. (Audit: deferred. Decision documented in `design-notes/slack-blob-followup-2026-04-26.md` — Slack is the recommended second slice but requires manifest changes, derivative-policy decision, Slackdump archive reconciliation, and signed-URL scrubbing before code.)
- [x] 4.2 Apply the audit classification to financial/commerce document surfaces such as Chase, USAA, and Amazon. (Chase/USAA `statements`: deferred — `financial-statement-blob-followup-2026-04-26.md`. Amazon and other commerce `order_invoices`: deferred, requires new manifest stream — `commerce-receipt-blob-followup-2026-04-26.md`.)
- [x] 4.3 Apply the audit classification to ChatGPT, Claude Code, Codex, GitHub, Reddit, and other shipped first-party connectors. (Captured row-by-row in `blob-hydration-coverage-2026-04-25.md`. Deferred groups: assistant artifacts — `assistant-artifact-blob-followup-2026-04-26.md`; source-host artifacts — `source-host-blob-followup-2026-04-26.md`; social-media archival — `social-media-blob-followup-2026-04-26.md`.)
- [x] 4.4 For each deferred stream, open a focused follow-up change or design note rather than hiding the gap. (Six follow-up notes landed under `openspec/changes/hydrate-first-party-blob-streams/design-notes/` — slack, financial-statement, commerce-receipt, assistant-artifact, source-host, social-media.)

## 5. Documentation

- [x] 5.1 Update public/query docs to make `blob_ref.fetch_url` the prominent byte-discovery path. (Edits in `apps/web/content/docs/spec-data-query-api.md`, `apps/web/content/docs/spec-core.md`, `docs/agent-skills/pdpp-data-access/references/query-cookbook.md`.)
- [x] 5.2 Add a cookbook example for finding an attachment record, requesting a grant-visible `blob_ref`, and fetching `/v1/blobs/{blob_id}`. (See "Cookbook example: fetch a recent attachment end-to-end" in `query-cookbook.md`.)
- [x] 5.3 Clarify that resource-specific `/content` or `/download` URL guesses are not part of the PDPP API. (Explicit rejections in `spec-core.md`, `spec-data-query-api.md`, `query-cookbook.md`, and `troubleshooting.md`.)
- [x] 5.4 Update reference connector authoring docs with the hydration status and blob upload pattern. (New §12 in `packages/polyfill-connectors/docs/connector-authoring-guide.md` plus a pointer section in `authoring-guide.md`. Includes per-connector hydration status as of 2026-04-26.)

## 6. Validation

- [x] 6.1 Run `openspec validate hydrate-first-party-blob-streams --strict`.
- [x] 6.2 Run `openspec validate --all --strict`.
- [x] 6.3 Run the Gmail connector test suite.
- [x] 6.4 Run relevant reference query-contract tests.
- [x] 6.5 Run package-level typecheck/lint/verify for touched packages.
