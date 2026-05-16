# Local Agent Stream Contracts (Claude Code + Codex)

Status: design-notes for `complete-local-agent-collectors`. Implementation lives in
`packages/polyfill-connectors/connectors/{claude_code,codex}/`. This file is the
single place that describes contracts, record ids, redaction rules, checkpoints,
and blob behavior for every approved local store on both tools so reviewers do not
have to read every emitter to evaluate completeness.

The shape of each record is enforced at runtime by
`packages/polyfill-connectors/connectors/<tool>/schemas.ts` (zod), and the manifest
declarations live in `packages/polyfill-connectors/manifests/<tool>.json`. This
document explains the *contract intent*; the schemas are the *enforcement*.

## Universal rules

- **Source home** is `CLAUDE_CODE_HOME` (default `~/.claude`) or `CODEX_HOME`
  (default `~/.codex`). Every relative path in the tables below is relative to that
  source home.
- **Classification** is one of `collect`, `collect_redacted`, `inventory_only`,
  `exclude`, `defer`; see `design.md` §"Privacy And Security Classification".
- **Inventory records** never carry payload content. They carry `relative_path`,
  `path_hash` (`sha256("<tool>:<relative_path>")`), `type` (`directory|file|missing|other`),
  `size_bytes`, `mtime_epoch`, and a static `reason` string. They never carry the
  absolute on-disk path, so they are safe to surface in owner-facing UIs.
- **Coverage diagnostics** (`coverage_diagnostics` stream) is the safe per-run
  summary of every known store with status `collected|inventory_only|excluded|deferred|missing|unsupported`.
  No payloads, no raw paths. Emitted only when requested in `START.scope.streams`.
- **Blobs** are not emitted by any inventory or `exclude` stream. The only Claude
  Code stream that emits a payload-bearing attachment is `attachments` with
  `event_type=tool_result_file`, which previews bounded text and records
  `content_bytes`; raw blob storage is out of scope for the inventory streams.
- **Auth-adjacent** files are always classified `exclude` by default. The only
  coverage signal they produce is a coverage_diagnostics record with
  `status=excluded`. They never appear in any payload-carrying or inventory
  stream (see negative tests in `connectors/<tool>/source-preflight.test.ts`).

## Claude Code

Source: `connectors/claude_code/index.ts::CLAUDE_CODE_KNOWN_LOCAL_STORES`.

| Stream                  | Relative path          | Classification     | Record id                                                              | Checkpoint                                                | Blob behavior              |
|-------------------------|------------------------|--------------------|------------------------------------------------------------------------|-----------------------------------------------------------|----------------------------|
| `sessions`              | `projects/`            | collect            | session UUID (from rollout)                                            | implicit via `messages.cursor.file_mtimes`                | n/a                        |
| `messages`              | `projects/**/*.jsonl`  | collect            | line UUID                                                              | `STATE.messages.cursor.file_mtimes` (per jsonl mtime)     | n/a                        |
| `attachments`           | `projects/**`          | collect            | line UUID or `tool_result_file:<projectDir>/<sessionId>/<rel>`         | shares `messages` file-mtime cursor                       | text preview only, bounded |
| `skills`                | `skills/`              | collect            | skill name path                                                        | per-run cursor (no incremental)                           | n/a                        |
| `slash_commands`        | `commands/`            | collect            | commands path                                                          | per-run cursor (no incremental)                           | n/a                        |
| `memory_notes`          | `projects/**/memory/`  | collect            | project-dir + relative note path                                       | per-run cursor                                            | n/a                        |
| `file_history`          | `file-history/`        | inventory_only     | `file_history:<sha256(claude_code:relpath)>`                           | inventory rebuilt every run                               | none                       |
| `context_mode`          | `context-mode`         | inventory_only     | `context_mode:<sha256(...)>`                                           | inventory rebuilt every run                               | none                       |
| `cache_inventory`       | `cache/`               | inventory_only     | `cache:<sha256(...)>`                                                  | inventory rebuilt every run                               | none                       |
| `backup_inventory`      | `backups/`             | inventory_only     | `backups:<sha256(...)>`                                                | inventory rebuilt every run                               | none                       |
| `config_inventory`      | `settings.json`        | inventory_only     | `config:<sha256(...)>`                                                 | inventory rebuilt every run                               | none                       |
| `debug_artifacts`       | `debug/`               | defer              | n/a (no records until redaction is approved)                           | n/a                                                       | none                       |
| `downloads`             | `downloads/`           | defer              | n/a                                                                    | n/a                                                       | none                       |
| (no stream — excluded)  | `auth.json`            | exclude            | n/a                                                                    | n/a                                                       | none                       |
| `coverage_diagnostics`  | n/a (synthetic)        | collect            | `coverage:<store>`                                                     | per-run                                                   | none                       |

### Redaction rules

- `collect` streams above (`sessions`, `messages`, `attachments`, `skills`,
  `slash_commands`, `memory_notes`) pass content through `pdpp-safe-text` bounds
  and `safe-text-preview` so binary content and forbidden control characters are
  flagged at schema check time. Content beyond per-stream length caps is truncated
  and reported via `content_binary_reason` when applicable.
- `inventory_only` streams emit no payload; redaction is therefore a no-op. A
  future move from `inventory_only` to `collect_redacted` requires a redaction
  test added under task 2.2 before the classification is bumped.
- `defer` streams (`debug_artifacts`, `downloads`) currently emit nothing. Moving
  one to `collect_redacted` requires (a) deterministic redaction rules added to
  `src/scrubber.ts`, (b) a redaction test under task 2.2, (c) a privacy review
  recorded in a follow-up openspec change.
