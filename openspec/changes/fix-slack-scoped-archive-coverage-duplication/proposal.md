## Why

The Slack connector has 8 recorded production runs and 0 successes. Every
run that folds 2+ scoped archives (`packages/polyfill-connectors/connectors/
slack/index.ts`, `mergeScopedMessageArchivePasses`, ~line 1364) dies with
`reference-implementation/runtime/index.ts:3135`'s `Connector emitted
duplicate DETAIL_COVERAGE for state_stream=messages stream=messages`.
Production touches 3 scoped archives per run.

`mergeScopedMessageArchivePasses`'s `for (const archive of
deps.scopedArchives)` loop calls `runRequestedStreams` once per archive.
Before this change, `runRequestedStreams` itself emitted the messages
self-coverage `DETAIL_COVERAGE` (`state_stream=messages`, `stream=messages`)
and the message-family `DETAIL_COVERAGE` (`state_stream=messages`,
`stream=reactions|message_attachments`, via `declareMessageFamilyCoverage`)
on every call. With N scoped archives this emitted each (state_stream,
stream) pair N times through the same `emit` side-channel. `polyfill-runtime`
already requires a connector emit `DETAIL_COVERAGE` exactly once per run
(see `openspec/specs/polyfill-runtime/spec.md`, "Connectors with a detail
lane SHALL emit DETAIL_COVERAGE once per run") — Slack's scoped-archive fold
violated it.

The summed denominator this emission needs already exists:
`mergeMessagesPassResults` (line ~849) sums `considered` across archives,
and the loop's `merged` accumulator (returned at the end of
`mergeScopedMessageArchivePasses`) carries the correct total. The emission
was simply happening at the wrong call site — inside the per-archive
function, instead of once after the fold completes.

## What Changes

- Remove the messages self-coverage and message-family `DETAIL_COVERAGE`
  emission from inside `runRequestedStreams`.
- Add a single post-fold emission in `collect()`, using
  `messageResult.considered` — the value after `mergeScopedMessageArchivePasses`
  (when it runs) has folded every scoped archive into the base archive's
  total. When no scoped-archive fold happens (the ordinary single-archive
  run), `messageResult` is just the base archive's own result, so the
  emitted value is unchanged from today.
- No change to `mergeMessagesPassResults`, `mergeScopedMessageArchivePasses`'s
  fold loop, or the manifest's `state_stream`/`coverage_strategy` declarations
  for `reactions`/`message_attachments`.

## Capabilities

Modified:
- `polyfill-runtime`

## Impact

- Affects `packages/polyfill-connectors/connectors/slack/index.ts` only.
- Fixes every Slack run that touches 2+ scoped archives (the only shape
  production has ever exercised past the first channel-recovery run) —
  these have never once completed.
- No change to the single-scoped-archive or no-scoped-archive cases: same
  emission count (one), same `considered`/`covered` value as today.
