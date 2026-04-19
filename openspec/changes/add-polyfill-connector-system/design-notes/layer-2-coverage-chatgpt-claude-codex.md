# Layer 2 coverage audit: ChatGPT, Claude Code, Codex

**Raised:** 2026-04-19
**Context:** Layer 1 compares emitted fields against declared manifest fields. Layer 2 compares the manifest against the *source's actual surface* — what the platform exposes that a user might want and we omit. This audit covers the three AI-assistant connectors; none have been reviewed against the full upstream surface since v0.1.

---

## ChatGPT

### Current manifest scope
`conversations`, `messages` (flattened current-branch tree), `memories`. Profiles `chats`, `full`.

### Source surface
Endpoints the browser UI hits on `chatgpt.com/backend-api`:
- `/conversations`, `/conversation/{id}` (declared)
- `/memories?include_memory_entries=true` (declared)
- `/gizmos/mine` — user-authored **Custom GPTs**
- `/gizmos/bootstrap/projects`, `/public-api/conversations` — **Projects** (group of conversations + instructions + files)
- `/shared_conversations` — public share links the user created
- `/user_system_messages` — **custom instructions** ("about me" / "how to respond" / traits)
- `/files/{id}`, `/files/{id}/download` — uploaded attachments (message.attachment_ids resolves here; never joined)
- `/accounts/check`, `/me` — account + workspace identity
- `/settings/data_controls` — training opt-out, retention
Voice transcripts land in the normal conversation tree. Canvas docs appear as `content_type:"canvas"` message parts.

### Gaps
- **Stream `custom_gpts` (P0):** User's own GPTs are a primary creative artifact. `GET /backend-api/gizmos/mine?limit=24&cursor=...` → `{items:[{id, short_url, display:{name, description, prompt_starters, welcome_message, profile_picture_url}, author, instructions, tools, files, updated_at}]}`. Equivalent to Notion omitting pages the user wrote.
- **Stream `custom_instructions` (P0):** `GET /backend-api/user_system_messages` → `{enabled, about_user_message, about_model_message, name_user_message, role_user_message, traits_model_message, disabled_tools}`. Explicit in OpenAI's own takeout; comparable in weight to `memories` which we already have.
- **Stream `shared_conversations` (P1):** `GET /backend-api/shared_conversations?order=created` → `{share_id, conversation_id, title, create_time, update_time, is_anonymous, highlighted_message_id}`. High recall-value — users rarely remember what they've published.
- **Stream `projects` + field `project_id` on conversations (P1):** lift Projects out as their own stream; `project_id` is in the detail response today but dropped.
- **Stream `files` (P2):** resolve `attachment_ids` via `GET /backend-api/files/{id}` → `{file_name, mime_type, size, download_url, created_at}`. Optional bytes fetch.
- **Field split on `messages` (P2):** for `content_type=user_editable_context`, split user_profile/user_instructions out of the shared `content` column (or lift into `custom_instructions`).
- **Stream `account` (P2):** email, plan, workspaces from `/me`.

### Deliberately omitted
- Bearer token + oai-device-id — auth.
- Voice audio blobs — no distinct endpoint; transcripts are in messages.
- Enterprise admin surfaces (audit logs, SCIM) — admin-scoped, not the individual user's.

---

## Claude Code

### Current manifest scope
`sessions`, `messages`, `attachments`, all from `~/.claude/projects/<encoded>/*.jsonl`.

### Source surface (`~/.claude/` on this machine)
- `projects/<p>/*.jsonl` — session transcripts (declared)
- `projects/<p>/<session>/subagents/*.jsonl` — **full subagent transcripts** (the main jsonl only has sidechain stubs)
- `projects/<p>/<session>/tool-results/*.txt` — full tool outputs (main jsonl stores ~500-char previews)
- `projects/<p>/memory/*.md` — assistant-curated **per-project memory** (MEMORY.md + feedback notes)
- `skills/<name>/SKILL.md` — user-installed skills (40+ here)
- `commands/*.md` — user-authored slash commands
- `hooks/*.sh` — user shell hooks
- `plugins/installed_plugins.json` + `plugins/marketplaces/` — plugin registry
- `settings.json`, `settings.local.json` — permissions, enabled MCP servers, hooks
- `file-history/<uuid>/<hash>@v<n>` — versioned snapshots of every file the agent edited
- `todos/*.json`, `tasks/<id>/`, `sessions/<id>/`, `paste-cache/*.txt`, `captured-insights.md`, `history.jsonl` — various state
- `CLAUDE.md`, `CLAUDE.local.md`, `RTK.md` — user-level system prompts
- Each repo also carries `./CLAUDE.md` + `./.claude/settings.json` + `./.claude/commands/` — project-scoped behavior contracts

### Gaps
- **Stream `skills` (P0):** `~/.claude/skills/<name>/SKILL.md` + supporting files. Record: `{id, name, scope:"user"|"project", description, triggers, body, path, installed_from?}`. Same weight as ChatGPT custom_gpts — user-authored customization.
- **Stream `slash_commands` (P0):** `~/.claude/commands/*.md` (+ per-repo `./.claude/commands/*.md`). Frontmatter `{description, argument-hint}` + prompt body.
- **Stream `memory_notes` (P0):** `~/.claude/projects/<p>/memory/*.md`. The direct analog to ChatGPT `memories` — currently invisible. `{id, project_path, filename, body, updated_at}`.
- **Stream `subagent_transcripts` (P1):** `projects/<p>/<session>/subagents/*.jsonl`. Sidechain stubs in the main jsonl reference but don't contain these; for heavy sessions they hold most of the model's work.
- **Stream `tool_results_full` (P1):** resolve 500-char `content_preview` to the full `.txt` body via `tool_use_id`.
- **Stream `file_snapshots` (P1):** metadata from `~/.claude/file-history/<uuid>/<hash>@v<n>`. Opt-in for bytes.
- **Stream `project_instructions` (P1):** per-repo `./CLAUDE.md` + `./.claude/settings.json`; scope derivable from `session.cwd`.
- **Stream `settings` singleton (P2):** permissions, hooks, enabled MCP servers.
- **Stream `todos` (P2):** `~/.claude/todos/*.json`.