- `auth.json` is asserted *never* to emit as a record or blob by
  `connectors/claude_code/source-preflight.test.ts::"claude_code inventory streams emit safe metadata and exclude auth payloads"`.

### Checkpoint behavior

Only `messages` (and by extension `attachments` and `sessions` accumulators)
participates in incremental cursors. The STATE map is stream-keyed; the
emitted cursor is `STATE.messages.cursor.file_mtimes` and the connector reads it
from `state.messages?.file_mtimes` with a fallback to top-level `file_mtimes` for
pre-fix state (`connectors/claude_code/index.ts:1014-1022`).

Inventory streams rebuild on every run by design — the cost is bounded and the
classification can change between releases without leaving stale records.

## Codex

Source: `connectors/codex/index.ts::CODEX_KNOWN_LOCAL_STORES`.

| Stream                  | Relative path        | Classification     | Record id                                                  | Checkpoint                                              | Blob behavior |
|-------------------------|----------------------|--------------------|------------------------------------------------------------|---------------------------------------------------------|---------------|
| `sessions`              | `sessions/` + `state_5.sqlite` | collect    | session id (from state_5.threads or rollout)               | implicit via `messages.cursor.file_mtimes`              | n/a           |
| `messages`              | `sessions/**/*.jsonl` | collect           | `<sessionId>:<lineCount>`                                  | `STATE.messages.cursor.file_mtimes`                     | n/a           |
| `function_calls`        | `sessions/**/*.jsonl` | collect           | `<sessionId>:<lineCount>` or `<sessionId>:<lineCount>:output` | shares `messages` cursor; falls back to `function_calls.cursor.file_mtimes` | n/a           |
| `rules`                 | `rules/`             | collect            | rule path + rule line position                             | per-run cursor                                          | n/a           |
| `prompts`               | `prompts/`           | collect            | prompt path                                                | per-run cursor                                          | n/a           |
| `skills`                | `skills/`            | collect            | skill name path                                            | per-run cursor                                          | n/a           |
| `history`               | `history.jsonl`      | inventory_only     | `history:<sha256(codex:history.jsonl)>`                    | inventory rebuilt every run                             | none          |
| `session_index`         | `session_index.jsonl` | inventory_only    | `session_index:<sha256(...)>`                              | inventory rebuilt every run                             | none          |
| `shell_snapshots`       | `shell-snapshots/`   | inventory_only     | `shell_snapshots:<sha256(...)>`                            | inventory rebuilt every run                             | none          |
| `memories`              | `memories/`          | inventory_only     | `memories:<sha256(...)>`                                   | inventory rebuilt every run                             | none          |
| `context_mode`          | `context-mode`       | inventory_only     | `context_mode:<sha256(...)>`                               | inventory rebuilt every run                             | none          |
| `config_inventory`      | `config.toml`        | inventory_only     | `config:<sha256(...)>`                                     | inventory rebuilt every run                             | none          |
| `cache_inventory`       | `cache/`             | inventory_only     | `cache:<sha256(...)>`                                      | inventory rebuilt every run                             | none          |
| `logs`                  | `logs/`              | defer              | n/a (no records until redaction is approved)               | n/a                                                     | none          |
| (no stream — excluded)  | `auth.json`          | exclude            | n/a                                                        | n/a                                                     | none          |
| `coverage_diagnostics`  | n/a (synthetic)      | collect            | `coverage:<store>`                                         | per-run                                                 | none          |

### Redaction rules

- `collect` streams pass content through `pdpp-safe-text` and the per-stream
  length caps in `connectors/codex/schemas.ts`. Function-call arguments and
  outputs are truncated by `textPreview()` and any unsafe binary content emits
  a `*_binary_reason` field.
- `inventory_only` streams emit no payload.
- `logs` is `defer` until a deterministic redactor exists for Codex's logs
  SQLite tables. See open question in `design.md` §"Open Questions".
- `auth.json` is asserted *never* to emit by
  `connectors/codex/source-preflight.test.ts::"codex inventory streams emit safe metadata and exclude auth payloads"`.

### Checkpoint behavior

Codex's incremental cursor is the rollout-file `file_mtimes` map under
`STATE.messages.cursor` (or `STATE.function_calls.cursor` when `messages` is not
requested). The connector reads it from `state.messages?.file_mtimes`,
`state.function_calls?.file_mtimes`, `state.sessions?.file_mtimes`, then top-level
`state.file_mtimes` for compatibility (`connectors/codex/index.ts::readFileMtimes`).

Inventory streams rebuild every run.

## Out of scope for this design lane

- No `collect_redacted` content streams are turned on by this change. Any move
  from `defer` to `collect_redacted` requires:
  1. Deterministic redaction rules added to `src/scrubber.ts` and covered by
     `scrubber.test.ts`.
  2. A fixture under `fixtures/<tool>/scrubbed/` proving the redacted shape.
  3. Owner-visible operator copy (see `docs/operator/local-collector-runbook.md`
     §"Coverage and excluded stores").
- No blob-bearing streams are added by this change. The only existing
  blob-adjacent payload is Claude `attachments` with `event_type=tool_result_file`,
  which has been live since v0.2.0 and is not affected.
- Multi-device / connector-instance namespacing (tasks 3.x) is intentionally
  *not* designed here; record ids above are connector-local keys, and the
  connector-instance prefix is added at ingest time by the runtime, not by the
  emitter.
