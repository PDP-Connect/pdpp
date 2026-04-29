## Context

`tmp/workstreams/refactor-operation-mount-inventory-report.md` identified the spine-backed `/_ref` reads as Batch A: highest value, lowest risk. All seven routes are owner-gated read-only surfaces backed by `lib/spine.ts`, which already exposes a stable export shape (`listSpineCorrelations`, `listSpineEventsPage`, `searchSpine`). Existing conformance (`disclosure-spine-conformance-*`) and security tests (`security-auth-surfaces`) already pin the live-bearer redaction guarantee on timeline reads.

## Decision

Create three operation modules under `reference-implementation/operations/`:

- `ref-spine-correlations-list` — drives `/_ref/traces`, `/_ref/grants`, `/_ref/runs`. The operation owns the per-kind summary discriminator (`trace_summary` | `grant_summary` | `run_summary`), the `{object: 'list', data, has_more, next_cursor?}` envelope shape, and the optional `next_cursor` emission rule.
- `ref-spine-events-page` — drives `/_ref/traces/:traceId`, `/_ref/grants/:grantId/timeline`, `/_ref/runs/:runId/timeline`. The operation owns the timeline envelope (`object`, identifying `*_id` key, derived `trace_id`, `event_count`, `data`, pagination fields), the per-event live-bearer redaction (token id strip, `token` / `pending_consent` / `owner_device_auth` `object_id` literal swap, `device_code` / `user_code` / `request_uri` redaction inside `data`), and the empty-page on first cursor `not_found` signal that the host translates to HTTP 404.
- `ref-spine-search` — drives `/_ref/search`. The operation owns the `search_result` envelope and the per-bucket summary mappings.

Each operation SHALL pass the shared boundary gate (no Fastify, Next, SQLite, raw DB, sandbox modules, `server/*` route or auth modules, or `process` / `process.env`). Host adapters keep ownership of:

- owner-session authentication via `ownerAuth.requireOwnerSession`;
- HTTP method/route registration and contract metadata (`{contract: 'refSearch'}`);
- query-string parsing (limit/cursor validation, `InvalidCursorError` → 400);
- response writing and `handleError` translation;
- dependency wiring (the spine read functions are still imported from `lib/spine.ts` at the host layer).

The operations receive narrowly-typed dependencies — `listCorrelations(kind, filters)`, `listEventsPage(kind, id, options)`, `search(query)` — that wrap the existing `lib/spine.ts` exports without exposing better-sqlite3 internals to the operation layer.

## Stop Conditions

Stop and report if:

- mounting a route requires changing `lib/spine.ts` exports, cursor encoding, event ordering, or summarizer behavior;
- an existing route response shape is ambiguous in a way the existing tests do not pin;
- moving redaction into the operation requires loosening any case currently enforced by `security-auth-surfaces.test.js`.

## Acceptance Checks

- New per-operation boundary and behavior tests pass.
- Existing `event-spine.test.js`, `disclosure-spine-conformance-*.test.js`, `security-auth-surfaces.test.js`, and `operations-boundary.test.js` remain green.
- `/_ref/{traces,grants,runs,search}` and the per-id timeline routes preserve their response and error shapes (including 404 on empty first page, 400 + `invalid_cursor` on bad cursors, and the live-bearer redaction guarantee).
- `pnpm --filter pdpp-reference-implementation typecheck` and `check` pass.
- `openspec validate mount-ref-spine-operations --strict` passes; `openspec validate --all --strict` continues to pass.
