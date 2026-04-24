## 1. Baseline

- [ ] Reconcile this task list with the Layer 2 backlog currently embedded in `add-polyfill-connector-system/tasks.md`.
- [ ] Record which existing local rows are trusted owner data, untrusted seed/demo data, or unknown.
- [ ] Purge or quarantine Spotify and Reddit seed/demo rows before using them as internal-demo evidence.

## 2. Connector Slices

- [ ] ChatGPT: audit and complete `custom_gpts`, `custom_instructions`, and `shared_conversations` coverage if not already shipped.
- [ ] Claude Code: add recursive sidechain/tool-result traversal, `memory_notes`, `skills`, and `slash_commands` where source files exist.
- [ ] Codex: evaluate `state_5.sqlite` as canonical session metadata and add prompts, skills, and approval rules where source files exist.
- [ ] GitHub: evaluate issues, pull requests, gists, followers, and following streams against available token scopes.
- [ ] YNAB: add `month_categories` coverage.
- [ ] USAA: wire transfers, bill payments, scheduled transactions, external accounts, and statement metadata only where live access is stable.
- [ ] Gmail: keep attachment blob hydration separate from generic text extraction; add any missing safe relationships after `expand[]` support.
- [ ] Slack: audit v0.3.0 coverage for reactions, attachments, canvases, stars, user groups, and reminders.
- [ ] Reddit: re-ingest from verified Reddit credentials or keep connector marked untrusted.
- [ ] Spotify: keep blocked/untrusted until real account access is possible.

## 3. Validation

- [ ] Add or update connector parser/integration tests for each changed connector.
- [ ] Run `pnpm --dir packages/polyfill-connectors run verify`.
- [ ] Run targeted reference ingestion/query tests for any changed manifest shape.
- [ ] Run `openspec validate add-polyfill-layer-two-stream-coverage --strict`.
- [ ] Run `openspec validate --all --strict`.
