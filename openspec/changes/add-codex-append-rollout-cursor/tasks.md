# Tasks: Codex append-safe rollout cursor

## 1. Cursor shape + decode/encode

- [x] 1.1 Add a `RolloutFileCursor` type (`mtime_ms`, `size_bytes`, `offset_bytes`,
      `line_count`, `head_sha256`, `guard_bytes`, `session_id`, `message_count`,
      `function_call_count`, `first_ts`, `last_ts`) to `types.ts`.
- [x] 1.2 Add a tolerant decoder `readPriorFileCursors(startMsg)` that reads
      `state.messages.file_cursors` / `state.function_calls.file_cursors` /
      `state.sessions.file_cursors`, dropping malformed entries — mirroring the
      `file_mtimes` legacy lookup and `readPriorThreadFingerprints` tolerance.

## 2. Byte-offset-aware suffix reader + prefix guard

- [x] 2.1 Add `hashFilePrefix(path, guardBytes)` (SHA-256 over the first
      `guardBytes`, bounded). (No separate `computeGuardBytes` helper — the guard
      length is computed inline as `min(committedOffset, GUARD_PREFIX_BYTES)`.)
- [x] 2.2 Add `iterJsonlLinesFromOffset(path, startOffset)`: streams a file from a
      start byte offset, yields each newline-terminated JSON object plus the
      committed byte offset at its terminator, never commits a trailing partial
      line, and tracks offsets over raw bytes (not decoded chars). The full-parse
      path reuses it with `startOffset = 0`.

## 3. Per-file decision in the scan

- [x] 3.1 Add pure `decideRolloutAction` (skip / full / append / unsafe_full) and
      wire it into `processRolloutEntry`, using the rich cursor when present and
      falling back to the legacy `file_mtimes` fast path (gated on `!cursor`).
- [x] 3.2 On append, seed `RolloutParseState` from the prior file cursor
      (`lineCount`, `sessionId`, counts, ts-range) so suffix record keys continue the
      sequence and aggregate counts become prior+delta.
- [x] 3.3 Write the advanced/fresh `RolloutFileCursor` into a `newFileCursors` map
      and keep the legacy `newMtimes` populated for backward compatibility.

## 4. State emission

- [x] 4.1 In `emitStateCursors`, emit `file_cursors` alongside `file_mtimes` on the
      `messages`/`function_calls` rollout STATE cursor. No change to `sessions` STATE.
- [x] 4.2 Summarize the new `file_cursors` map by COUNT only in the local-collector
      CLI summary (`summarizeCursor`) — never its keys (paths) or values
      (offsets/hashes) — preserving the existing no-path-leak property.

## 5. Tests

- [x] 5.1 First run full-parses and writes a rich cursor (offset, line_count, counts,
      guard) for a small synthetic rollout file.
- [x] 5.2 Unchanged file (same size+mtime) emits zero `messages`/`function_calls`
      records and carries the cursor forward.
- [x] 5.3 Append-only run on a long-lived file under `2026/04/15/` emits ONLY the
      appended records with non-colliding keys, and does not re-emit the prefix.
- [x] 5.4 Truncation/replacement (shrunk file or changed prefix) full-reparses from
      offset 0 rather than skipping. (Two tests: shrink + same-grow-but-changed-prefix.)
- [x] 5.5 Session `message_count` / `function_call_count` equal prior+delta after the
      append-only parse (count correctness).
- [x] 5.6 Legacy `file_mtimes`-only cursor whose mtime changed reparses once and then
      writes a rich cursor that enables tailing on the next append.
- [x] 5.7 Decision-table unit tests for `decideRolloutAction` (all branches) +
      `readPriorFileCursors` tolerance.
- [x] 5.8 Regression: a deferred (active-write) NEW file is not silently skipped on
      the next quiet run. (Caught a real bug introduced mid-implementation — the
      defer branch must not stamp a `newMtimes` entry for an unparsed file, or the
      legacy fast path skips it forever. Verified the test fails against the buggy
      version and passes against the fix.)
- [x] 5.9 Local-collector CLI summary redacts `file_cursors` paths/hashes/session_id
      (count only).
- [x] 5.10 Active-append safety: cursor records `size_bytes == offset_bytes` (re-stat
      mtime after parse), proven by a partial-trailing-line fixture where raw size >
      committed offset (test fails against the naive raw-size version).

## 6. Legacy migration / operator recovery

- [x] 6.1 Prove the one-time legacy reparse is harmless: server ingest no-ops
      byte/semantically-identical re-emits (`records.js:311`,
      `postgres-records.js:765/776`) → zero new versions, recovers the never-emitted
      tail. A "prime cursor without emit" mode is rejected (would skip the unemitted
      tail; legacy state has no recoverable boundary).
- [x] 6.2 Operator recovery packet `docs/operator/codex-append-cursor-recovery-packet.md`:
      why the replay is unavoidable + harmless, safe handling of the pre-fix outbox
      backlog (drain > delete; dead letters escalate), exact pre-restart commands, and
      acceptance criteria distinguishing safe-drain / safe-delete / needs-manual-review.

## Acceptance checks

```sh
cd packages/polyfill-connectors
node --test --import tsx connectors/codex/integration.test.ts connectors/codex/parsers.test.ts connectors/codex/source-preflight.test.ts
pnpm --filter @pdpp/polyfill-connectors run verify   # typecheck + biome
openspec validate add-codex-append-rollout-cursor --strict
```
