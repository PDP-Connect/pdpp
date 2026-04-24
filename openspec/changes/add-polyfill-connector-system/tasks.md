# Tasks — add-polyfill-connector-system

Legend: `[x]` done, `[~]` in progress, `[ ]` pending, `[!]` blocked on user, `[?]` needs the owner's review on return.

Last revised: 2026-04-24.

## Status at a glance (2026-04-21)

- **31 manifests total** (30 + Chase added 2026-04-21). All validate against the reference AS.
- **951,313 real records** across 8 active connectors in a unified 2.8 GB DB (`polyfill.sqlite`):
  - slack 349,139 · claude-code 235,757 · codex 74,033 · gmail 50,407 · ynab 21,513 · chatgpt 11,341 · github 8,608 · usaa 924
- **All 8 connectors' most recent run committed state successfully.**
- **Browser daemon** (`src/browser-daemon.js`, `bin/browser-daemon-worker.js`) — long-lived Chromium preserves session cookies across connector runs; fixed USAA's session-token-expiry-on-process-exit problem.
- **Fleet-wide JSONL correctness fixes**: U+2028/U+2029 escape + BigInt coercion + stdout backpressure drain in `src/safe-emit.js`; Gmail 887-record crash and Slack 1,716-record truncation both traced to these.
- **USAA**: credit-card CSV export working; PDF parser handles trailing-minus currency, non-statement filter, and year-assignment for December-on-January-statement cases.
- **Slack**: 24 GB archive, 196k distinct messages, 0 missing thread parents; retry-budget bump (`config/slackdump-api-config.toml`) resolves eng_github-class 500-error cascade.
- **Chase v0.1 scaffolded**: manifest + auto-login probe + `design-notes/chase.md` (QFX-over-browser strategy; Direct Connect rejected per research). Auto-login probe verified end-to-end through full 2FA including mds-* shadow DOM.
- **Reference-impl fix**: express.json body limit 100kb → 100mb so claude-code's file_mtimes cursor stops 413'ing state commits.
- **Three new open-question notes** documenting the partial-data honesty mechanism (decision deferred; must be decided together):
  - `partial-run-semantics-open-question.md` (production side)
  - `cursor-finality-and-gap-awareness-open-question.md` (memory side)
  - `gap-recovery-execution-open-question.md` (execution side, with 4-category skip taxonomy)
- **Blob-hydration + storage-topology notes** extended with Slack's 24 GB concrete scale data — rules out SQLite BLOB column, suggests hybrid content-addressed filesystem + metadata.

## Per-connector status

