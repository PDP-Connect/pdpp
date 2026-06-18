## Why

The Codex local collector can run against large user-controlled local state.
Observed `pdpp-codex-collector` runs peaked around 1.4-1.8 GB RSS and
contributed to a kernel OOM kill on the owner's machine (`journalctl`,
2026-06-17). Incremental steady state was about 93 MB, so the fix targets
full/cold collection paths rather than the normal incremental floor.

The primary hazard is a full reparse from byte offset 0. That occurs during
enrollment or connector-version upgrade when legacy state contains only
whole-file `file_mtimes`, and when a rollout file is rotated, truncated, or
replaced so the prefix-integrity guard fails. Those paths previously allowed
unmatched function-call state to grow with the replayed file.

The fixed path was verified against the owner's 1.44 GB Codex rollout file by
hardlinking that file into a scratch `CODEX_SESSIONS_DIR` and requesting only
`function_calls` from offset 0. The patched connector completed in 6.94s with
301,124 KB maximum RSS while emitting 114,598 function-call records to
`/dev/null`.

Two secondary paths also scaled with source size before record-level bounds
applied: static markdown-like source reads and the Codex session merge path,
which loaded every `state_5.sqlite#threads` row with `.all()` before emitting
sessions.

## What Changes

- Stream Codex `state_5.sqlite#threads` rows during session emission instead of
  materializing the full query result.
- Bound retained unmatched function-call state during full rollout replay.
- Read static local-source files through the existing bounded preview helper.
- Preserve current record shapes and per-record preview limits.
- Add regression guards against reintroducing whole-file static reads or
  unbounded SQLite result materialization.
- Document the remaining aggregate-map boundary: Claude Code still builds a
  small per-session summary map so it can preserve parent-first session records,
  but it does not retain full transcript content in memory.

## Capabilities

Modified:

- `local-agent-collector-completeness`

## Impact

- Affects Codex `sessions` emission from `state_5.sqlite#threads`.
- Affects Claude Code `skills`, `slash_commands`, and `memory_notes` collection.
- Affects Codex `rules`, `prompts`, and `skills` collection.
- Very large static source files may emit records derived from a bounded prefix
  instead of the whole file.
