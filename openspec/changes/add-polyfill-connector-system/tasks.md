# Tasks — add-polyfill-connector-system

Legend: `[x]` done, `[~]` in progress, `[ ]` pending, `[!]` blocked on user, `[?]` needs the owner's review on return.

Last revised: 2026-04-19 (end of day).

## Status at a glance

- **30 manifests total**, all 30 validate against the reference AS (`register-all.js` confirmed 30/30 green).
- **~233,000 real records** across 26 streams in a unified 583 MB DB (`polyfill.sqlite`).
- **WAL + tuned pragmas + BATCH_SIZE=500** delivered ~60× speedup on the big ingests (2.5h → 2 min for Claude Code + Codex).
- **Real records in RS:** YNAB 10k, Gmail 27k, ChatGPT 10k, USAA 887 across 5 streams, Claude Code + Codex **in flight right now**.
- **7 spec-conformance gaps closed** (resources-filter, tombstones, flushAndExit, INTERACTION-on-missing-creds, Reddit cursor, unattended re-auth, USAA 5 streams).
- **Filesystem binding added to runtime** so file-based connectors work.
- **Unattended-operation design** documented (`design-notes/unattended-operation.md`).
- **Connector-configuration open question documented** (`design-notes/connector-configuration-open-question.md`) — decision paused pending inventory + spec RFC.

## Per-connector status

| Connector | Status | Records in RS | Notes |
|---|---|---|---|
| ynab | ✅ done | ~10,311 | Tombstones via `op=delete`. Scheduled-ready. |
| gmail | ✅ done | ~27,359 | IMAP + app password. Tombstones. |
| chatgpt | ✅ done | ~10,616 | Browser fetch, tree-walk, bearer from `#client-bootstrap`. |
| usaa | ✅ done (5 streams) | 887 | accounts, transactions, statements, inbox_messages, credit_card_billing. 18-month floor documented. |
| claude_code | ✅ done | 97,871 (131 sessions, 93,609 messages, 4,131 attachments) | 2.2 GB of jsonl ingested in ~2 min with WAL enabled. SillyTavern excluded this run. |
| codex | ✅ done | 70,978 (163 sessions, 25,941 messages, 44,874 function_calls) | 751 MB / 191 rollouts. Now in unified DB. |
| amazon | ✅ ready, blocked | 0 | `ensureAmazonSession` wired; 2FA on wife's phone. |
| github | ✅ done | 553 | PAT auto-created via `bin/bootstrap-github-pat.js` (headless login → INTERACTION for 2FA → PAT form → token written to `.env.the owner.local`). 1 user + 513 repos + 39 starred. |
| oura | 🟡 ready | 0 | Awaits `OURA_PERSONAL_ACCESS_TOKEN`. |
| spotify | 🚫 blocked upstream | 0 | Spotify froze new developer app creation in Feb 2026; OAuth-only anyway. Keep manifest, revisit when Spotify re-opens. |
| strava | 🟡 ready | 0 | Awaits `STRAVA_ACCESS_TOKEN`. |
| notion | 🟡 ready | 0 | Awaits `NOTION_API_TOKEN`. |
| reddit | 🟡 ready | 0 | Awaits Reddit credentials; cursor fix landed. |
| pocket | 🚫 deprecated | 0 | Mozilla shut Pocket down 2025-07-08; all user data deleted 2025-10-08. Excluded from register-all. Connector retained as historical reference only. |
| slack | 🟡 ingesting | ~0 (running) | slackdump 3.3.3 subprocess, xoxc+d cookie creds extracted via manual paste. Schema v0.2.0: 7 streams (workspace, channels, channel_memberships, users, messages, reactions, files). Full history scrape underway. |
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

- [ ] Browser session keep-alive probes every ~90–120 min per browser-backed connector
- [ ] Scheduler persistence (SQLite-backed `run_history` + `last_run_time`)
- [ ] Inbox module (`reference-implementation/server/inbox.js`) + routes + minimal HTML *(reference-impl concern)*
- [x] `ntfy` bridge module — exists at `src/ntfy.js`, used by scheduler-runner and the new CLI interaction handler
- [x] Orchestrator CLI now wires `onInteraction` — file-drop response + ntfy + TTY prompt. Runs that need creds/OTP no longer fail silently.
- [ ] Pause/resume INTERACTION handling — runtime supports parking, scheduler doesn't read the state yet
- [ ] **Nightly status summary via ntfy** — today still fires manually

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