| Connector | Status | Records in RS | Notes |
|---|---|---|---|
| ynab | ✅ done | 21,513 | Tombstones via `op=delete`. server_knowledge cursor is gap-free by construction. |
| gmail | ✅ done | 50,407 | IMAP + app password. BigInt crash fixed 2026-04-20 (shared `stringifyForJsonl` coerces BigInt; was dropping 887 records + state per run). |
| chatgpt | ✅ done | 11,341 | Browser fetch, tree-walk, bearer from `#client-bootstrap`. 4,188 durably-logged http_429 skips await the gap-recovery mechanism (see `chatgpt.md`). |
| usaa | 🟡 regression | 924 | accounts, transactions, statements, inbox_messages, credit_card_billing. Credit-card CSV export fixed 2026-04-20 (`.as_credit__export` selector, `startDate` input name). 2026-04-24 live run failed before browser interaction with `net::ERR_HTTP2_PROTOCOL_ERROR` on `https://www.usaa.com/my/logon`; investigate Playwright/network/session setup before calling USAA done again. |
| claude_code | ✅ ingest fixed | 235,757 | 2.8 GB DB. state_streams_committed: 4/4 historically after the 413 fix. 2026-04-24 live run showed >1k `IN_PROGRESS` rows then failed `/ingest/sessions` with `500 Internal Server Error`; root cause was controller-managed runtime ingest using the public composed web origin instead of the internal RS URL. Progress volume remains a separate follow-up. |
| codex | ✅ done | 74,033 | 0 nulls, 0 drops across function_calls + messages + sessions. |
| amazon | 🟡 v0.1 in progress | 0 | 2FA-on-wife's-phone blocker resolved 2026-04-21 (new account). Auto-login verified end-to-end (`#ap_email_login` + `#ap_password` selectors, OTP via INTERACTION). `fetchOrderDetail` intentionally stubbed pending live DOM probe. Manifest overclaims ~11 fields (see `amazon.md`). |
| chase | ✅ v0.1 working | 16 (1 account, 14 txns, 1 balance) | NEW 2026-04-21. End-to-end: auto-login via `src/auto-login/chase.js` (mds-* shadow DOM, text/role locators per Playwright best practices), discover accounts via `#accounts-name-link-button-<id>-label` pattern, QFX download via `mds-select#downloadFileTypeOption` + `mds-button#download`, parse via `ofx-js`. Only credit card so far (account-param `CARD,BAC`); checking/savings param shapes are placeholders. v0.2: date-range support (currently "Current display" ~30 days), statement PDFs. |
| github | 🟡 regression | 8,608 | PAT auto-created via `bin/bootstrap-github-pat.js` (headless login → INTERACTION for 2FA → PAT form → token written to `.env.local`). 2026-04-24: run fails with `progress_for_undeclared_stream` because the connector reports `PROGRESS` for `commits` while the manifest scope omits a `commits` stream. |
| oura | 🟡 ready | 0 | Awaits `OURA_PERSONAL_ACCESS_TOKEN`. |
| spotify | 🚫 blocked upstream | 0 | Spotify froze new developer app creation in Feb 2026; OAuth-only anyway. Keep manifest, revisit when Spotify re-opens. |
| strava | 🟡 ready | 0 | Awaits `STRAVA_ACCESS_TOKEN`. |
| notion | 🟡 ready | 0 | Awaits `NOTION_API_TOKEN`. |
| reddit | 🟡 ready | 0 | Awaits Reddit credentials; cursor fix landed. |
| pocket | 🚫 deprecated | 0 | Mozilla shut Pocket down 2025-07-08; all user data deleted 2025-10-08. Excluded from register-all. Connector retained as historical reference only. |
| slack | ✅ done | 349,139 | slackdump subprocess, 24 GB archive, 196k messages, 73k reactions, 57k attachments, 17k files, 973 channels, 292 users, 0 missing thread parents. Retry-budget config + backpressure drain landed 2026-04-20. |
| anthropic | 🟡 scaffolded | 0 | Selectors TBD; needs live DOM walk. |
| shopify | 🟡 scaffolded | 0 | Selectors TBD. |
| heb | 🟡 scaffolded | 0 | Selectors TBD. |
| wholefoods | 🟡 scaffolded | 0 | Piggybacks on Amazon session; selectors TBD. |
| linkedin | 🟡 scaffolded | 0 | Selectors TBD. |
| meta (Instagram) | 🟡 scaffolded | 0 | Selectors TBD. |
| loom | 🟡 scaffolded | 0 | Selectors TBD. |
| uber | 🟡 scaffolded | 0 | Selectors TBD. |
| doordash | 🟡 scaffolded | 0 | Selectors TBD. |
| whatsapp | ✅ file-based | 0 | Drop .txt exports in `~/.pdpp/imports/whatsapp/`. |
| google_takeout | ✅ file-based | 0 | Extract into `~/.pdpp/imports/google_takeout/`. |
| twitter_archive | ✅ file-based | 0 | Extract into `~/.pdpp/imports/twitter_archive/`. |
| imessage | ✅ file-based | 0 | Auto-discovers `~/Library/Messages/chat.db`. |
| apple_health | ✅ file-based | 0 | Extract into `~/.pdpp/imports/apple_health/`. |
| ical | ✅ file-based | 0 | Drop .ics files or set `ICAL_SUBSCRIPTION_URL`. |

