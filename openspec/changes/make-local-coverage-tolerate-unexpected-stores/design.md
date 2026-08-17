## Context

The coverage snapshot answers one question: did the collector account for
everything the server requires? The previous gate also failed when the collector
accounted for something the server no longer asks about, which is a different
question and not one that bears on completeness.

## Decision: the missing/unexpected asymmetry is the whole change

**Unexpected is not fatal.** A collector reporting a store this build no longer
declares scanned *more* than was asked of it. That cannot weaken a completeness
claim. The parser already excludes unexpected entries from `rows` — it
`continue`s before pushing — so they cannot corrupt the proof either. Their only
effect was to fail the gate.

**Missing stays fatal.** A missing store means the collector did not account for
something the server requires. The snapshot genuinely is not committed, and
saying otherwise would be the dishonesty this codebase is trying to remove.

**Duplicate and malformed stay fatal.** Both indicate a report that cannot be
trusted to mean what it says, which is distinct from a report that means more
than needed.

## Why not fix the device instead

Updating the collector on the affected device resolves this instance and leaves
the class untouched. Any user whose device and server versions ever diverge —
which is every user eventually — hits the same wall, and the failure presents as
"Not measured" with no diagnostic naming the drift. The lenient gate fixes the
class and fixes this instance without touching the device.

## Prior art

restic exits `0` on full success and `3` on "some source files could not be
read" — an incomplete-but-usable snapshot is still created. borg distinguishes
`0` success, `1` warning, `2` error. rclone's `check` reports `--missing-on-dst`,
`--differ` and `--match` as separate named categories. None discards a result
because it is imperfect in one direction; partial coverage is a tagged status on
still-valid data.

## Acceptance

- Every expected store present plus one unexpected store: snapshot commits,
  `unexpectedStores` still reports the drift, the unexpected entry never appears
  in `rows`.
- A missing required store: snapshot does not commit.
- A duplicate store: snapshot does not commit.
- A malformed entry: snapshot does not commit.
