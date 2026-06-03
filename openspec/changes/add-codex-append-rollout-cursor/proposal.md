## Why

The Codex connector gates rollout parsing by whole-file `mtimeMs`: a rollout
file whose mtime matches the prior run is skipped, any other file is reparsed
in full. Codex stores a session's rollout under the session's start date and
keeps appending to it for the life of the session. A long-lived session started
in April and still active in June lives in one `2026/04/15/rollout-*.jsonl` file
that grows without bound — observed live at ~1.3 GB, 517,933 lines, ~78k message
payloads and ~99k function-call payloads.

Every append bumps that file's mtime, so the connector reparses the entire 1+ GB
file and re-emits every record it has ever seen. One live collector invocation
queued `records_queued=177387` from a single changed file across four prior
successful checkpoints. This is deterministic replay of months-old source lines:
the dashboard cannot show such a connection as healthy when each timer run
enqueues far more work than it drains, and the local outbox grows unbounded.

The cursor must be cursorable by file identity + offset + integrity, not by
whole-file mtime. Source timestamps are record semantics, not a physical cursor;
the physical source is an append-only JSONL file.

## What Changes

- The Codex connector SHALL maintain a per-rollout-file cursor rich enough to
  tail an append-only file safely: at least `mtime_ms`, `size_bytes`, a committed
  byte offset at the end of the last fully-parsed line, the parser's `line_count`
  at that boundary, the session id and its derived message/function-call counts at
  that boundary, and an integrity guard over the file prefix sufficient to detect
  truncation or replacement before tailing.
- When a tracked rollout file has grown and its prefix integrity guard still
  matches, the connector SHALL parse only the appended byte suffix and emit only
  the newly appended records, continuing the parser line counter from the prior
  boundary so appended record keys do not collide with already-emitted keys.
- An unchanged rollout file (same size and mtime) SHALL remain skipped. A new
  rollout file SHALL be parsed in full. A truncated, shrunk, replaced, or
  integrity-broken file SHALL fall back to a full reparse from offset zero rather
  than silently skip or tail from a stale offset.
- The cursor SHALL remain backward-compatible with the legacy `file_mtimes`
  cursor shape. A file present only in legacy mtime state whose mtime changed MAY
  take one full reparse on first upgrade; the run SHALL then write the rich cursor
  so subsequent appends tail.
- Session `message_count` / `function_call_count` SHALL stay correct after an
  append-only delta parse: the delta counts from the tailed suffix SHALL be added
  to the prior counts carried on the file cursor, never overwrite them with a
  suffix-only count.
- Memory SHALL stay bounded: the connector SHALL stream the file from the commit
  offset and SHALL NOT load a large rollout file into memory to tail it. The
  existing active-rollout quiet-period guard SHALL continue to defer files written
  inside the quiet window so partial in-flight lines are never committed.

## Capabilities

### New Capabilities

### Modified Capabilities

- `local-agent-collector-completeness`: Codex rollout collection SHALL use an
  append-safe per-file source cursor (identity + committed offset + integrity
  guard) so appending to a long-lived rollout file emits only the appended
  records, and SHALL preserve session count correctness across delta parses,
  while staying backward-compatible with the legacy whole-file mtime cursor.

### Removed Capabilities

## Impact

- Affected runtime: `packages/polyfill-connectors/connectors/codex/index.ts`
  (per-file cursor decode/encode, append-vs-full decision in `processRolloutEntry`,
  byte-offset-aware suffix reader, line-counter + count carry-forward through
  `parseRolloutFile`, STATE cursor shape under the `messages`/`function_calls`
  stream) and `packages/polyfill-connectors/connectors/codex/parsers.ts` /
  `types.ts` (cursor shape + decode helpers).
- No connector manifest or record-schema change: `messages`, `function_calls`,
  and `sessions` record shapes and ids are unchanged; only the STATE cursor shape
  for the rollout streams gains per-file offset/integrity fields alongside the
  retained `file_mtimes` legacy key.
- Backward-compatible cursor: a collector upgrading from the legacy `file_mtimes`
  cursor reparses a changed long-lived file at most once, then tails.
- Affected tests: `packages/polyfill-connectors/connectors/codex/integration.test.ts`
  and `parsers.test.ts` gain focused coverage for first-run full parse + rich
  cursor write, unchanged-file skip, append-only suffix emit, truncation/replacement
  full-reparse fallback, and post-append session count correctness, including a
  long-lived rollout file under an old date directory that receives appended lines
  on a later run.
