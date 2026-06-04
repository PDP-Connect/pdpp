# Split sampled metrics into append-keyed observation streams

## Why

Two live high-churn streams accumulate false version history because sampled
metrics are mixed into entity streams that carry stable identity:

- **github / user** — `public_repos`, `public_gists`, `followers`, `following`
  change frequently (follower activity, public repo ops). Every re-fetch of the
  user profile produces a new entity version even when identity fields
  (`login`, `bio`, `company`, `location`, etc.) have not moved.
- **slack / channels** — `num_members` is a live membership count. A single
  person joining or leaving produces a new version of every affected channel
  record, even when the channel's structural fields (`name`, `topic`,
  `purpose`, `is_private`, etc.) have not changed.

Excluding these fields from fingerprints would hide real signal: the counts are
genuine data worth preserving. The correct construction — per the
point-in-time-stream design owned and accepted above — is to project sampled
metrics into dedicated append-keyed observation streams, keep entity streams for
structural/identity fields only, and fingerprint the entity streams so
unmodified identity does not re-emit.

## What Changes

- **github / `user_stats` stream (new)** — append-keyed observation records for
  `public_repos`, `public_gists`, `followers`, `following`, keyed by
  `{user_id}:{YYYY-MM-DD}`. One record per user per calendar day; re-running
  on the same day is idempotent. `user` entity stream retains identity fields
  only, fingerprinted to gate on real identity changes.
- **slack / `channel_stats` stream (new)** — append-keyed observation records
  for `num_members`, keyed by `{channel_id}:{YYYY-MM-DD}`. One record per
  channel per day. `channels` entity stream retains structural fields only,
  fingerprinted to gate on structural changes.
- **Manifests updated** — both manifests gain the new stream declaration with
  `semantics: "append"` and the entity stream gains the fingerprint annotation.
- **Connector tests updated** — parser unit tests and schema tests for both new
  streams.

No data compaction in this lane. No change to the retention rule, backup/apply
safety, or any public read path beyond the new stream declarations.

## Capabilities

- Modified: reference-implementation-architecture (new observation-stream class)

## Impact

- `packages/polyfill-connectors/connectors/github/parsers.ts` — `userStatsRecord()`, `userEntityRecord()`.
- `packages/polyfill-connectors/connectors/github/schemas.ts` — `userStatsSchema`, updated `userSchema`.
- `packages/polyfill-connectors/connectors/github/index.ts` — `collectUser()` splits emit; fingerprint gate on `user`.
- `packages/polyfill-connectors/connectors/github/parsers.test.ts` — new assertions.
- `packages/polyfill-connectors/manifests/github.json` — `user_stats` stream added, `user` fingerprint annotation.
- `packages/polyfill-connectors/connectors/slack/parsers.ts` — `buildChannelStatsRecord()`, `buildChannelEntityRecord()`.
- `packages/polyfill-connectors/connectors/slack/schemas.ts` — `channelStatsSchema`, updated `channelsSchema`.
- `packages/polyfill-connectors/connectors/slack/index.ts` — `runChannelsStream()` splits emit; fingerprint gate on `channels`.
- `packages/polyfill-connectors/connectors/slack/parsers.test.ts` — new assertions.
- `packages/polyfill-connectors/manifests/slack.json` — `channel_stats` stream added.
