# Tasks — add-polyfill-connector-system

Legend: `[x]` done, `[~]` in progress, `[ ]` pending, `[!]` blocked on user, `[?]` needs the owner's review on return.

Last revised: 2026-04-21.

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
| usaa | ✅ done (5 streams) | 924 | accounts, transactions, statements, inbox_messages, credit_card_billing. Credit-card CSV export fixed 2026-04-20 (`.as_credit__export` selector, `startDate` input name). PDF parser: trailing-minus, T&C filter, Dec-on-Jan-statement year fix. 0 future-dated txns. |
| claude_code | ✅ done | 235,757 | 2.8 GB DB. state_streams_committed: 4/4 (413 fix landed, no more partial commits). |
| codex | ✅ done | 74,033 | 0 nulls, 0 drops across function_calls + messages + sessions. |
| amazon | 🟡 v0.1 in progress | 0 | 2FA-on-wife's-phone blocker resolved 2026-04-21 (new account). Auto-login verified end-to-end (`#ap_email_login` + `#ap_password` selectors, OTP via INTERACTION). `fetchOrderDetail` intentionally stubbed pending live DOM probe. Manifest overclaims ~11 fields (see `amazon.md`). |
| chase | 🟡 v0.1 scaffolded | 0 | NEW 2026-04-21. Manifest + `design-notes/chase.md` (QFX strategy). Auto-login probe succeeds through full 2FA via mds-* shadow DOM. Connector `index.js` + `src/auto-login/chase.js` not yet implemented. |
| github | ✅ done | 8,608 | PAT auto-created via `bin/bootstrap-github-pat.js` (headless login → INTERACTION for 2FA → PAT form → token written to `.env.the owner.local`). |
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

## Deferred / open

- **Tombstones for additional mutable_state streams.** ChatGPT has no "deleted conversations" signal. USAA statements are append-only. ChatGPT memories mutate; needs a follow-up pass.
- **USAA transfers, bill_payments, scheduled_transactions, external_accounts streams.** Covered by `design-notes/usaa-extra-streams.md`; wiring pending.
- **USAA history beyond 18 months.** Statement-PDF parsing is the likely path; design not started.
- **Browser connector selector-wiring.** Nine connectors scaffolded but need live co-pilot DOM walks.
- **Connector configuration surface.** Open question — manifest-declared `credentials_schema` + `options_schema`. See `design-notes/connector-configuration-open-question.md`. Decision paused pending RFC.
- **RS storage topology.** Open question — one DB per owner vs. per connector, or both under a unified query surface. See `design-notes/rs-storage-topology-open-question.md`. Today Codex is split out under `PDPP_DB_PATH` to dodge SQLITE_BUSY; the split was tactical, not chosen.
- **Credential storage.** Open question — `.env.the owner.local` plaintext is the wrong answer for anything beyond single-user laptop dev. See `design-notes/credential-storage-open-question.md`. Vault interface proposed; decision paused.
- **External-tool dependencies.** Open question — `runtime_requirements.external_tools` for subprocess binaries like slackdump (AGPL), osxphotos, Playwright browsers. Today invisible to spec, consent card, and auditors. See `design-notes/external-tool-dependencies-open-question.md`.
- **Layer 2 manifest completeness.** Open question — does a polyfill manifest commit to a coverage contract against the source's actual surface? See `design-notes/layer-2-completeness-open-question.md`.
- **Owner self-export.** Open question — should the RS expose a canonical owner-facing `GET /v1/connectors` / bulk-export surface? See `design-notes/owner-self-export-open-question.md`.
- **Identity graph.** Open question — should cross-connector followers/friends/orgs be promoted to a standard `identity_graph` profile? See `design-notes/identity-graph-open-question.md`.
- **Settings/preferences stream convention.** Open question — normalized `settings` stream shape across connectors. Every connector has user-authored settings; today most omit them. See `design-notes/settings-stream-convention-open-question.md`.
- **SillyTavern re-ingest.** the owner confirmed he wants it included. Re-run after current pass finishes (no EXCLUDE).

## Layer 2 implementation follow-up (raised 2026-04-19)

P0 stream additions identified by the Layer 2 audits (`design-notes/layer-2-coverage-chatgpt-claude-codex.md`, `design-notes/layer-2-coverage-gmail-ynab-usaa-github.md`). Implementation is connector code + manifest; spec-question resolution happens in parallel via the open-question notes above.

### ChatGPT
- [ ] Add `custom_gpts` stream (from `/backend-api/gizmos/mine`)
- [ ] Add `custom_instructions` stream (from `/backend-api/user_system_messages`)
- [ ] Add `shared_conversations` stream (from `/backend-api/shared_conversations`)
- [ ] Re-run after ChatGPT extractor fix lands in next scheduled run

### Claude Code
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
- [ ] Add `issues` stream (authored, assigned, mentioned, commented — via `/search/issues`)
- [ ] Add `pull_requests` stream (authored, reviewed, review-requested, merged — via `/search/issues`)
- [ ] Add `gists` stream (owned + starred; full content bytes cheap)
- [ ] Add `followers` / `following` streams (precursor to identity-graph profile)

### YNAB
- [ ] Add `month_categories` matrix stream (per-month-per-category budgeted/activity/balance, keyed on `(budget_id, month, category_id)`)

### USAA
- [ ] Wire already-designed streams (`transfers`, `bill_payments`, `scheduled_transactions`, `external_accounts`) per `design-notes/usaa-extra-streams.md`
- [ ] Statements: implement PDF download + `pdf_sha256` once live browser session is available

### Gmail
- [x] `message_bodies` stream — implemented 2026-04-19 (Layer 2 exemplar fix: `body_sha256` + text/html parts, deferred blob hydration pattern)

### Slack
- [ ] Reactions, message_attachments, etc. — already in v0.2.0 schema, ingesting now; audit v0.3.0 coverage after completion
- [ ] P1: canvases content, stars/saved items, user groups, reminders

## Review checklist for the owner

- [?] Every `(autonomous 2026-04-19)` decision in design notes
- [?] Schema shape for each connector (platform-native; sanity-check for missed fields)
- [?] Claude Code + Codex stream design (`sessions`/`messages`/`attachments` vs `sessions`/`messages`/`function_calls`)
- [?] Connector-configuration open question — direction on manifest-declared schemas
- [?] ntfy morning summary content
