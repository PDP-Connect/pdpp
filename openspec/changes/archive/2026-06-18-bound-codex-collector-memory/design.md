## Context

The local agent collectors are filesystem-class connectors. They must tolerate
large user-controlled local state without converting source size directly into
process heap growth.

The incident evidence was a 2026-06-17 kernel OOM kill on the owner's machine where
`pdpp-codex-collector` had peaked around 1.4-1.8 GB RSS. Incremental steady
state was about 93 MB, which points at cold/full collection fan-in rather than
the ordinary incremental loop.

Rollout streams already use byte-offset cursors and append-safe scans. The
dangerous cases are enrollment or connector-version upgrade from legacy
`file_mtimes` state, and rotated/truncated/replaced rollout files whose
prefix-integrity guard fails. In both cases parsing starts from offset 0 and must
replay the full file. In that path, unmatched function calls were held in
`pendingCalls` until EOF, so memory could grow with the number of unmatched calls
in the file.

Two additional risks were found:

- Static markdown-like streams read the whole file, parsed frontmatter, and then
  truncated emitted record content.
- Codex session emission loaded every `state_5.sqlite#threads` row with
  `StatementSync.all()` before merging with rollout aggregates.

## Decision

Stream Codex session rows with `StatementSync.iterate()` during runtime session
emission. Do not keep a runtime helper that materializes the full thread table
as a `Map`; tests should exercise the I/O-free merge helpers directly.

Cap retained unmatched function calls during rollout replay. When the window is
full, emit the oldest call without output and keep parsing; a later output still
emits through the existing output-only fallback using the same `call_id`.

Use `readBoundedFilePreview` for static local-source text files before parsing or
record construction. The helper retains only a bounded UTF-8 prefix and already
trims incomplete trailing code points.

Do not add new record fields in this change. The current fix is the
bounded-memory runtime contract; visible truncation metadata would be a separate
record contract change.

Claude Code's session pass remains a parent-first summary aggregation: it holds
one small `SessionAccumulator` per observed session so sessions can emit before
messages and attachments. That is not the same class as retaining raw transcript
content or entire source files, and this change does not replace that
parent-first model.

## Alternatives

- Stream parse frontmatter and content separately. This would preserve more of a
  large file but is unnecessary for current preview-sized records.
- Reject large files. That would make coverage less complete and turn a safe
  local artifact into an avoidable collection failure.
- Page the SQLite query manually. `iterate()` is simpler and keeps only the
  current row materialized.

## Acceptance Checks

- Static local-source collector paths do not import or await
  `fs/promises.readFile`.
- Runtime Codex session emission does not call `StatementSync.all()`.
- Offset-0 rollout replay from legacy `file_mtimes` or prefix-integrity guard
  failure keeps `pendingCalls` bounded even when many calls have no matching
  output before EOF.
- A late output for an already-evicted call is not dropped; it lands through the
  existing output-only fallback, preserving evidence even though the call
  metadata can no longer be merged.
- A local profile of the owner's 1.44 GB Codex rollout file, hardlinked into a scratch
  `CODEX_SESSIONS_DIR` and parsed from offset 0, completes with max RSS well
  below the incident's 1.4-1.8 GB range.
- Existing bounded preview tests continue to pass.
- Connector typecheck and focused tests pass.
