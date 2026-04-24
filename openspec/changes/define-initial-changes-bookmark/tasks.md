## 1. OpenSpec

- [x] Add proposal, design, tasks, and spec delta for the initial changes bookmark contract.
- [x] Validate the change with `openspec validate define-initial-changes-bookmark --type change --strict`.

## 2. Reference Implementation

- [x] Normalize `changes_since=beginning` to the existing beginning-of-history changes query path.
- [x] Preserve rejection for malformed raw timestamp `changes_since` values.
- [x] Preserve distinct `next_cursor` and `next_changes_since` behavior on paginated changes responses.

## 3. Tests

- [x] Add targeted tests for `changes_since=beginning` bootstrap.
- [x] Add targeted tests for sentinel pagination and `next_changes_since`.
- [x] Add targeted tests that raw timestamp values remain rejected.

## 4. Docs

- [x] Update public change-tracking docs to document `changes_since=beginning`.
- [x] Correct any stale docs that say `next_cursor` should be reused as `changes_since`.
- [x] Update generated reference docs/OpenAPI if required by the reference metadata.

## 5. Closeout

- [x] Run targeted reference tests for the records/query contract.
- [x] Re-read touched files and grep affected old patterns before reporting complete.
- [x] Commit the work in the `define-initial-changes-bookmark` worktree.
- [x] Add `.git/workstreams/merge-queue/define-initial-changes-bookmark.md`.