## Infrastructure (delivered)

- [x] `bin/bootstrap-github-pat.js` — headless PAT creation with 2FA via INTERACTION. Pattern replicable for other PAT-capable platforms.
- [x] `src/interaction-handler.js` — canonical onInteraction handler for CLI (file drop + TTY + ntfy)
- [x] Shared `src/scope-filters.js` helper (`resourceSet`, `passesTimeRange`, `passesResourceFilter`, `makeEmitGate`, `emitTombstones`, `requireCredentialsOrAsk`)
- [x] Shared `src/browser-scraper-runtime.js` harness with optional `ensureSession` hook
- [x] `src/auto-login/{usaa,amazon,chatgpt}.js` — stored-creds + 2FA-via-ntfy helpers
- [x] `bin/register-all.js` — smoke test that all manifests parse + validate
- [x] Orchestrator respects `PDPP_DB_PATH` env override (enables parallel runs into separate DBs)
- [x] `flushAndExit(code)` fix in every connector — prevents JSONL truncation at end of run
- [x] `filesystem: {}` binding exposed by runtime (`buildAvailableBindings`) — enables local-file connectors

## Infrastructure (still pending)

- [x] Browser daemon — long-lived Chromium, CDP-attached, session cookies persist across runs. `pdpp-connectors browser start|stop|status|restart|logs` CLI. Resolves the USAA session-token-on-process-exit problem documented in the 2026-04-20 Opus research.
- [x] Session keep-alive probes (`scripts/session-keepalive.mjs`) — 8-min interval ping against Chase + Amazon authenticated URLs.
- [ ] Scheduler persistence (SQLite-backed `run_history` + `last_run_time`)
- [ ] Inbox module (`reference-implementation/server/inbox.js`) + routes + minimal HTML *(reference-impl concern)*
- [x] `ntfy` bridge module — exists at `src/ntfy.js`, used by scheduler-runner and the new CLI interaction handler
- [x] Orchestrator CLI now wires `onInteraction` — file-drop response + ntfy + TTY prompt. Runs that need creds/OTP no longer fail silently.
- [ ] Pause/resume INTERACTION handling — runtime supports parking, scheduler doesn't read the state yet
- [ ] First-party connector progress reporting pass — audit core connectors and emit `PROGRESS { count, total }` wherever the upstream exposes a bounded unit of work (pages, files, accounts, budgets, repositories, archive entries). Connectors that cannot know a total should still report phase/count honestly. Do not invent percentages.
- [ ] **Nightly status summary via ntfy** — today still fires manually
- [ ] **Partial-run honesty mechanism** (SKIP_RESULT taxonomy + known_gaps in STATE + recovery execution contract) — documented as three linked open questions. Decision required across all three together. See the three `*-open-question.md` notes.

## Spec-conformance work (delivered today)

See `design-notes/spec-conformance-upgrade-2026-04-19.md` for the full retrofit table. Summary:

- [x] All 28 connectors honor the `resources` filter on every stream
- [x] Mutable-state connectors emit tombstones (`op=delete`) where the upstream exposes deletion signals (YNAB, Notion, Pocket, Gmail). Others deferred — see note below.
- [x] Runtime-binding violations now emit `INTERACTION kind=missing_credentials` instead of failing silently
- [x] Reddit cursor replaced with `sinceEpochUtc` stop-condition in `paginate()` — resolves duplicate-across-runs bug
- [x] `flushAndExit` pattern applied to every connector
- [x] USAA unattended re-auth (OTP via INTERACTION → ntfy → the owner's phone → wife's-phone forward)
- [x] USAA brought to 5 streams (was 1)
- [x] Amazon / ChatGPT re-auth via ensure-session helpers

## Claude Code + Codex (delivered today)

