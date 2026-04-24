## Context

Semantic retrieval already tracks active backfill jobs and exposes progress in
deployment diagnostics. Lexical retrieval has equivalent startup drift-rebuild
work, but currently only logs per-stream rebuild messages such as:

```text
[PDPP] Lexical index drift ... — rebuilding
```

This leaves operators without browser-visible progress during large Docker or
local restarts.

## Decisions

### 1. Track lexical progress in memory

Lexical rebuild progress is operational status, not durable protocol state. Add
module-scoped active job tracking to `server/search.js`, parallel to semantic
backfill tracking. The job reports current connector, stream, phase, checked
stream count, scanned records, total records, and written FTS rows.

### 2. Expose through deployment diagnostics only

`/_ref/deployment` is already the reference-only operator diagnostics surface.
Add a `lexical.index.backfill_progress` field there, rather than adding PDPP
metadata or changing `/v1/search`.

### 3. Render beside semantic progress

The dashboard deployment page should show lexical progress with the same visual
treatment as semantic progress, while keeping labels precise: lexical writes
FTS rows, semantic indexes vectors.

## Non-Goals

- Do not add a public lexical progress endpoint.
- Do not persist lexical progress across restarts.
- Do not change lexical retrieval result semantics.

## Acceptance Checks

- A unit test proves lexical progress appears in deployment diagnostics and
  emits a warning while active.
- The deployment dashboard renders lexical progress.
- Existing semantic diagnostics continue to pass.
