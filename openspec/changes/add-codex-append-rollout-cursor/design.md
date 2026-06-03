# Design: Codex append-safe rollout cursor

## Problem restated

Codex rollout files are append-only JSONL keyed by session start date. A session
that lives for weeks stays in one dated file that grows to gigabytes. The current
cursor is `state.<stream>.file_mtimes: Record<path, mtimeMs>`; a file is skipped
iff its mtime equals the stored value, otherwise it is parsed in full. Because any
append bumps mtime, the connector replays the whole file on every append. The
physical source is cursorable by offset; the fix is to track a committed byte
boundary per file and tail the suffix.

## Cursor shape

The rollout STATE cursor (emitted under the `messages` stream, or `function_calls`
when only that is requested) keeps `file_mtimes` for backward compatibility and
adds a sibling `file_cursors` map:

```
file_cursors: {
  "<abs path>": {
    mtime_ms:            number,        // fast unchanged-detection
    size_bytes:          number,        // fast unchanged-detection + grow/shrink
    offset_bytes:        number,        // end of last fully-parsed line (commit boundary)
    line_count:          number,        // parser lineCount at the boundary
    head_sha256:         string,        // integrity guard over the file prefix
    guard_bytes:         number,        // #bytes covered by head_sha256
    session_id:          string | null, // session id seen up to the boundary
    message_count:       number,        // cumulative messages parsed up to the boundary
    function_call_count: number,        // cumulative function calls up to the boundary
    first_ts:            string | null, // earliest source ts up to the boundary
    last_ts:             string | null  // latest source ts up to the boundary
  }
}
```

`offset_bytes` is always a byte offset that ends exactly on a newline — never the
middle of a partial line. The suffix reader returns the boundary it actually
committed (the last `\n` it consumed); a trailing partial line (active write) is
left uncommitted and re-read next run. The quiet-period guard already defers files
modified inside the quiet window, so an actively-written file is normally deferred
before we ever tail it; the newline-only commit boundary is the second line of
defense if a write lands during the scan.

### Integrity guard

`head_sha256` is the SHA-256 of the first `guard_bytes = min(offset_bytes,
GUARD_PREFIX_BYTES)` bytes of the file (GUARD_PREFIX_BYTES = 64 KiB). Before
tailing we recompute the guard over the same prefix length and compare. A rollout
file is append-only by construction; if the first 64 KiB changed, the file was
rewritten/rotated/replaced, so the stored offset is meaningless and we full-reparse.
Hashing 64 KiB is O(1) per tracked file and bounded regardless of file size.

## Per-file decision (processRolloutEntry)

For each rollout path with `stat` giving `{mtime, size}`:

1. **No rich cursor, legacy mtime matches** → unchanged, skip (legacy fast path).
2. **Rich cursor present and `size == cursor.size_bytes && mtime == cursor.mtime_ms`**
   → unchanged, skip; carry the cursor forward verbatim.
3. **Rich cursor present, `size > cursor.size_bytes`, prefix guard matches** →
   APPEND: tail from `cursor.offset_bytes`, seeding the parser's `lineCount`,
   `session_id`, counts, and ts-range from the cursor; emit only suffix records;
   write an advanced rich cursor.
4. **Rich cursor present but `size < cursor.size_bytes`, or prefix guard mismatch,
   or `offset_bytes` past EOF** → UNSAFE (truncated/replaced/rotated): full reparse
   from offset 0; write a fresh rich cursor.
5. **No cursor at all (new file), or legacy-mtime-only entry whose mtime changed**
   → FULL parse from offset 0; write a fresh rich cursor. (The one-time post-upgrade
   reparse of a changed legacy file.)

The active-rollout quiet-period defer is checked before any parse, unchanged.

## Count correctness across a delta parse

`messages` and `function_calls` records are keyed `${sessionId}:${lineCount}`
(+`:output` for orphan outputs), and `function_calls` prefer their own `call_id`.
Tailing must continue the same `lineCount` sequence so appended record keys never
collide with already-emitted keys. The parse state is therefore *seeded* from the
cursor on an append:

- `state.lineCount   = cursor.line_count`
- `state.sessionId   = cursor.session_id`
- `state.messageCount = cursor.message_count`
- `state.functionCallCount = cursor.function_call_count`
- `state.firstTimestamp / lastTimestamp = cursor.first_ts / last_ts`

