## Context

The reference server already implements grant-relative `changes_since` using opaque changes cursors and separate page cursors for changes pagination. Tests currently bootstrap from an internal base64 JSON token with `{ kind: "changes_since", version: 0 }`, but that token shape is not a public client contract.

## Decision

Define `changes_since=beginning` as the only new initial bookmark flow in this slice.

The sentinel is normalized to the same internal version as the existing beginning-of-history cursor, then uses the existing changes query path. The response remains a changes response:

- `object: "list"`
- `has_more`
- `data`
- optional `next_cursor` only when additional pages remain in the same changes session
- `next_changes_since` as the opaque bookmark for the next incremental sync session

## Rationale

This is the smallest clean contract because it does not add an endpoint, does not expose internal cursor JSON, and does not change normal record-list pagination. It also keeps current privacy behavior: deltas remain grant-relative and field-projection-safe.

`next_cursor` and `next_changes_since` remain intentionally separate. A changes response may include both: `next_cursor` continues the current paginated changes session, while `next_changes_since` is the high-water bookmark for the next session.

## Alternatives Considered

- Document internal version-0 cursor construction: rejected because cursor internals must remain opaque.
- Return `next_changes_since` on normal full-list responses: deferred because it changes the normal list response contract and creates questions about partial full-sync pagination.
- Add `GET /v1/streams/{stream}/changes-cursor`: deferred because the sentinel covers assistant bootstrap without a new route.
- Accept raw timestamps: rejected for this slice because timestamp snapshot semantics, retention behavior, and privacy properties need separate design.

## Scope

In scope:

- `changes_since=beginning` on record-list queries.
- Malformed raw timestamps remain rejected.
- Public docs distinguish page cursors from changes bookmarks.
- Reference tests cover bootstrap, pagination, `next_changes_since`, and timestamp rejection.

Out of scope:

- Range filter declarations.
- Expand behavior changes.
- Schema discovery.
- Blobs.
- Semantic search.
- Dashboard UX.

## Acceptance Checks

- `openspec validate define-initial-changes-bookmark --type change --strict`
- A client can request `GET /v1/streams/{stream}/records?changes_since=beginning` and receive visible current records plus `next_changes_since`.
- A paginated sentinel request returns `next_cursor` for page continuation and `next_changes_since` for the next sync bookmark.
- A raw timestamp in `changes_since` is rejected as `invalid_cursor`.
- Docs no longer instruct clients to pass record-list `next_cursor` as `changes_since`.
