# Claude Code + Codex connectors

**Status:** implemented 2026-04-19. Both ingests currently in flight against real data.
**Motivation:** capture the user's *coding-agent session history* as first-class, query-able personal data. These are the richest source of "what have I been working on" for an engineer, and they already live on-disk in a parseable form.

## What each source looks like

### Claude Code (`~/.claude/projects/<encoded-path>/*.jsonl`)

- One jsonl per session, named by session UUID.
- Directory is `projects/` with one subdir per cwd (the slashes are replaced with dashes).
- Lines have `type` ∈ `{user, assistant, attachment, file-history-snapshot, permission-mode, last-prompt}` and UUIDs with `parentUuid` for threading.
- Session metadata (cwd, gitBranch, version, userType, entrypoint) is discovered from any line that carries it.
- User's install had 2.2 GB across 46 project directories at the time of implementation.

### Codex (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`)

- One jsonl per session, named `rollout-<iso-timestamp>-<uuid>.jsonl`, organized by date.
- First line is `{type: "session_meta", payload: {id, cwd, originator, cli_version, model_provider, git: {commit_hash, branch, repository_url}, ...}}`.
- Remaining lines are `{type: "response_item", payload: {type, ...}}` where inner type is one of `message | function_call | function_call_output | reasoning`.
- Reasoning items have `encrypted_content` (opaque); we record their existence via session stats but skip the payload.
- User's install had 751 MB across 191 rollouts.

## Schema decisions

Three streams each, following Claude Code's shape for consistency where possible:

**Claude Code:** `sessions`, `messages`, `attachments`.
**Codex:** `sessions`, `messages`, `function_calls`.

Why not unify under one stream set? Because the semantics diverge:

- Claude Code's `attachments` stream covers permission-mode changes, file-history snapshots, hook outputs. Codex doesn't have these as first-class items — the equivalent is tool calls, which are clearer as their own stream with paired arguments/output.
- Codex's `function_calls` stream pairs `function_call` with `function_call_output` by `call_id`, producing one row per tool invocation. That's a better query surface than a flat attachment log.
- If we ever want a cross-tool normalized view, it belongs in a downstream transformation, not in the connector schema. Keep platform-native.

### Content cap: 5 KB

Originally 20 KB. Dropped because:
- Long tool outputs dominated raw jsonl byte counts, but most are either redundant diffs or large command output that isn't useful at rest.
- 5 KB preserves every prompt I looked at in test data with room to spare.
- Halves DB size projections (~500 MB – 1.5 GB for Claude Code).

Downstream users who want full text can still go to the source files — mtime state lets them seek.

### Incremental sync: file-mtime

No per-record cursor. Each connector remembers `{file_path: mtime}` in state; re-runs skip any file whose mtime is unchanged. Trade-offs:

- ✅ Cheap — no per-line tracking, no need to de-dupe UUIDs.
- ✅ Resilient to file-system tricks (copy, edit, truncate) — any of those change mtime.
- ⚠️ If a file is appended to, we re-parse the whole file (mtime changed). We rely on downstream upsert-by-key to deduplicate. For Claude Code that's cheap because keys are UUIDs. For Codex the key is `session_id + line_index`, which is stable for the existing prefix as long as the session wasn't compacted. Good enough for append-only tools.

## Runtime change: filesystem binding

The reference runtime's `buildAvailableBindings()` originally exposed only `network` + (optionally) `interactive`. File-based connectors require `filesystem: {}`. Added to the default bindings. No capability gate — the sandboxing story is "these connectors run in the user's trust domain because their data was already on the user's disk." This is orthogonal to how network-bound connectors constrain outbound calls; the Collection Profile spec should probably formalize that `filesystem` is an on-device-only binding with no remote analog.

## Configuration tension (cross-reference)

Claude Code grew three env vars in one day (`CLAUDE_CODE_PROJECTS_DIR`, `..._INCLUDE`, `..._EXCLUDE`). This was the trigger for the open question documented in `connector-configuration-open-question.md`. Manifest-declared options would be a better home, but it's a spec-surface decision and shouldn't be unilaterally taken.

## What we did NOT do (yet)

- **Unified "coding-agent" view across Claude Code + Codex.** Deferred; would be a downstream transformation or view, not a connector.
- **Extract tool-use payloads from Claude Code's `tool_use`/`tool_result` blocks into first-class rows.** Current code synthesizes `[tool_use: name]` markers in the content string. Would be a richer schema but requires more rationale per field.
- **Codex memories, prompts, rules, skills directories.** `~/.codex/memories/`, `~/.codex/prompts/`, `~/.codex/rules/`, `~/.codex/skills/` carry first-class data; currently ignored. Follow-up stream candidates.
- **Claude Code `~/.claude/skills/` or `~/.claude/memories/`.** Same — follow-up.
- **Encrypted reasoning decryption.** Codex's reasoning items use a server-held key; we intentionally don't try.

## Verification

After each run completes, query:

```bash
sqlite3 'file:packages/polyfill-connectors/.pdpp-data/polyfill.sqlite?mode=ro' \
  "SELECT connector_id, stream, COUNT(*) FROM records WHERE connector_id LIKE '%claude%' GROUP BY 1,2"

sqlite3 'file:packages/polyfill-connectors/.pdpp-data/codex.sqlite?mode=ro' \
  "SELECT connector_id, stream, COUNT(*) FROM records GROUP BY 1,2"
```
