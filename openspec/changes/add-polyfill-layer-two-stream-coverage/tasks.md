## 1. Baseline

- [x] Reconcile this task list with the Layer 2 backlog currently embedded in `add-polyfill-connector-system/tasks.md`.
  - 2026-04-25 Claude Code/Codex slice reconciled: backlog entries for Claude recursive subagents/tool-results, skills, slash commands, and Codex state_5/prompts/skills/rules were already mostly shipped. This slice added Claude `memory_notes`, made subagent traversal recursive, and kept Codex's actual stream name as `rules` because the real local source is `~/.codex/rules/*.rules`; `approval_rules` was backlog shorthand.
- [ ] Record which existing local rows are trusted owner data, untrusted seed/demo data, or unknown.
- [ ] Purge or quarantine Spotify and Reddit seed/demo rows before using them as internal-demo evidence.

## 2. Connector Slices

- [ ] ChatGPT: audit and complete `custom_gpts`, `custom_instructions`, and `shared_conversations` coverage if not already shipped.
- [x] Claude Code: add recursive sidechain/tool-result traversal, `memory_notes`, `skills`, and `slash_commands` where source files exist.
- [x] Codex: evaluate `state_5.sqlite` as canonical session metadata and add prompts, skills, and approval rules where source files exist.
  - 2026-04-25 closeout: `state_5.sqlite#threads`, `prompts`, `skills`, and `rules` were already implemented. The manifest/code now explicitly document that `rules` is the honest stream name for Codex approval/trust rules.
- [ ] GitHub: evaluate issues, pull requests, gists, followers, and following streams against available token scopes.
- [ ] YNAB: add `month_categories` coverage.
- [ ] USAA: wire transfers, bill payments, scheduled transactions, external accounts, and statement metadata only where live access is stable.
- [ ] Gmail: keep attachment blob hydration separate from generic text extraction; add any missing safe relationships after `expand[]` support.
- [ ] Slack: audit v0.3.0 coverage for reactions, attachments, canvases, stars, user groups, and reminders.
- [ ] Reddit: re-ingest from verified Reddit credentials or keep connector marked untrusted.
- [ ] Spotify: keep blocked/untrusted until real account access is possible.

## 3. Validation

- [x] Add or update connector parser/integration tests for each changed connector.
- [ ] Run `pnpm --dir packages/polyfill-connectors run verify`.
- [ ] Run targeted reference ingestion/query tests for any changed manifest shape.
- [ ] Run `openspec validate add-polyfill-layer-two-stream-coverage --strict`.
- [ ] Run `openspec validate --all --strict`.
