# Register current high-churn compaction policies (gmail/labels, usaa/statements, chase/accounts)

## Why

The dashboard version-churn notice flags several current high/watch streams that
the prior YNAB-focused work did not cover. Three of them are pure run-clock /
stored-body churn with zero semantic loss from a connector no-op gate:

- **gmail / labels** (~269 versions/record): re-emitted every IMAP mailbox
  unconditionally on every run. The stored record body
  (`{name, canonical_name, is_system, parent_name, message_count}`) has no
  run-clock field and `message_count` is hardcoded `null`, so adjacent versions
  are byte-identical.
- **usaa / statements** (~14.93 versions/record): the record carried a
  run-clock `fetched_at: nowIso()`. A statement's identity is immutable and its
  hydrated fields (`pdf_path`/`pdf_sha256`/`document_url`) are content-addressed
  (the path embeds the sha256 prefix), so only `fetched_at` moved.
- **chase / accounts** (~20 versions/record): the record carried a run-clock
  `fetched_at` and ALL balance fields hardcoded `null` (balances live in the
  separate `balances` stream), so only `fetched_at` moved.

Each stream had **no connector-side no-op gate**. Per the version-churn
construction principle, the correct first step is a forward fix at the source,
not compaction that hides ongoing churn. This change ships both: the forward
fingerprint gates (the new connector-side no-op definitions) and the historical
compaction policies that mirror them one-for-one.

The other current high/watch streams (github/user, slack/channels,
usaa/accounts, usaa/credit_card_billing) churn on genuinely volatile semantic
fields (follower counts, `num_members`, live balances). Excluding those fields
would hide real changes, so they are intentionally **not** addressed here and
remain report-only recommendations.

## What Changes

- Forward fix: add per-record fingerprint cursors to the three connectors
  (gmail `labels`, usaa `statements`, chase `accounts`), mirroring the existing
  Slack/Gmail/YNAB `openFingerprintCursor` pattern. gmail `labels` excludes the
  synthetic keying `id` so its fingerprint is computed over exactly the stored
  body; usaa `statements` and chase `accounts` exclude `fetched_at`.
- Register three Family-1 ("connector fingerprint mirror") compaction policies
  in the tool registry, each mirroring its connector gate one-for-one:
  - `gmail/labels` — `excludeKeys: []` (stored body has no `id`).
  - `usaa/statements` — `excludeKeys: ["fetched_at"]`.
  - `chase/accounts` — `excludeKeys: ["fetched_at"]`.
- Extend the canonical Family-1 stream enumeration in the
  reference-implementation-architecture capability spec to include the three new
  streams.
- Add pure-helper, selector, and fingerprint-parity test coverage.

No new HTTP route, schedule, or automatic job. No change to the retention rule,
backup/apply safety, dry-run default, or any public read path. Live owner
`--apply` is deferred and owner-gated (see `design.md` for the dry-run-first
procedure).

## Capabilities

- Modified: reference-implementation-architecture

## Impact

- `packages/polyfill-connectors/connectors/gmail/index.ts` — `labels`
  fingerprint gate + `readPriorLabelFingerprints`.
- `packages/polyfill-connectors/connectors/usaa/index.ts` — `statements`
  fingerprint gate + `readPriorStatementFingerprints`.
- `packages/polyfill-connectors/connectors/chase/index.ts` — `accounts`
  fingerprint gate + `readPriorAccountFingerprints`.
- `packages/polyfill-connectors/connectors/{gmail,usaa,chase}/*-fingerprint.test.ts`
  — new forward-gate tests.
- `reference-implementation/scripts/compact-record-history.mjs` — three registry
  entries + header docstring.
- `reference-implementation/test/compact-record-history.test.js` — registry
  shape assertion.
- `reference-implementation/test/compact-record-history-fingerprint-parity.test.js`
  — three parity fixtures + static-guard set.
- `openspec/specs/reference-implementation-architecture/spec.md` — Family-1
  enumeration (via this change's delta).