- [x] `connectors/claude_code/index.js` + `manifests/claude_code.json` — parses `~/.claude/projects/**/*.jsonl`, emits sessions/messages/attachments. Incremental via file-mtime.
- [x] `connectors/codex/index.js` + `manifests/codex.json` — parses `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, emits sessions/messages/function_calls. Reasoning encrypted-content skipped intentionally.
- [x] Runtime filesystem binding exposed (buildAvailableBindings)
- [x] Content preview capped at 5 KB (down from 20 KB) — plenty of signal, 4× smaller payloads
- [x] PROGRESS every 2000 lines so long parses show liveness
- [x] `CLAUDE_CODE_PROJECT_INCLUDE/EXCLUDE` env vars for optional scoping (trigger for the open-question note)
- [~] Full Claude Code ingest in progress (SillyTavern excluded for this run; the owner confirmed he wants it included on next)
- [~] Full Codex ingest in progress (separate DB)

## OpenSpec hygiene

- [x] Change proposal written
- [x] Design.md written
- [x] `tasks.md` updated (this file, 2026-04-19 EOD)
- [x] `design-notes/0-overnight-summary.md` — 2026-04-19 morning
- [x] `design-notes/spec-conformance-upgrade-2026-04-19.md`
- [x] `design-notes/unattended-operation.md`
- [x] `design-notes/connector-configuration-open-question.md` — new today
- [x] `design-notes/settings-stream-convention-open-question.md` — new today (Layer 2 cross-cutting)
- [x] `design-notes/usaa-extra-streams.md`
- [ ] New `design-notes/claude-code-codex-connectors.md` — rationale + schema decisions for the two local-file connectors (following)
- [ ] Move OpenAI/Anthropic token data from "scaffolded" to "implemented" once selectors wired

## Post-refactor quality follow-up (owner-approved 2026-04-23)

This section captures the durable outcome of the A++ follow-up review. It is
the canonical execution list; the temporary response memo can be deleted once
these tasks are tracked here.

### Tranche A — establish truth first

- [x] Compare every decomposed connector against the last pre-decomposition commit before changing behavior.
  Output must be a short matrix: connector, last pre-decomp commit, material differences, intentional vs regression, required action.
- [x] Replace hand-rolled integration `emitRecord` mocks with a helper that runs the real shape validator and records both emitted and skipped records.
- [x] Audit the remaining `@ts-expect-error` directives inside `page.evaluate()` and remove them unless they are still genuinely required.
- [x] Investigate the `apple_health` parser timeout hypothesis and record whether it was warmup-only or a real pathological test.

### Tranche B — remove accidental complexity

- [x] Replace the current `collect-helpers.ts` workaround with a small explicit entrypoint helper (`isMainModule()` / `runConnectorIfMain()` or equivalent) without overloading `runConnector()` with process-launch semantics.
- [x] Add package-scoped CI for `packages/polyfill-connectors/**` running `verify` and `test`.
  Start non-blocking first; only promote to required after a proving period.

### Tranche C — behavior correction, only after Tranche A

- [x] Standardize connector emit ordering on `parent-first`, after the pre-decomposition audit confirmed gmail/chatgpt/claude_code child-first behavior was intentional pre-existing behavior rather than decomposition drift.
- [x] Update `packages/polyfill-connectors/docs/authoring-guide.md` so connector authors can rely on `parent-first` explicitly.
  Owner decision: keep `parent-first` as the reference-quality default because the live-ingest contract benefits outweigh the measured wall-clock cost on large real corpora. This is a connector/runtime quality rule, not a core PDPP protocol requirement. Connector-specific exceptions require explicit owner sign-off after benchmarked evidence.

### Tranche D — narrow protocol proof

- [ ] Build a subprocess-level protocol harness as a narrow Phase 1 only.
  Success criteria: one non-browser connector test, one browser connector test, and evidence that the harness catches something helper-level tests do not.
- [ ] Decide on wider rollout of protocol subprocess tests only after Phase 1 proves stable and worth the maintenance cost.

### Explicitly deferred unless evidence changes

- [ ] Do not spend effort balancing parser-vs-integration test counts for aesthetic reasons.
  Reassess only if real blind spots remain after the protocol-harness phase.
- [ ] Do not rewrite history for commit-aesthetics cleanup.
- [ ] Do not add clever staged/unstaged merge machinery to lefthook unless a concrete reproducible data-loss case is demonstrated.
  If hook behavior becomes a real problem, prefer the simpler guard: refuse auto-format on partially staged same-file changes.

## Deferred / open

- **Tombstones for additional mutable_state streams.** ChatGPT has no "deleted conversations" signal. USAA statements are append-only. ChatGPT memories mutate; needs a follow-up pass.
- **USAA transfers, bill_payments, scheduled_transactions, external_accounts streams.** Covered by `design-notes/usaa-extra-streams.md`; wiring pending.
- **USAA history beyond 18 months.** Statement-PDF parsing is the likely path; design not started.
- **Browser connector selector-wiring.** Nine connectors scaffolded but need live co-pilot DOM walks.
- **Connector configuration surface.** Open question — manifest-declared `credentials_schema` + `options_schema`. See `design-notes/connector-configuration-open-question.md`. Decision paused pending RFC.
- **RS storage topology.** Open question — one DB per owner vs. per connector, or both under a unified query surface. See `design-notes/rs-storage-topology-open-question.md`. Today Codex is split out under `PDPP_DB_PATH` to dodge SQLITE_BUSY; the split was tactical, not chosen.
- **Credential storage.** Open question — `.env.local` plaintext is the wrong answer for anything beyond single-user laptop dev. See `design-notes/credential-storage-open-question.md`. Vault interface proposed; decision paused.
- **External-tool dependencies.** Open question — `runtime_requirements.external_tools` for subprocess binaries like slackdump (AGPL), osxphotos, Playwright browsers. Today invisible to spec, consent card, and auditors. See `design-notes/external-tool-dependencies-open-question.md`.
- **Layer 2 manifest completeness.** Open question — does a polyfill manifest commit to a coverage contract against the source's actual surface? See `design-notes/layer-2-completeness-open-question.md`.
- **Owner self-export.** Open question — should the RS expose a canonical owner-facing `GET /v1/connectors` / bulk-export surface? See `design-notes/owner-self-export-open-question.md`.
- **Identity graph.** Open question — should cross-connector followers/friends/orgs be promoted to a standard `identity_graph` profile? See `design-notes/identity-graph-open-question.md`.
- **Settings/preferences stream convention.** Open question — normalized `settings` stream shape across connectors. Every connector has user-authored settings; today most omit them. See `design-notes/settings-stream-convention-open-question.md`.
- **SillyTavern re-ingest.** the owner confirmed he wants it included. Re-run after current pass finishes (no EXCLUDE).

## Layer 2 implementation follow-up (raised 2026-04-19)

P0 stream additions identified by the Layer 2 audits (`design-notes/layer-2-coverage-chatgpt-claude-codex.md`, `design-notes/layer-2-coverage-gmail-ynab-usaa-github.md`). Implementation is connector code + manifest; spec-question resolution happens in parallel via the open-question notes above.

## Query/API readiness follow-up (raised 2026-04-24)

These are the highest-leverage gaps surfaced by live assistant use of the reference API. Start with an audit matrix before adding new surface area: field/stream, current manifest declaration, current server behavior, docs/spec claim, tests, and recommended fix.

- [ ] Audit first-party stream schemas for useful range-filter declarations. Add every honest date/date-time/numeric `query.range_filters` entry that enables common windows like "last 7 days" or amount windows; document exclusions where field types, cursor semantics, or source data quality make range filtering unsafe.
- [ ] Audit schema discoverability for every stream. Decide whether the current `/v1/streams/:stream` metadata is sufficient or whether the reference needs an explicit schema/capability endpoint that lists each field's type, exact-filter support, range-filter support, semantic/lexical participation, cursor role, and expandable relations.
- [ ] Audit `expand[]` end to end against the public docs/spec and live server behavior. Verify declared relationships, grant safety, list/detail parity, `expand_limit`, missing/unknown relation errors, and high-value joins such as Gmail messages to message_bodies, attachments, and threads.
- [ ] Audit `changes_since` usability. Confirm whether clients can obtain an initial cursor/documented timestamp, whether raw timestamp input is supported or should be, and whether daily surfacer/incremental-agent workflows can use it without poll-everything-and-diff.
- [ ] Keep Gmail attachment-content work separate from `message_bodies`: `message_bodies` is done, but attachment byte/blob hydration is still pending until `attachments` records expose content-addressed bytes and, ideally, extracted text affordances for PDFs/docs.
- [ ] Defer new public surfaces (`/v1/timeline`, `/v1/entities`, aggregations/facets, webhook subscriptions, hybrid lexical+semantic search, semantic score exposure/reranking) until the audit above identifies which behavior is already promised versus which needs a new OpenSpec change.

### ChatGPT
- [ ] Add `custom_gpts` stream (from `/backend-api/gizmos/mine`)
- [ ] Add `custom_instructions` stream (from `/backend-api/user_system_messages`)
- [ ] Add `shared_conversations` stream (from `/backend-api/shared_conversations`)
- [ ] Re-run after ChatGPT extractor fix lands in next scheduled run

### Claude Code
- [x] Fix live `sessions` ingest regression: current run can emit >1k `IN_PROGRESS` events then fail `/ingest/sessions` with `500 Internal Server Error`. Captured with a safe synthetic Claude Code sessions fixture: controller-managed composed-mode runs were posting the NDJSON sessions batch to the public browser origin, so proxy/body handling could turn `/v1/ingest/sessions` into a 500. Regression test now traps the public origin and proves Claude Code ingest uses the internal RS URL.
- [ ] Reduce or summarize Claude Code two-pass progress volume. The >1k `IN_PROGRESS` rows were not the 500 root cause, but the connector currently emits per-file parse progress in both build and emit passes; decide whether to compact connector progress or summarize it in the operator UI.
- [ ] Recursive session traversal: `projects/<p>/<session>/subagents/*.jsonl` + `/tool-results/*.txt` (currently missed — main jsonl only has sidechain stubs + ~500-char previews)
- [ ] Add `memory_notes` stream (from `projects/<p>/memory/*.md` — direct analog to ChatGPT `memories`)
- [ ] Add `skills` stream (from `~/.claude/skills/<name>/SKILL.md`)
- [ ] Add `slash_commands` stream (from `~/.claude/commands/*.md` + per-repo `./.claude/commands/*.md`)

### Codex
- [ ] Switch `sessions` data source from `rollout.jsonl` to `~/.codex/state_5.sqlite#threads` for canonical metadata (`title`, `archived`, `tokens_used`, `first_user_message`, `sandbox_policy`, `approval_mode`, `agent_nickname`, `agent_role`, `memory_mode`, `git_origin_url`)
- [ ] Add `prompts` stream (from `~/.codex/prompts/*.md`)
- [ ] Add `skills` stream (from `~/.codex/skills/<name>/SKILL.md`)
- [ ] Add `approval_rules` stream (from `~/.codex/rules/default.rules`)

### GitHub
- [ ] Fix `progress_for_undeclared_stream` regression: either add an honest `commits` stream to the GitHub manifest/scope or stop emitting `PROGRESS` for `commits`. Current runtime behavior is correct to reject progress for undeclared streams.
- [ ] Add `issues` stream (authored, assigned, mentioned, commented — via `/search/issues`)
- [ ] Add `pull_requests` stream (authored, reviewed, review-requested, merged — via `/search/issues`)
- [ ] Add `gists` stream (owned + starred; full content bytes cheap)
- [ ] Add `followers` / `following` streams (precursor to identity-graph profile)

### YNAB
- [ ] Add `month_categories` matrix stream (per-month-per-category budgeted/activity/balance, keyed on `(budget_id, month, category_id)`)

### USAA
- [x] Fix live login navigation regression: current run fails immediately with `connector_reported_failed` / `usaa_session_failed: page.goto: net::ERR_HTTP2_PROTOCOL_ERROR` at `https://www.usaa.com/my/logon` and never surfaces a browser interaction. Reproduce with browser-daemon logs enabled, compare headed vs headless, and preserve an interaction path if the site blocks automated navigation.
- [ ] Wire already-designed streams (`transfers`, `bill_payments`, `scheduled_transactions`, `external_accounts`) per `design-notes/usaa-extra-streams.md`
- [ ] Statements: implement PDF download + `pdf_sha256` once live browser session is available

### Gmail
- [x] `message_bodies` stream — implemented 2026-04-19 (Layer 2 exemplar fix: `body_sha256` + text/html parts, deferred blob hydration pattern)
- [ ] **Attachment blob collection** (requested 2026-04-22). Today the `attachments` stream emits metadata only (filename, mime, size_bytes, partId) per `decodeBodystructureForAttachments` — the actual bytes never leave IMAP. Wire each attachment record to the reference `POST /v1/blobs` path so attachment content is content-addressed and retrievable via `GET /v1/blobs/{blob_id}`. Pattern to mirror: Slack's `message_attachments` stream + the `/v1/blobs/{blob_id}` contract resolved 2026-04-22 (see `design-notes/blob-id-param-naming-2026-04-22.md`). IMAP fetch path: `client.download(uid, partId)` returns a stream; stream → sha256 → upload → replace `partId` with `blob_id` on the emitted record. Add `content_sha256` + `blob_id` fields to the attachments schema alongside existing metadata. Deferred-hydration pattern (same as `message_bodies`'s `body_sha256`): connector can emit `blob_id=null` + `content_sha256` first, and the storage layer uploads bytes asynchronously — but the link must exist so consumers can resolve. Blocked on nothing; fits naturally into the gmail parsers.ts refactor in progress.

### Slack
- [ ] Reactions, message_attachments, etc. — already in v0.2.0 schema, ingesting now; audit v0.3.0 coverage after completion
- [ ] P1: canvases content, stars/saved items, user groups, reminders

### Fixture pipeline (test-harness prerequisite)
- [ ] LLM-based PII scrubber for captured fixtures. Default regex scrubber (`bin/scrub-fixtures.ts`) only handles emails/phones/SSNs/cards; real captures contain addresses, personal names, merchant payloads, and free-form order content that need semantic redaction. Plan: pipe each captured DOM/JSONL through Gemini 3.1 Flash or Flash-Lite with a structured redaction prompt (names → "First Last", addresses → "123 Main St, City, ST 00000", keep structural content like selectors/classes). Until this exists, `fixtures/*/raw/` and `fixtures/*/scrubbed/` are gitignored and parser tests run against synthetic minimal fixtures only. Unblocks: committing real golden fixtures for parser-extraction regression tests (amazon/chase/gmail/usaa).
- [ ] Connector-specific scrub-rule files (`connectors/<name>/scrub-rules.ts`) for patterns that beat the LLM on precision (order IDs, account numbers, known field shapes).

## Review checklist for the owner

- [?] Every `(autonomous 2026-04-19)` decision in design notes
- [?] Schema shape for each connector (platform-native; sanity-check for missed fields)
- [?] Claude Code + Codex stream design (`sessions`/`messages`/`attachments` vs `sessions`/`messages`/`function_calls`)
- [?] Connector-configuration open question — direction on manifest-declared schemas
- [?] ntfy morning summary content