### Deliberately omitted
- `.credentials.json` — auth.
- `statsig/`, `telemetry/`, `debug/`, `stats-cache.json`, `mcp-needs-auth-cache.json` — product telemetry.
- `shell-snapshots/`, `session-env/`, `plugins/cache/` — restoration caches / checked-out plugin code.
- `paste-cache/*.txt`, `history.jsonl` — redundant with message content when actually used.
- `file-history/` bytes — size-prohibitive; metadata only unless user opts in.

---

## Codex

### Current manifest scope
`sessions`, `messages`, `function_calls` from `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`.

### Source surface (`~/.codex/`)
- `sessions/YYYY/MM/DD/rollout-*.jsonl` — rollouts (declared)
- `state_5.sqlite` — **thread index DB**. `threads` has: `id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode, tokens_used, has_user_event, archived, archived_at, git_sha, git_branch, git_origin_url, cli_version, first_user_message, agent_nickname, agent_role, memory_mode, model, reasoning_effort, agent_path`. Also `thread_dynamic_tools`, `thread_spawn_edges`, `agent_jobs`, `agent_job_items`.
- `config.toml` — model/effort/sandbox defaults + per-project `trust_level` map
- `prompts/*.md` — user-authored slash-command templates
- `rules/default.rules` — accumulated `prefix_rule(pattern=[...], decision=...)` trust decisions
- `skills/<name>/SKILL.md` — user-installed skills (14 here)
- `memories/` — reserved for future memory feature (empty today)
- `logs_2.sqlite`, `shell_snapshots/`, `cache/`, `tmp/`, `models_cache.json`, `auth.json`, `installation_id`, `version.json` — telemetry/auth/ephemeral

### Gaps
- **Fields on `sessions` via `state_5.sqlite#threads` join (P0):** `title`, `archived`, `archived_at`, `tokens_used`, `first_user_message`, `sandbox_policy`, `approval_mode`, `agent_nickname`, `agent_role`, `memory_mode`, `git_origin_url`. Users cannot reconcile their session list without `title` and `archived`. Either enrich `sessions` or add a `threads` stream — but the DB, not the rollout jsonl, is the truth for these fields.
- **Stream `prompts` (P0):** `~/.codex/prompts/*.md`. User-authored slash commands, same as Claude Code.
- **Stream `skills` (P0):** `~/.codex/skills/<name>/SKILL.md`. Same as Claude Code.
- **Stream `approval_rules` (P1):** `~/.codex/rules/default.rules`, accumulated prefix_rule decisions. `{id, pattern, decision, updated_at}`.
- **Stream `config` singleton (P1):** `config.toml` — model default, effort, sandbox_mode, per-project trust_level map.
- **Stream `agent_jobs` (P2):** Codex background-agent state. Low priority for v0.1.

### Deliberately omitted
- `auth.json`, `installation_id` — auth/telemetry.
- `logs_2.sqlite`, `shell_snapshots/`, `cache/`, `tmp/`, `.tmp/`, `models_cache.json` — operational.
- Encrypted reasoning traces — opaque by design.
- `AGENTS.md` when symlinked out to dotfiles (user manages externally).

---

## Cross-cutting observations

1. **User-authored customization is the systematic blind spot.** All three connectors capture runtime transcripts but miss *authored* artifacts: Custom GPTs + custom instructions (ChatGPT), skills + commands + memory notes (Claude Code), prompts + skills + rules (Codex). These are the highest-leverage, lowest-volume pieces of user data and their absence would be the most embarrassing gap in a "true export" promise.

2. **"Sessions" is two tables on disk for the local connectors.** Codex `state_5.sqlite#threads` is the truth for `title`/`archived`/`tokens_used`; the rollout jsonl is subordinate. Claude Code has `projects/<p>/memory/*.md` and `projects/<p>/<session>/subagents/*.jsonl` that single-file parsing never sees. Both manifests implicitly assume one-file-equals-one-session; the reality is hierarchical.

3. **Fan-out payloads are represented by IDs, not resolved.** ChatGPT `attachment_ids`, Codex `output_preview`, Claude Code `content_preview` all leave the real payload behind. Acceptable for v0.1 but the manifest should advertise it so Layer 1 doesn't treat previews as missing fields.

4. **Filesystem scope is unstated.** Claude Code / Codex both honor env overrides (`CLAUDE_CODE_PROJECTS_DIR`, `CODEX_SESSIONS_DIR`) but any new stream touching `~/.claude/skills`, per-repo `CLAUDE.md`, or `~/.codex/rules` requires a manifest-level declaration of filesystem footprint so reviewers can audit reach.

5. **Registry parity is the payoff.** If the three manifests add customizations + authored memory, they converge on the same mental model — *runtime transcripts + user-authored customization + user-curated memory* — which is worth more than any single field.
