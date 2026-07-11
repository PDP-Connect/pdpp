## 1. Evidence and design

- [x] 1.1 Read AGENTS.md, openspec/README.md, docs/voice-and-framing.md,
      docs/agent-workstream-playbook.md.
- [x] 1.2 Read current Slack manifest, connector, parsers, schemas, tests.
- [x] 1.3 Investigate slackdump + `rusq/slack` source and Slack API
      reference docs for all four deferred streams; record evidence in
      `design-notes/slackdump-and-slack-api-capability-audit.md` and
      `docs/research/slack-stars-usergroups-reminders-readstate-api-reachability-2026-07-10.md`.
- [x] 1.4 Write proposal.md / design.md / this tasks.md / spec delta.
- [x] 1.5 `openspec validate complete-slack-bundled-connector-coverage --strict`.

## 2. Shared HTTP substrate

- [x] 2.1 Add `slackApiPacingProfile()` to
      `packages/polyfill-connectors/src/provider-profile.ts`
      (`pacingMinIntervalMs: 3000`, derived from the Tier 2 floor across
      the four methods; cite the Slack docs URL inline like the other
      profiles).
- [x] 2.2 Add a `slack-api.ts` module (kept `index.ts` from growing further,
      per package AGENTS.md scope discipline) wrapping
      `createConnectorHttpGovernor` + `fetch` with
      `Authorization: Bearer <token>` (GET) / `token` form field (POST) and
      `Cookie: d=<cookie>` headers, mirroring `gh()` in `github/index.ts`:
      typed error on 401 (`slack_auth_failed`), governor-driven retry/429
      handling (`slack_rate_limited`), JSON body parse.

## 3. `stars` stream

- [x] 3.1 Call `stars.list` (POST form, `token` field), paginate via
      `response_metadata.next_cursor`.
- [x] 3.2 Parse into the manifest's `stars` schema (`item_type`,
      `target_id`, `channel_id`, `message_ts`, `file_id`, `user_id`,
      `starred_at`).
- [x] 3.3 `validateRecord` wiring in `schemas.ts` (schema pre-existed;
      `buildStarRecord` in `parsers.ts` now feeds it); emit RECORD + STATE
      cursor.
- [x] 3.4 Fixture + unit test: non-empty result, empty result, pagination
      (`slack-api.test.ts`); record-shape + schema-validation tests
      (`parsers.test.ts`); stream-runner integration test
      (`gap-streams.test.ts`).

## 4. `user_groups` stream

- [x] 4.1 Call `usergroups.list` with `include_users=true`, `include_count=true`,
      `include_disabled=true` (`date_delete > 0` maps to `deleted: true`).
- [x] 4.2 Parse into the manifest's `user_groups` schema.
- [x] 4.3 `validateRecord` wiring; emit RECORD + STATE cursor.
- [x] 4.4 Fixture + unit test: non-empty, empty, disabled-group mapping.

## 5. `reminders` stream

- [x] 5.1 Call `reminders.list` (no pagination in the Slack API).
- [x] 5.2 Parse into the manifest's `reminders` schema (`text`,
      `recurring`, `time`→`scheduled_at`, `complete_ts`→`completed_at`).
- [x] 5.3 `validateRecord` wiring; emit RECORD + STATE cursor.
- [x] 5.4 Fixture + unit test: non-empty, empty, completed reminder.

## 6. `dm_read_states` stream

- [x] 6.1 Scope to channel IDs marked `is_im`/`is_mpim` in this run's
      archive (`currentDmMpimChannelIds`; no full-inventory
      `conversations.info` sweep).
- [x] 6.2 Call `conversations.info` per scoped channel ID; parse
      `last_read`/`unread_count`/`unread_count_display` into the manifest
      schema (`last_read` converted from Slack ts to ISO via `tsToIso`).
- [x] 6.3 `validateRecord` wiring; emit RECORD + STATE cursor.
- [x] 6.4 Fixture + unit test: DM present, MPIM present, non-DM channel
      excluded, zero DM channels (stream still completes cleanly, zero API
      calls).

## 7. Manifest + docs

- [x] 7.1 Removed `availability` block and `coverage_policy: "deferred"`
      from all four streams in `manifests/slack.json`; `required` left
      unset (default `true`/`collect`). Also corrected `reminders` and
      `dm_read_states` `coverage_strategy` from `checkpoint_window` to
      `full_inventory` (both are full-inventory list streams, not
      cursor-windowed) and `freshness_strategy` from `not_trackable` to
      `scheduled_window`. Added all four to the `full` profile. Bumped
      manifest `version` 0.5.0 → 0.6.0.
- [x] 7.2 Updated stream `description`/`display.detail` copy to describe
      the direct-API collection path.
- [x] 7.3 Updated `connectors/slack/README.md`: corrected the stale
      `dm_read_states`-already-emitted claim, added a "direct Slack Web API
      calls" section; nothing remains in a "declared but not realizable"
      state.
- [x] 7.4 Updated the file-header comment block in `index.ts`; removed
      `UNAVAILABLE_STREAMS`/`emitUnavailableStreams` (replaced with the
      four `run*Stream` collectors, wired into `runRequestedStreams` +
      `emitStateCheckpoints`).
- [x] 7.5 (found during implementation) Regenerated the generated artifact
      `docs/reference/stream-evidence-inventory.md` via
      `pnpm stream-evidence:inventory`; `pnpm stream-evidence:check` passes.
- [x] 7.6 (found during implementation, AGENTS.md rename/cleanup rule)
      Corrected stale framing in
      `reference-implementation/test/slack-collection-report.test.js` — its
      header comment and two test descriptions described Slack's now-obsolete
      `unsupported_in_mode` state as current fact; reworded to make explicit
      the tests exercise a projection-generic mechanism with synthetic
      fixture stream names, not a live Slack manifest assertion. Assertions
      unchanged; all 10 tests still pass.

## 8. Verification

- [x] 8.1 `pnpm --filter polyfill-connectors typecheck` — clean.
- [x] 8.2 `pnpm --filter polyfill-connectors check` — clean on all touched
      files (one pre-existing, unrelated finding in
      `src/collector-runner.test.ts`, not touched by this change).
- [x] 8.3 `pnpm --filter polyfill-connectors test` — 2430 passed, 0 failed,
      6 pre-existing skips (full package suite, not just slack, to catch
      cross-connector regressions from the `provider-profile.ts` addition;
      `provider-profile-conformance.test.ts`'s roster derivation correctly
      does not require Slack in `GOVERNOR_USING_CONNECTORS` since the
      governor call lives in `slack-api.ts`, not `index.ts`).
- [x] 8.4 `openspec validate complete-slack-bundled-connector-coverage --strict`
      and `openspec validate --all --strict` — both clean (72/72 items pass).
- [x] 8.5 Grepped touched files for stale `unsupported_in_mode`/`deferred`
      Slack-stream claims; found and fixed the two additional stale
      references (7.5, 7.6) beyond the original implementation scope.

## Acceptance checks

```bash
pnpm --filter polyfill-connectors typecheck
pnpm --filter polyfill-connectors check
pnpm --filter polyfill-connectors test
openspec validate complete-slack-bundled-connector-coverage --strict
openspec validate --all --strict
pnpm stream-evidence:check
```
