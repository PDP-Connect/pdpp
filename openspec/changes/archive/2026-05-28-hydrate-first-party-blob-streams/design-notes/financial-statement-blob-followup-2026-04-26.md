# Financial Statement Blob Hydration — Follow-Up (Chase, USAA)

Status: open
Owner: owner/connectors
Created: 2026-04-26
Related: hydrate-first-party-blob-streams, polyfill-connectors:chase, polyfill-connectors:usaa

## Why this is its own note

Chase and USAA already capture statement PDFs to disk under
`~/.pdpp/<bank>-statements/<account>/<YYYY-MM>-<sha8>.pdf` and expose
`pdf_path` + `pdf_sha256` on the `statements` row. They predate this
change and predate the reference RS blob substrate's grant-safe contract.
The next slice is **not** a code-only change — it requires picking a
single source of truth and committing to it.

## The two-store problem

Today, statement PDFs live in **two places** the moment the reference
substrate is added:

- The connector's on-disk archive (referenced by `pdf_path`).
- The reference RS's content-addressed blob store (would be referenced by
  `blob_ref.fetch_url`).

Two stores means two retention policies, two backup models, two delete
operations on consent revocation, and ambiguous answer to "where is the
authoritative copy?" This is the trap to design out before the slice
ships, not after.

## Options

1. **Collapse on-disk archive into RS blob store.** Connector uploads to
   `POST /v1/blobs`; the on-disk archive is removed. `pdf_path` /
   `pdf_sha256` on the `statements` row are deprecated in favor of
   `blob_ref` / `content_sha256`. Single source of truth. Cost: loses
   the "archive survives RS reset" property the on-disk store currently
   provides; some operators rely on this for personal-records retention.
2. **Keep on-disk archive; reference it from the RS.** Add a blob-source
   adapter that lets the RS serve `GET /v1/blobs/{blob_id}` from a local
   filesystem path rather than the substrate's own storage. Single
   logical source of truth, but the substrate gets a new persistence mode
   and the path-based store has to address its own backup story. Larger
   surface change.
3. **Keep both stores explicitly, document the duplication.** Honest
   about the duplication; cheapest to ship. Worst long-term answer
   because every consent-revoke or retention-window operation now needs
   to act on both stores.

Default recommendation: **option 1**, deprecate the on-disk archive in a
separate followup once the RS blob substrate exposes equivalent retention
controls. Until that's ready, keep the on-disk archive as the source of
truth and emit `blob_ref: null` with `hydration_status: "deferred"` and a
machine-readable reason (`reason: "rs_blob_substrate_not_yet_authoritative"`).

## Manifest changes required (when slice lands)

- Add to both `chase.statements` and `usaa.statements`:
  `blob_ref` (object|null), `content_sha256` (string|null),
  `hydration_status` (enum), `hydration_error` (string|null).
- Mark `pdf_path` and `pdf_sha256` as deprecated in the field-level
  description and document the migration window.

## Other risks to design out

- **Account-risk on every download.** Chase/USAA fraud models flag
  programmatic downloads. The current Tier-A scrape already drives the
  "Options → Download" UI. Hydration must reuse that path, not invent a
  second one. No `Range` requests; no parallel fetches.
- **Statement re-issuance.** Banks occasionally re-publish a statement
  (corrected balance, re-numbered). Content-addressed sha256 means a
  re-issued statement gets a new `blob_id` automatically; the `statements`
  row's `id` (date+account) must NOT change, so a re-issued statement
  shows up as the same row pointing at a different blob. Decide whether
  to retain the prior blob (history) or replace it.
- **Statement availability windows.** USAA and Chase only expose recent
  statements in the UI; a re-run of an older sync may emit
  `hydration_status: "unavailable"` for statements that are no longer
  fetchable. The on-disk archive is the safety net here — losing it
  before the RS substrate is authoritative would be a user-visible loss.

## Exit criteria for the follow-up to land

- A written decision on options 1/2/3 above.
- Manifest fields added.
- Both connectors emit `blob_ref` for at least one real statement (with
  the current Tier-A scrape path) and preserve `hydration_status:
  "deferred"` for older statements with a non-secret reason.
- `expand=statements` query test proves `blob_ref.fetch_url` is gated by
  `<bank>.statements.blob_ref` field grant.
- Documented retention/deletion behavior for the chosen option.