The suffix has no `session_meta` line, so seeding `session_id` is what lets the
appended response_items attribute to the right session. After the suffix parse the
state's counts are *cumulative* (prior + delta), so the `RolloutAggregate` written
to `rolloutAggregates` already carries the correct full-session counts — the
existing `emitSessionsFromMaps` path then produces a correct `sessions` record with
no extra carry-forward logic. The new rich cursor records the post-suffix
cumulative counts and the new boundary.

This composes with the existing `thread_fingerprints` carry-forward: a session
whose rollout was tailed this run produces a fresh aggregate (so it re-emits with
correct counts); the fingerprint then captures those counts for the next gating run.

## Byte-offset-aware suffix reader

A small async generator reads the file from a start offset via
`createReadStream(path, { start })`, splits on `\n` while tracking the cumulative
byte length of each consumed line (including its terminator), and yields
`{ obj, committedOffset }`. It only advances the committed offset to the end of a
newline-terminated line; a trailing chunk without a final newline is not committed.
Memory stays bounded — one line at a time, never the whole file. The full-parse
path is the same reader started at offset 0.

## Alternatives considered

- **Inode/ctime identity instead of a prefix hash.** Node's `stat` exposes `ino`,
  but it is unreliable across platforms and bind-mounts and does not detect an
  in-place rewrite that keeps the inode. A prefix hash detects content replacement
  directly and is portable.
- **Hash the whole file.** Defeats the purpose — it is O(file size), the exact cost
  we are removing. A bounded prefix hash plus size/mtime is sufficient because the
  source is append-only: legitimate changes only ever extend the file.
- **A separate sidecar offset DB.** Out of scope; the connector already round-trips
  STATE cursors and the local collector persists them. Reusing STATE keeps one
  source of truth and stays within the existing contract.
- **Storing offsets but re-deriving counts from a `sessions` re-read.** The counts
  must be exact and are cheap to carry on the same per-file cursor; re-deriving them
  would require reparsing, which is what we are avoiding.

## Deferral interaction (learned during implementation)

The active-rollout quiet-period defer and the cursor carry-forward interact in a
subtle, data-loss-prone way. The legacy fast path skips a file when
`!cursor && file_mtimes[path] === mtime`. If the defer branch stamps a deferred
NEW file's mtime into the next `file_mtimes` (the natural "carry it forward"
instinct), the next run sees `!cursor && file_mtimes[path] === mtime` and skips
the file **forever** — its records are never emitted (silent loss). The original
mtime-only code avoided this by writing nothing on defer.

Resolution: the defer branch carries a prior RICH cursor forward (to preserve a
real committed offset for a file that already had one) but never writes a fresh
`newMtimes` entry. A deferred new file therefore reappears as a full parse on the
next quiet run. This is pinned by a regression test that fails against the naive
"carry forward on defer" implementation and passes against the fix.

## CLI summary redaction

The local-collector CLI summarizes STATE cursors for `pdpp-local-collector` runs.
`file_cursors` is a map keyed by **private file path** whose values carry byte
offsets and a prefix integrity hash. The summarizer (`summarizeCursor`) reports
only its COUNT (`file_cursors_count`) — never its keys (paths) or values — exactly
as it already did for `file_mtimes`. The cursor key name `"file_cursors"` appears
in the cosmetic `keys` array; the path map itself never reaches the CLI surface.

## Scope / non-scope

In scope: Codex rollout source cursor correctness + count correctness + backward
compatibility + tests. Out of scope: the local collector outbox retention/compaction
(a separate lane — deleting sent rows is disk hygiene, not a cursor fix), other
connectors' cursors, and any record-schema or manifest change.

## Acceptance checks

Run from `packages/polyfill-connectors`:

- `node --test --import tsx connectors/codex/integration.test.ts connectors/codex/parsers.test.ts`
  proving: first run full-parses and writes a rich cursor; an unchanged file emits
  no `messages`/`function_calls` records; an appended file emits only the appended
  records with non-colliding keys; a truncated/replaced file full-reparses rather
  than skipping; and session `message_count`/`function_call_count` equal the full
  prior+delta total after an append-only parse.
- A fixture rollout file under an old date directory (`2026/04/15/`) that receives
  appended lines on a later run, exercised end to end through the decision +
  suffix-reader path.
- `node --test --import tsx` over the existing codex suite stays green (no
  regression to fork-parent gating, cross-stream gating, or sessions dedup).
