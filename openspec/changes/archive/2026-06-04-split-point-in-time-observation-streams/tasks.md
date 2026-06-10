# Tasks — split sampled metrics into append-keyed observation streams

## 1 — GitHub connector

- [x] 1.1 Add `userStatsRecord()` builder in `parsers.ts` (fields: `id`, `user_id`, `observed_on`, `public_repos`, `public_gists`, `followers`, `following`).
- [x] 1.2 Add `userEntityRecord()` builder in `parsers.ts` (identity fields only, no stat fields).
- [x] 1.3 Add `userStatsSchema` in `schemas.ts`.
- [x] 1.4 Update `userSchema` in `schemas.ts` to remove stat fields.
- [x] 1.5 Update `SCHEMAS` registry to include `user_stats`.
- [x] 1.6 Update `collectUser()` in `index.ts` to emit both streams; add fingerprint gate on `user` entity.
- [x] 1.7 Add `user_stats` stream to `manifests/github.json`.
- [x] 1.8 Add parser unit tests for `userStatsRecord` and `userEntityRecord`.
- [x] 1.9 Add schema tests (pilot-fixture or inline) for `user_stats`.

## 2 — Slack connector

- [x] 2.1 Add `buildChannelStatsRecord()` builder in `parsers.ts` (fields: `id`, `channel_id`, `observed_on`, `num_members`).
- [x] 2.2 Add `buildChannelEntityRecord()` builder (structural fields only, no `num_members`).
- [x] 2.3 Add `channelStatsSchema` in `schemas.ts`.
- [x] 2.4 Update `channelsSchema` to remove `num_members`.
- [x] 2.5 Update `SCHEMAS` registry to include `channel_stats`.
- [x] 2.6 Update `runChannelsStream()` in `index.ts` to emit both streams; add fingerprint gate on `channels` entity.
- [x] 2.7 Add `channel_stats` stream to `manifests/slack.json`.
- [x] 2.8 Add parser unit tests for `buildChannelStatsRecord` and `buildChannelEntityRecord`.

## 3 — Validation

- [x] 3.1 Run `pnpm --dir packages/polyfill-connectors typecheck`.
- [x] 3.2 Run GitHub connector tests.
- [x] 3.3 Run Slack connector tests.
- [x] 3.4 Run `openspec validate split-point-in-time-observation-streams --strict`.
- [x] 3.5 Run `git diff --check`.

## Acceptance checks

1. `node --test --import tsx packages/polyfill-connectors/connectors/github/parsers.test.ts` — passes, including `userStatsRecord` and `userEntityRecord` tests.
2. `node --test --import tsx packages/polyfill-connectors/connectors/slack/parsers.test.ts` — passes, including `buildChannelStatsRecord` and `buildChannelEntityRecord` tests.
3. `pnpm --dir packages/polyfill-connectors typecheck` — zero errors.
4. `openspec validate split-point-in-time-observation-streams --strict` — valid.
5. `git diff --check` — no whitespace errors.
