# Owner Spine Browser Proof - 2026-06-18

## Status

Final local proof passed against the console preview at `http://127.0.0.1:3107`, pointed at live reference data through `PDPP_AS_URL=https://pdpp.vivid.fish` and `PDPP_RS_URL=https://pdpp.vivid.fish`.

This proves one vertical owner-spine slice, not the whole console.

The tracked evidence is sanitized. Private source labels, account names, emails, phone numbers, record ids, repository names, and record text are redacted or tokenized in screenshots and `evidence.json`.

## Target

- Source: `GitHub - Example Account`
- Route token: `{source-under-test}`
- Connector type: `github`
- Duplicate-source risk: `github` has two configured sources, so connector-type routing would be ambiguous.
- Stream: `repositories`
- Source-truth count from `/_ref/connectors`: `8` stream records, `12` total source records.

## Journey

1. Source detail: `/dashboard/records/{source-under-test}`
2. Mobile source detail: same route at `390x844`
3. Scoped Syncs/Runs: `/dashboard/runs?connection_id={source-under-test}`
4. Full stream records: `/dashboard/records/{source-under-test}/repositories`
5. Scoped Explore: `/dashboard/explore?connection={source-under-test}&stream=repositories`
6. Mobile scoped Explore: same route at `390x844`

## Assertions

- Source detail rendered the exact source label, not the other GitHub source label.
- Scoped Syncs/Runs rendered the exact source label, not the other GitHub source label.
- Full stream route rendered the exact source label in the breadcrumb/header.
- Full stream route rendered `page 1 · 8 shown of 8 total`.
- Full stream route did not render `deprecated_alias_used`; records were read with canonical `connection_id`, not the deprecated `connector_instance_id` alias.
- Full stream route exposed exact-source record-detail links under `/dashboard/records/{source-under-test}/repositories/...`.
- Explore accepted the same connection and stream scope and exposed exact-source record links.
- Full visibility for this slice is proven by the stream records route. Explore proves scoped entry and link-out continuity, not complete stream visibility.
- Browser console messages: none.
- Failed requests: none.

## Gate Finding

The first browser pass failed on the full stream route. The page URL was exact, but the header breadcrumb showed the raw source id and the full stream read emitted a `deprecated_alias_used` warning. That meant the implementation passed local invariants while still failing owner-spine continuity. The failed-pass screenshot was intentionally not retained because it contained live owner data.

Fix:

- Stream list, record detail, and stream health now derive the owner source label from the resolved connection.
- RS reads now prefer canonical `connection_id` and only send the deprecated alias when the caller does not know a connection id.
- Stream list count falls back to the source summary's `stream_records` count when stream metadata lacks `record_count`.

## Evidence Files

- `owner-spine-browser-proof-20260618/evidence.json`
- `owner-spine-browser-proof-20260618/01-source-detail-desktop.png`
- `owner-spine-browser-proof-20260618/02-source-detail-mobile.png`
- `owner-spine-browser-proof-20260618/03-scoped-runs-desktop.png`
- `owner-spine-browser-proof-20260618/04-stream-records-desktop.png`
- `owner-spine-browser-proof-20260618/05-explore-scoped-desktop.png`
- `owner-spine-browser-proof-20260618/06-explore-scoped-mobile.png`

## Automated Check

Run the source-continuity invariant with:

```bash
pnpm --dir apps/console run test:owner-spine
```

## Scope Not Proven

This proof does not close the whole owner-console change. It does not prove Add Data, source recovery, grants/read review, fresh-owner onboarding, browser-backed connector setup, or every Explore interaction archetype. It is the first implemented vertical owner-spine slice satisfying the alignment gate for source identity, exact-source routing, count basis, full stream visibility, and desktop/mobile browser evidence.
