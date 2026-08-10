# Media acquisition design: Google Photos, Immich, Apple Photos, and future media providers

Status: design only. No implementation in this note. Prototyping should start
only after the current UAT work finishes, and should start with Immich.

## The question

Media (photos, videos, audio, documents) needs a policy for when bytes move
from the provider into PDPP storage, relative to when the resource server
(RS) learns an item exists. This note picks that policy without teaching the
RS anything about any specific provider.

## What already exists and should not be re-derived

The blob subsystem is already built and is the right foundation:

- Content-addressed store: `blobs` table keyed by `blob_id =
  blob_sha256_<hex>` (`reference-implementation/server/queries/blobs/insert-blob.sql`);
  `blob_bindings` lets many records share one blob.
- Protocol contract (`spec-core.md:311-334`, `:1186-1213`): connectors emit
  `blob_ref` (`blob_id`, `mime_type`, `size_bytes`, `sha256`) with no
  `fetch_url`. The RS injects `fetch_url` at read time. Connectors never
  mint URLs.
- Grant enforcement on blobs is not a separate ACL. `GET /v1/blobs/:id`
  re-runs ordinary grant-scoped record visibility for every binding and
  serves bytes only if a visible record's `data.blob_ref.blob_id` matches
  (`reference-implementation/operations/rs-blobs-read/index.ts`,
  `reference-implementation/server/routes/rs-read.ts:2662-2771`). Spec:
  "A `blob_id` alone does not grant access" (`spec-core.md:1199`).
- Hydration-status pattern already ships for gmail, whatsapp, imessage,
  groupme attachments and for apple_photos/google_takeout local media: a
  record is always emitted, bytes may lag behind it, and
  `hydration_status` (`deferred|failed|hydrated`, or
  `failed|hydrated|skipped_too_large|unavailable`) plus a sanitized
  `hydration_error` explain why. Shared code:
  `packages/polyfill-connectors/src/local-media-blob-hydration.ts`,
  `reference-blob-uploader.ts`.
- Gap: no manifest-level flag declares "this stream carries media" — it's
  only visible by finding a `blob_ref` property in the stream's schema.
- Gap: blob reads are not audited as disclosures. `mountRsBlobRead`
  (`rs-read.ts:2662-2771`) never calls `emitSpineEvent`, unlike the
  record-read path, which emits `disclosure.served`
  (`emitDisclosureServed`, `rs-read.ts:583-622`). "Who saw this photo's
  bytes and when" is currently unanswerable from the audit log, even though
  "who saw this photo's metadata row" is. This is a real gap, not a design
  choice, and belongs in the terminal architecture below.

## Decision: hybrid, connector-mediated hydration

Three options were on the table. Eager ingestion (fetch every item's bytes
at connector-run time) pays full storage and egress cost regardless of
demand. Pure fetch-on-demand (RS resolves an unhydrated `blob_ref` against
a live upstream API at read time) breaks the protocol outright — `blob_ref`
is defined as something the RS already holds, and building a live-fetch
path would mean the RS has to authenticate to and paginate every provider,
which is exactly what this design avoids.

The chosen model is hybrid: metadata and thumbnails hydrate eagerly at
ingest time; full-resolution originals hydrate lazily, on a
connector-owned backfill policy, not on RS read. The RS stays exactly as
provider-agnostic as it is today — it stores content-addressed bytes and
serves them only through the existing grant-derived visibility check. It
never talks to a provider, at ingest or at read time. All fetching is done
by the connector, never by the RS.

This also fixes the acquisition cost curve for large libraries: cheap,
bounded thumbnail traffic on every run, and throttleable full-resolution
traffic on a separate cadence the connector controls (e.g. N items per
run). Escalate to a read-triggered hydration model only if product need for
"first view of a specific cold item resolves within one request" is
proven — don't build that RS-to-runtime trigger contract speculatively.

## Provider fit

