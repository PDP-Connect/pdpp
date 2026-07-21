## Why

Claude Code transcript collection treats any JSONL mtime change as a full-file replay. An mtime-only touch therefore creates avoidable transcript batches, while a changed-file-only session fold can omit unchanged contributors to the same session.

## What Changes

- Add a shared physical local-JSONL cursor with an LF-boundary byte offset, full committed-prefix SHA-256, observed size/mtime, and stable-open-file checks.
- Use independent rich JSONL cursors for Claude sessions and child records.
- Persist one aggregate snapshot per Claude session so a safe tail equals a clean full-source fold; conservatively rebuild all session aggregates after unsafe source changes.
- Read and dual-write legacy `file_mtimes` state during the bounded compatibility period.

## Capabilities

### New Capabilities

- `local-jsonl-incremental-cursor`: Physical, safe incremental traversal of local line-delimited JSON files.

### Modified Capabilities

- `polyfill-runtime`: Claude local transcript collection gains bounded cursor state and source-change recovery behavior without changing the Collection Profile protocol.

## Impact

Affected code is limited to the polyfill-connectors shared source utilities and Claude Code connector. No runner, outbox, server, deployment, credential, or protocol change is included.
