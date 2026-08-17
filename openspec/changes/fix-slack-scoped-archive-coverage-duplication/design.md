## Context

`runRequestedStreams` (`packages/polyfill-connectors/connectors/slack/
index.ts:2568`) runs the messages/reactions/message_attachments unified pass
via `runMessagesUnifiedPass`, then declared coverage for all three streams
before this change. It is called from two places:

1. `collect()`'s main flow (~line 2925), once per run, against the base
   archive.
2. `mergeScopedMessageArchivePasses` (~line 1347), inside a `for (const
   archive of deps.scopedArchives)` loop, once per scoped archive that
   `reconcileMessageSourceCache` selected to heal a channel missing from the
   base archive.

Call site 2 only runs when `messageFamilyRequested && isUnscopedMessageBoundary
&& reconciledSourceCache.scopedArchives.length > 0` (collect(), ~line 2932).
Production's base archive drops channels over time (export-scope drift,
workspace membership changes); `reconcileMessageSourceCache` heals each
missing channel from its own existing scoped archive. Production has always
needed 3 scoped archives to heal, so call site 2's loop has always run 3
times per run, each one calling `runRequestedStreams` again on the SAME
shared `emit`.

`runRequestedStreams`, before this change, emitted DETAIL_COVERAGE for
`messages` (self-coverage) and for `reactions`/`message_attachments`
(family coverage, via `declareMessageFamilyCoverage`) unconditionally,
every time it ran the messages/reactions/message_attachments branch. So one
base-archive call (site 1) plus 3 scoped-archive calls (site 2's loop) =
4 emissions of each (state_stream, stream) pair through the same `emit`.
`reference-implementation/runtime/index.ts:3128`'s `trackDetailCoverage`
tracks `(state_stream, stream)` pairs it has already seen this run and
throws `Connector emitted duplicate DETAIL_COVERAGE for
state_stream=${stateStream} stream=${stream}` on any repeat. Every Slack
run touching 2+ scoped archives has hit this and failed; 8/8 recorded runs.

## Decisions

### (a) Move the emission out of `runRequestedStreams`, into `collect()`, after the fold

`runRequestedStreams` returns a `MessagesPassResult` (`{ channelMaxTs,
maxMessageTs, considered }`) whether or not it's the function emitting
coverage. `mergeMessagesPassResults` (line ~849) already sums `considered`
across every result it merges — `merged.considered` (or in `collect()`,
`messageResult.considered` after the merge assignment) is the correct
summed denominator across the base archive plus every scoped archive
folded in this run.

The fix: `runRequestedStreams` no longer emits `messages`/`reactions`/
`message_attachments` DETAIL_COVERAGE at all. `collect()` emits it exactly
once, unconditionally, via a new `declareMergedMessageCoverage(deps,
messageResult.considered)` helper, placed after both:

- the base-archive `runRequestedStreams` call, and
- the conditional `mergeScopedMessageArchivePasses` fold (which reassigns
  `messageResult` to the folded total when it runs).

`declareMergedMessageCoverage` internally no-ops when the message family
wasn't requested this run (mirrors the guard `runRequestedStreams` used to
apply inline), so `collect()` calls it unconditionally rather than adding
an `if` at the call site — this keeps `collect()`'s branch count from
growing (it was already at the connector's biome cognitive-complexity
ceiling).

### (b) Why not gate `runRequestedStreams`'s emission on "am I the last call"

An alternative considered: keep the emission inside `runRequestedStreams`
but only emit when it's the final call in a fold (e.g. thread an `isLast`
flag through the loop). Rejected: it requires the loop's caller
(`mergeScopedMessageArchivePasses`) to know about `runRequestedStreams`'s
internal emission timing, and it does nothing for the fact that the base
archive's call (site 1, outside the loop entirely) ALSO emits — the
base-archive emission and the final scoped-archive emission would still be
two separate emissions of the same pair. The loop and the base call are two
independent call sites; the only place that has ever seen the FINAL summed
`considered` for both is `collect()`, after both have run. Correctness
requires the emission to live where the merge result is observed, not
inside either producer.

### (c) Single-archive path is unchanged

When `reconciledSourceCache.scopedArchives.length === 0` (the common case:
no channel needs healing this run), `mergeScopedMessageArchivePasses` never
runs and `messageResult` is exactly what the base-archive
`runRequestedStreams` call returned — the same value the removed inline
emission used to read. `declareMergedMessageCoverage` still runs exactly
once, with the same `considered`/`covered` value as before this change.
This is the case `slack-collection-report.test.ts` and
`canvases-considered.test.ts`-style unit coverage exercise; the constraint
is that this change is behavior-invisible on that path.

### Acceptance checks

- 0 scoped archives: exactly one messages/reactions/message_attachments
  DETAIL_COVERAGE emission, `considered` equal to the base archive's row
  count — identical to pre-change behavior.
- 1 scoped archive: pre-fix, `runRequestedStreams` ran twice (base + the one
  scoped archive), emitting each pair twice — `reference-implementation/
  runtime/index.ts`'s `trackDetailCoverage` would reject the second
  occurrence. This was never actually observed failing in
  `archive-reclaim.test.ts`'s existing single-scoped-archive coverage
  because that harness (`runConnectorProtocolSubprocess`) spawns the
  connector standalone and never runs it through the RI runtime process
  that owns `trackDetailCoverage` — so a duplicate emission there is
  silently accepted by the test harness, not proof the pair is duplicate
  -safe in production. Post-fix: exactly one emission per pair, `considered`
  equal to base + scoped row count.
- 2+ scoped archives: this is the shape production has always needed (3
  scoped archives every run) and the shape that has never once completed —
  pre-fix, N+1 emissions of each pair (base + N scoped archives), and the
  RI runtime throws on the 2nd. Post-fix: exactly one emission per pair,
  `considered` equal to the summed row count across base + every scoped
  archive folded. `scoped-archive-coverage.test.ts` drives the real
  connector end-to-end (`PDPP_SLACK_SKIP_SLACKDUMP=1`, 2 distinct scoped
  archives, full messages/reactions/message_attachments scope) and asserts
  directly on the emitted DETAIL_COVERAGE sequence — this is the
  regression test for this change.
