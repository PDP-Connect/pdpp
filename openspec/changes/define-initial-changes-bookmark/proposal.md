## Why

Assistant clients need a documented way to start incremental sync without constructing the reference implementation's internal version-0 cursor.

The current docs also confuse list pagination cursors with changes bookmarks by telling clients to use `next_cursor` as `changes_since`.

## What Changes

- Accept `changes_since=beginning` as the public initial bookmark sentinel.
- Return the normal changes response shape for the sentinel, including `next_changes_since`.
- Keep raw timestamp values unsupported unless a separate change defines timestamp semantics.
- Correct docs so clients use `next_cursor` only for page continuation and `next_changes_since` for future `changes_since` queries.

## Capabilities

Modified:

- `reference-implementation-architecture`

## Impact

- Public record-list query contract changes for `GET /v1/streams/{stream}/records`.
- Reference server parser and tests change.
- Public docs change.
