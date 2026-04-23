# polyfill-connectors behavior changes — 2026-04-23

**Date landed:** 2026-04-23
**Scope:** `packages/polyfill-connectors/connectors/{gmail,chatgpt,claude_code}/`
**Audience:** downstream consumers of the connector RECORD/STATE protocol.
**Status:** active; already deployed on `main`.

## 1. Parent-first emit ordering (intentional behavior change)

Three connectors have had their inter-stream RECORD emission order
inverted so that parent records land **before** any of their child records.
This was pre-existing inverted behavior in each of these connectors —
**not a refactor drift**; the audit in
[`pre-decomposition-audit-2026-04-23.md`](./pre-decomposition-audit-2026-04-23.md)
confirms each decomposition preserved the prior order exactly. The inversion
to parent-first is a deliberate alignment with the rest of the connector
fleet, not a bug fix.

### Connectors affected

| Connector | Old order | New order | Stream pair |
|---|---|---|---|
| **gmail** | `messages` before `threads` | `threads` before `messages` | threads (parent) + messages (child) |
| **chatgpt** | `messages` before `conversations` | `conversations` before `messages` | conversations (parent) + messages (child) |
| **claude_code** | `messages`/`attachments` streamed during dir scan; `sessions` aggregated after | `sessions` first, then `messages`/`attachments` via a second pass | sessions (parent) + messages + attachments (children) |

### What **did not** change

- **Record shapes.** Every field on every record is unchanged. No new
  fields; no removed fields; no rename.
- **Stream names.** No stream was renamed, added, or removed.
- **SKIP_RESULT reasons and shape.** Reason strings and diagnostic
  payloads are byte-for-byte unchanged.
- **STATE cursor semantics.** STATE still emits after its stream's
  final RECORD; cursor contents unchanged.
- **CLI path.** `tsx connectors/<name>/index.ts` still bootstraps via
  `runConnector`; the only new code on that path is an
  `isMainModule(import.meta.url)` guard that short-circuits when the
  module is imported (not invoked) — invisible to the connector
  process itself.
- **Error handling, retries, INTERACTION flows, auth.** Unchanged.

### Why this matters for downstream

Consumers doing **streaming upserts** can now rely on seeing the parent
record before any of its children. If your ingest layer buffers
messages waiting for a `conversations` / `threads` / `sessions` row to
land, you can drop that buffering for these three connectors as of
this change.

Consumers doing **full-batch upserts** (wait for DONE, then upsert)
are unaffected.

Consumers that **implicitly depended on the old child-before-parent
order** — for example, a flow that used the arrival of a `messages`
record as a signal to start a `conversations` upsert — will now
silently receive the parent first. The records themselves are
identical; only arrival sequence changed. If your ingest is order-
sensitive in that way, test against the new order before deploying.

### How the change was implemented

Documented for consumers who want to audit:

- **gmail** — `runAllMailPasses` now calls `runThreadsPass` (a
  self-contained `1:*` IMAP fetch that aggregates by thread-id) before
  the per-message body pass. No buffering; the two fetches were
  already independent.
- **chatgpt** — `processConversationDetail` calls `emitConversation`
  before the per-node message loop. Aggregate fields in the
  conversation record
  (`message_count_on_current_branch`, `current_node`) come from the
  detail JSON mapping, not from observing individual message emits, so
  the record can be built and emitted before any messages.
- **claude_code** — two-pass structure: `scanProjectDirs` is run first
  with `buildOnly: true` (populates `sessionAccumulators` silently,
  does not emit messages/attachments), then sessions emit via
  `emitSessionsFromAccumulators`, then `scanProjectDirs` runs again
  with `buildOnly: false` to emit messages/attachments. The accumulator
  update short-circuits on pass 2 (`if (buildOnly)
  updateSessionAccumulator(...)`), so the aggregate is not double-counted.

Contract now documented for new-connector authors at
[`authoring-guide.md → Parent-first emit order`](./authoring-guide.md#parent-first-emit-order).

## 2. Shape-validation coverage in integration tests — partial, not full

Item #5 in the A++ follow-up plan made every connector's
`integration.test.ts` validate emitted records through the real
connector's zod schema instead of a hand-rolled mock. Two connectors
(`amazon`, `chatgpt`) had real fixture drift that this surfaced and
fixed: synthetic fixtures were emitting records that would have been
SKIP_RESULT'd in production.

**But coverage is partial, not universal.** Four of the eight
integration-tested connectors do not have a `schemas.ts` / real
`validateRecord`:

| Connector | Has `schemas.ts`? | Integration test validation mode |
|---|---|---|
| amazon | yes | **validating** (through zod) |
| chase | yes | **validating** |
| chatgpt | yes | **validating** |
| usaa | yes | **validating** |
| claude_code | no | pass-through |
| codex | no | pass-through |
| gmail | no | pass-through |
| slack | no | pass-through |

Pass-through mode means emitted records are recorded but not shape-
checked. A drifted fixture in any of those four connectors is still
silent. Flipping each of those integration tests to validating mode is
a one-line change the day its connector ships a `schemas.ts`. Until
then, do **not** treat package-wide shape-validation parity as a
closed property.

## 3. Related but invisible changes

For completeness — these are listed so an auditor scanning commits
doesn't wonder if they're consumer-facing:

- **`collect-helpers.ts` files deleted.** Internal refactor only; the
  helpers they held were folded back into each `index.ts` once the
  `isMainModule` guard made direct-from-test imports safe. Nothing
  exported by name changed.
- **Integration tests migrated to `makeRecordingEmit`** (`src/test-harness.ts`).
  Test-only; no runtime effect.
- **CI workflow landed at `.github/workflows/polyfill-connectors.yml`.**
  Adds verification; does not change connector behavior.