**Immich** is the first cross-provider API prototype. Its asset API is
stable and re-fetchable at any time — `GET /assets`, `GET
/assets/{id}/original`, `GET /assets/{id}/thumbnail`
(https://immich.app/docs/api/) — which is exactly what a backfill queue
needs: a durable per-item handle a connector can revisit on its own
schedule.

**Apple Photos** already fits this model as a filesystem-export connector
(no API, `content_sha256`-derived identity) and needs no new work beyond
what this design formalizes.

**Google Photos** as a live whole-library connector is deferred, not
attempted. Two upstream facts rule it out under this design:

- The Library API's `mediaItems.list` now returns only media the
  requesting app itself created, not the user's library
  (https://developers.google.com/photos/library/guides/overview). There is
  no background-enumerable path to the rest of a user's photos.
- Whole-library selection is only available through the interactive Picker
  API, and Picker-issued `baseUrl`s are short-lived — about 60 minutes
  (https://developers.google.com/photos/picker/guides/get-started-picker).
  A locator that expires in an hour cannot sit in a backfill queue; a
  connector-driven policy that hydrates "sometime later" cannot rely on it.

Google Takeout remains the backfill path for Google Photos coverage — it's
already a working connector, batch-export shaped, with no live-API
constraints, and it fits this design's model directly. If an interactive
Picker-based connector is wanted later, it is a separate, smaller proposal
scoped to session-driven selection (hydrate synchronously inside the
picking session, before the URL expires), not to library sync — out of
scope here.

## Non-goals

- No RS-side provider knowledge, ever: no SDKs, no provider-specific auth,
  no fetch-on-read logic in the RS.
- No fetch-on-demand hydration model (rejected above).
- No live-API Google Photos connector under this design.
- No new blob storage layer — the existing content-addressed store and
  grant-visibility check are reused unchanged.
- No implementation in this note. No Google Photos or Immich code is being
  added here.
- No prototyping before the current UAT work is done.

## Terminal architecture

1. Manifest: add an optional per-stream media declaration (e.g.
   `thumbnail_field`/`full_field`) so tooling can discover "this stream
   carries media" without schema-sniffing for `blob_ref`. The only new
   manifest concept this design introduces.
2. Connector-side, backfill-capable providers (Immich, Apple Photos, Google
   Takeout): enumerate items, hydrate thumbnails eagerly and originals
   lazily, using the existing hydration and uploader modules. Ends in
   ordinary `POST /v1/blobs` calls and ordinary records carrying
   `blob_ref`/`thumbnail_ref`.
3. RS fix: emit `disclosure.served` from the blob-read route, matching the
   record-read path. Small, pre-existing gap, in scope here because it's
   the one place this design touches the RS at all.
4. No other RS change.

## Staged proof plan

1. Contract proof, no connector code: a fixture-only test with a synthetic
   manifest media declaration and a record carrying `thumbnail_ref` +
   `blob_ref: null` + `hydration_status: deferred`, confirming existing
   grant-visibility behavior generalizes to it.
2. Disclosure-audit fix, proven by mutation test (remove the emission,
   confirm a test goes red), not just a passing test — recent history in
   this repo's `record-message-validator` work shows an unproven fix can
   silently not fire.
3. Immich prototype: prove the full hydration loop against a real,
   stable REST surface — credential revocation transitions
   `hydration_status` to `failed`, backfill cadence is tunable, and the
   RS-side blob-read path needs zero changes when the hydration mechanism
   changes from filesystem to HTTP.
4. Load/cost proof after 1-2 real connectors exist: measure actual
   thumbnail-eager vs. originals-lazy storage and egress cost on a real
   library, and use that to set the default backfill cadence instead of
   guessing it up front.

Only after gate 3 succeeds should any provider-specific connector code be
written, and Immich is the gate.

---

Signed-off-by: Tim Nunamaker <tnunamak@gmail.com>
Assisted-by: AI
