## Context

Claude's current mtime-only JSONL gate reparses an entire transcript after a metadata touch. The binding Sol gate establishes that a byte cursor must verify the entire committed prefix, and that sessions need a complete aggregate snapshot because one session can span changed and unchanged files.

## Goals / Non-Goals

**Goals:**

- Tail complete appended JSONL lines without replaying a verified prefix.
- Detect prefix mutation, truncation, rotation, and unstable scans before emitting advanced STATE.
- Keep sessions and child stream state independent, parent-first, private, and proportional to files plus sessions.
- Preserve existing malformed-line behavior, crash checkpoint ordering, and legacy downgrade compatibility.

**Non-Goals:**

- No HMAC, persistent inode identity, child fingerprint ledger, deletion tombstone, exact-once claim, or runner/outbox/server protocol change.
- No change to Codex's cursor policy or non-JSONL Claude streams.

## Decisions

### One physical cursor primitive

`local-jsonl-cursor.ts` owns file handles, byte boundaries, SHA-256, and stability checks. Connector callbacks receive only LF-terminated lines, so JSON parsing and record policy remain local to Claude. This is a deep module: callers supply a path, prior physical state, and line callback; they do not reimplement filesystem race handling.

### Full committed-prefix SHA-256

When metadata differs, the primitive hashes all bytes before the committed offset. A changed digest or shrink rebuilds from zero. A 64 KiB head guard cannot detect a mutation beyond its window. SHA-256 is change detection, not authentication; coupling it to a device token via HMAC would make token rotation a source rewrite.

### Stable-open-file contract

The scanner snapshots one open handle, reads only through that fixed size, then verifies handle/path compatibility and no non-append metadata mutation. It accepts post-scan growth as a later-tail boundary. It cannot detect an unusual writer that preserves both size and mtime between scans; the fast path expressly relies on that filesystem contract.

### One aggregate snapshot, conservative rebuild

Sessions seed their map from persisted `session_aggregates`; safe tails fold only new lines with each file's saved observations. Any unsafe file, missing aggregate snapshot, or removed tracked file discards the staged map and folds the current inventory from zero. Child rebuilds replay current rows once and rely on stable logical keys plus existing server no-op handling, not a per-record ledger.

## Risks / Trade-offs

- [Changed metadata requires prefix hashing] → deliberate O(committed-prefix) I/O is the price of arbitrary-prefix mutation detection without a chunk index.
- [Source changes during a scan] → reject the scan and withhold STATE; runner checkpoint ordering replays safely.
- [Legacy state has no safe offset] → baseline matching-mtime migration builds rich state without records; changed-mtime migration makes one conservative replay.

## Migration Plan

Read v1 rich state first and keep writing `file_mtimes` alongside it for one public release. A downgrade is correct but may return to full replay after a changed mtime. Remove the legacy field only in a separately evidenced cleanup change.

## Open Questions

None for this approved scope. Live queue/database/deployment validation is intentionally excluded.
