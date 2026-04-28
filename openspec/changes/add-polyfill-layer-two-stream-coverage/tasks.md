## 1. Baseline

- [x] Reconcile this task list with the Layer 2 backlog currently embedded in `add-polyfill-connector-system/tasks.md`.
  - 2026-04-25 Claude Code/Codex slice reconciled: backlog entries for Claude recursive subagents/tool-results, skills, slash commands, and Codex state_5/prompts/skills/rules were already mostly shipped. This slice added Claude `memory_notes`, made subagent traversal recursive, and kept Codex's actual stream name as `rules` because the real local source is `~/.codex/rules/*.rules`; `approval_rules` was backlog shorthand.
- [x] Record which existing local rows are trusted owner data, untrusted seed/demo data, or unknown.
  - 2026-04-24 worker read-only DB audit:
    - `packages/polyfill-connectors/.pdpp-data/pdpp.sqlite`: trusted owner data by local connector evidence: Amazon, Chase, ChatGPT, Claude Code, Codex, Gmail, Slack, USAA, and YNAB. GitHub is mixed: owner/API streams exist, but `commits` and `starred_repos` contain seed-connector rows from the known resolver-collision window. Spotify is untrusted seed/demo: `top_artists` 8, `saved_tracks` 8, `recently_played` 5; keys and sample payloads match `reference-implementation/connectors/seed/index.js`. Reddit is untrusted seed/demo: `posts` 4, `comments` 5, `saved` 3; keys and sample payloads match the same seed connector. Unknown/test: `/home/user/.vana/pdpp/pdpp.db` contains a legacy `unknown/test` row and older GitHub/Plaid rows not produced by the current reference DB path.
    - Additional ignored worktree DBs (`pdpp-crash-before`, `pdpp-next`) also contain Spotify/Reddit seed rows and should not be used as owner-account evidence.
- [ ] Purge or quarantine Spotify and Reddit seed/demo rows before using them as internal-demo evidence.
  - 2026-04-24 worker note: no direct DB mutation was performed. The existing safe pattern is the owner-authenticated reference reset endpoint, which deletes `records`, `record_changes`, `version_counter`, lexical index rows, and semantic index rows for a connector+stream. Gated owner action after starting the reference with `PDPP_DB_PATH=packages/polyfill-connectors/.pdpp-data/pdpp.sqlite`: issue an owner token, then run `DELETE /v1/streams/{stream}/records?connector_id=https%3A%2F%2Fregistry.pdpp.org%2Fconnectors%2Fspotify` for `top_artists`, `saved_tracks`, `recently_played`, and the same endpoint for Reddit `posts`, `comments`, `saved`.

## 2. Connector Slices

- [x] ChatGPT: audit and complete `custom_gpts`, `custom_instructions`, and `shared_conversations` coverage if not already shipped.
  - 2026-04-25 ChatGPT/GitHub/Slack audit slice: `custom_gpts`, `custom_instructions`, and `shared_conversations` are declared in `manifests/chatgpt.json`, validated by `connectors/chatgpt/schemas.ts`, and collected by `connectors/chatgpt/index.ts`. This slice added fake-API integration coverage for `custom_gpts` pagination/403 skip behavior and `shared_conversations` pagination/404 skip behavior; existing coverage already covered `custom_instructions` 200/404/500 paths and parser shapes.
- [x] Claude Code: add recursive sidechain/tool-result traversal, `memory_notes`, `skills`, and `slash_commands` where source files exist.
- [x] Codex: evaluate `state_5.sqlite` as canonical session metadata and add prompts, skills, and approval rules where source files exist.
  - 2026-04-25 closeout: `state_5.sqlite#threads`, `prompts`, `skills`, and `rules` were already implemented. The manifest/code now explicitly document that `rules` is the honest stream name for Codex approval/trust rules.
- [x] GitHub: evaluate issues, pull requests, gists, followers, and following streams against available token scopes.
  - 2026-04-25 ChatGPT/GitHub/Slack audit slice: `issues`, `pull_requests`, and `gists` are declared in `manifests/github.json`, implemented in `connectors/github/index.ts`, and parser-covered in `connectors/github/parsers.test.ts`. `followers` and `following` are currently profile count fields on the `user` stream, not standalone relationship streams; adding row-level follower/following streams would require a follow-up manifest/schema/collector slice plus live token verification against `/user/followers` and `/user/following`.
- [x] YNAB: add `month_categories` coverage.
  - 2026-04-24 worker closeout: connector and manifest already had `month_categories`; this slice added import-safe helper coverage for stable primary keys, one-month cursor rewind, time-range/deleted-month filtering, emitted records, and state cursor behavior without live YNAB auth.
