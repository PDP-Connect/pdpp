# Social-Media Media Hydration — Follow-Up (Reddit, Meta, Twitter Archive, Loom)

Status: open
Owner: owner/connectors
Created: 2026-04-26
Related: hydrate-first-party-blob-streams, polyfill-connectors:reddit, polyfill-connectors:meta, polyfill-connectors:twitter_archive, polyfill-connectors:loom

## Why this is its own note

These connectors share a low-priority profile: media bytes plausibly
exist (Reddit posts with image/video, Meta posts with photos, Twitter
archive media, Loom video files), but the assistant value is low
relative to the storage cost and the work of plumbing platform-specific
fetch paths. Bundling them keeps the Gmail/Slack/Chase work focused.

## Reddit

- Source URLs are owner-agnostic CDN URLs (`i.redd.it`, `v.redd.it`).
- Hydration is technically straightforward (HTTP GET) but high-volume
  user accounts could store gigabytes. Mostly social-archival, not
  evidence/answer use cases.
- Default: leave `metadata only`. Promote if a consumer explicitly asks.

## Meta (Instagram)

- Schema captures `media_type` only; URLs require Instagram's signed URL
  flow which expires.
- Browser-scrape connector is currently scaffolded only. Add media
  hydration only after the connector is verified end-to-end without it.

## Twitter Archive

- This connector consumes a user-supplied Twitter archive bundle. Media
  is in the bundle as files on disk. Promoting to a sibling
  `twitter_archive.media` stream with `blob_ref` is mechanically the
  same as iMessage/WhatsApp (filesystem source).
- Default: low priority because the archive itself is the durable copy;
  re-uploading bytes into the RS substrate duplicates without obvious
  benefit unless a consumer wants grant-gated access through PDPP.

## Loom

- Currently scaffolded, no records landed.
- Video files are large (often hundreds of MB to GB). If/when this
  connector ships records, video bytes should be `metadata only` by
  default with an opt-in operator flag for hydration. A 1 GB-per-video
  cap and a per-account total-bytes cap should both be enforced.

## Common decisions

1. Conservative size caps with operator override (no default hydration
   for video).
2. Failure taxonomy includes `unavailable` (CDN URL expired) and
   `blocked` (signed-URL rejection).
3. `hydration_error` MUST scrub signed-URL query strings.

## Out of scope for this follow-up

- Live download monitoring or progressive streaming.
- Transcoding / video-format normalization.

## Exit criteria

- A specific consumer ask documented before any of these ships byte
  hydration. None of these belong in a "while we're here" pass — they
  earn their slice on demand.
