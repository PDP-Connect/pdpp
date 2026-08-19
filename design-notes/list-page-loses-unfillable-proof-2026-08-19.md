# The list page cannot see a proof the detail page computes

**Status:** diagnosed on the live instance, fix in progress. Written 2026-08-19.

## What the owner sees

Gmail reads **Degraded** on `/sources` with "Latest collection completed with
known coverage gaps." Its attachments stream holds 32 terminal gaps, every one
carrying `"attachment exceeds max size: 29209135 > 26214400 bytes"` — an
observed size and a configured cap, per item, durably recorded.

That is exactly the state `unfillableAccounted` was built to resolve: measured,
and this part is provably impossible. Running
`isStreamFullyUnfillableAccounted` against those 32 live rows returns `true`.

The page still says Degraded.

## Why

There are two paths that build a connection's `collection_report`, and only one
of them computes the proof.

The single-connection path (`ref-control.ts` ~5732) passes a real
`unfillableAccountedByStream` map, built by `getUnfillableAccountedByStream`
from `store.listTerminalGapsForConnector` — the per-gap rows the classifier
needs.

The list page calls `loadPageProductEvidence` (~4067), which reads per-instance
**counts** only, through `countGapsByStatusByStreamForConnectorInstanceIds`. At
~4140 it passes `unfillableAccountedByStream: null`. Downstream that `null`
defaults to an empty map (~3279), and every stream's lookup misses, so
`coverage_unfillable_accounted` is `false` (~3411).

The comment there was honest about the tradeoff: counts alone cannot support a
per-stream verdict, and inventing one from counts would be a false green. That
reasoning is correct. The gap is that the batch path never grew the row-level
read that would let it answer truthfully, so it answers `false` — and `false`
is not "unmeasured", it is a claim.

## The shape of the defect

This is the third variant in `failure-diagnosability-2026-08-18.md`: **the
answer is computed correctly, in a field the page that matters never reads.**
The proof exists, the predicate works, the data is durable. The verdict is
produced on a code path the owner's actual view does not take.

Worth stating because the first two variants are about evidence being destroyed
or never recorded. This one is about evidence being *stranded* — which is harder
to see, because every component tests green in isolation.

## The fix

Give the batch path a batched row read (chunked the way the existing
count-batch read is), group by instance and stream, and run the same predicate.
Two constraints hold:

- **Reuse the classifier.** A second implementation of the proof rule is a
  second thing to keep true.
- **Truncation must not read as proof.** The row read is capped. If the cap
  truncates, the affected instance is unmeasured — `null`, never `true`. Partial
  proof is not proof; that is the same rule
  `isStreamFullyUnfillableAccounted` already enforces within a stream, applied
  one level up.

## Not fixed by this

Gmail has a second, independent blocker: its `messages` stream sits at
`retryable_gap`, and `rollupCollectionReportUnfillableAccounted` refuses the
whole connection when any other required stream is unsettled (~2748). A stream
proof can only ever soften an already-`terminal_gap` connection. Gmail was never
one deploy from green.

USAA also holds a terminal gap, but its reason is `quarantined`
(`export_no_download`, 8 attempts against a threshold of 8) with no size-vs-cap
evidence. It correctly does not qualify — quarantine by attempt threshold is
not proof of impossibility. It is a requeue candidate, and requeuing it needs a
run the owner has to be present for.

## What the fix exposed

Both fixes deployed and both worked, verified live: `attachments` reports
`unfill=True`, and `messages` moved `retryable_gap` → `complete` on the first
run under the new image. Every one of Gmail's five streams is settled, and every
condition `isHealthyConditionSet` checks is `true` or `not_applicable` —
including `SourceCoverageComplete: coverage_complete_unfillable_accounted`.

The pill then read **"Can't collect"** — worse than the Degraded it replaced.

A third layer had never learned the fact. `deriveForwardDisposition`
(`connection-health.ts` ~3105) maps `coverage === "terminal_gap"` to disposition
`terminal` unconditionally, with no knowledge of `unfillableAccounted`. That
disposition emits a maintainer `code_fix` action carrying `terminal: true`, and
worst-wins tone renders it red.

So the health gate said healthy and the pill said broken, off the same evidence.

Worth naming the pattern: `unfillableAccounted` was added at the coverage axis,
and each layer that consumes coverage had to learn it separately — the axis, the
list-page projection, and now the disposition. Fixing one exposed the next. A
new fact introduced mid-stack surfaces exactly as many bugs as there are
consumers that predate it, and they surface one at a time, each masked by the
one above.

## Related

`failure-diagnosability-2026-08-18.md` — the three variants.
`source-state-truth-2026-08-18.md` — why coverage is not exemptable.
`manual-import-coverage-receipt-2026-08-19.md` — the adjacent case this is
deliberately not.