- [ ] USAA: wire transfers, bill payments, scheduled transactions, external accounts, and statement metadata only where live access is stable.
- [ ] Gmail: keep attachment blob hydration separate from generic text extraction; add any missing safe relationships after `expand[]` support.
- [x] Slack: audit v0.3.0 coverage for reactions, attachments, canvases, stars, user groups, and reminders.
  - 2026-04-25 ChatGPT/GitHub/Slack audit slice: `reactions`, `message_attachments`, and `canvases` are declared in `manifests/slack.json`, implemented in `connectors/slack/index.ts`/`parsers.ts`, and covered by parser/integration tests. `stars`, `user_groups`, and `reminders` are manifest-declared as Layer 2 streams but intentionally emit `SKIP_RESULT` from the slackdump archive path because slackdump archive mode does not call `stars.list`, `usergroups.list`, or `reminders.list`; implementing them requires an API fallback with live Slack credentials.
- [ ] Reddit: re-ingest from verified Reddit credentials or keep connector marked untrusted.
  - 2026-04-24 owner pass completed the connector-side stream/schema work but did not mark existing DB rows trusted: `reddit` v0.2.0 now declares and shape-checks `submitted`, `comments`, `saved`, `upvoted`, `downvoted`, and `hidden`, with parser/integration coverage for pagination, cursoring, request scoping, and schema-failure skips. `gilded` was retracted on 2026-04-28 after live testing showed `/user/{name}/gilded.json` is not a current reliable Reddit JSON listing surface; evidence is captured in `design-notes/reddit-gilded-retraction-2026-04-28.md`. The local database still needs the separate purge/re-ingest step before Reddit can be used as internal-demo evidence.
- [ ] Spotify: keep blocked/untrusted until real account access is possible.

## 3. Validation

- [x] Add or update connector parser/integration tests for each changed connector.
  - 2026-04-24 worker slice added `packages/polyfill-connectors/connectors/ynab/integration.test.ts`.
  - 2026-04-25 ChatGPT/GitHub/Slack audit slice added `custom_gpts` and `shared_conversations` fake-API integration coverage in `packages/polyfill-connectors/connectors/chatgpt/integration.test.ts`.
  - 2026-04-24 owner pass added `packages/polyfill-connectors/connectors/reddit/parsers.test.ts` and `packages/polyfill-connectors/connectors/reddit/integration.test.ts` for the Reddit v0.2.0 stream expansion and schema validation.
- [x] Run `pnpm --dir packages/polyfill-connectors run verify`.
  - 2026-04-24 worker slice: passed.
  - 2026-04-25 ChatGPT/GitHub/Slack audit slice: passed after installing workspace dependencies in the isolated worktree with `pnpm install --ignore-scripts`.
- [x] Run targeted reference ingestion/query tests for any changed manifest shape.
  - 2026-04-24 worker slice: not applicable; no manifest shape changed. Targeted YNAB connector integration test passed with `pnpm --dir packages/polyfill-connectors exec node --test --test-timeout=30000 --import tsx connectors/ynab/integration.test.ts`. Full connector tests passed with `pnpm --dir packages/polyfill-connectors test` (586 tests, 580 passed, 6 skipped).
  - 2026-04-25 ChatGPT/GitHub/Slack audit slice: not applicable; no manifest shape changed. Targeted ChatGPT/GitHub/Slack connector tests passed with `pnpm --dir packages/polyfill-connectors exec node --test --test-timeout=30000 --import tsx connectors/chatgpt/integration.test.ts connectors/chatgpt/parsers.test.ts connectors/github/parsers.test.ts connectors/slack/parsers.test.ts connectors/slack/integration.test.ts` (117 tests passed). Full connector tests also passed with `pnpm --dir packages/polyfill-connectors test` (595 tests, 589 passed, 6 skipped).
  - 2026-04-24 owner pass changed the Reddit manifest shape; targeted connector tests passed with `pnpm --dir packages/polyfill-connectors exec node --test --test-timeout=30000 --import tsx connectors/reddit/integration.test.ts connectors/reddit/parsers.test.ts`. Reference registration/query validation passed with `pnpm --dir reference-implementation exec node --test test/polyfill-range-filters.test.js test/query-contract.test.js` (39/39).
- [x] Run `openspec validate add-polyfill-layer-two-stream-coverage --strict`.
  - 2026-04-24 worker slice: passed.
  - 2026-04-25 ChatGPT/GitHub/Slack audit slice: passed.
- [x] Run `openspec validate --all --strict`.
  - 2026-04-25 ChatGPT/GitHub/Slack audit slice: passed (12 items).
