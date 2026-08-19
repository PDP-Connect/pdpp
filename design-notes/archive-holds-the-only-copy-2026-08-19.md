# The archive I nearly deleted holds 820 conversations that no longer exist

**Status:** proven on the live instance 2026-08-19.

## What happened

Three connections on this instance were named "historical archive". The owner
did not recognise them, did not want them, and asked what they were for. I
looked at one — ChatGPT, 65,413 records — and found that every one of the live
connection's 1,100 conversations already existed inside it. My first read was
that the archive was a stale duplicate.

It is the opposite. The live connection is a strict subset. The archive holds
**820 conversations the live account no longer has**: 788 from 2023 and 32 from
2026-06-20.

## How that was settled

The live cursor sat at `2026-06-19T20:30:04.127Z`, byte-identical to the
archive's newest conversation, so the obvious theory was an inherited watermark:
the connector pages by descending `update_time` and stops at the cursor, so
everything older would be unreachable.

I rewound the cursor to 2020-01-01. Two runs later it was back at the original
value with the same 1,100 conversations, which looked like the rewind being
erased by a cursor derived from collected records.

The run evidence says otherwise:

- The run logged `Listing conversations updated after 2020-01-01T00:00:00.000Z`
  — the rewound cursor was read and used.
- `considered=1056, covered=1056, gap_keys=0, checkpoint=committed`.
- `records_emitted=30464` against a steady state of 72. The full re-scan ran.
- Zero truncation or pagination-cap events; the 5,000 cap was never approached
  at 1,056. The walk reached a genuine end of list.
- All 30,464 re-collected records landed as `version=1` no-ops. Nothing new was
  offered because nothing new exists.

So ChatGPT served **1,056 conversations for the whole account**. The cursor
re-derived to the same timestamp because that conversation is simply the newest
one still alive — a coincidence, not a stale carry-forward.

The 32 conversations from 2026-06-20 are the clincher: they are *newer* than the
cursor, so no cursor logic could ever have hidden them. They were created inside
a 96-second window during the archive's own capture, are titled things like
`New chat`, and are gone now. That is deletion, not a fetch boundary.

## What this means

**The data was deleted upstream and PDPP outran it.** That is the entire
premise of the product, demonstrated: a copy taken on 2026-06-20 is now the only
copy of 820 conversations.

It also means the archive must never be deleted, and I came close to
recommending exactly that. The reasoning that nearly did it — "live already has
everything in here, so it is a duplicate" — was measuring `record_key` overlap
in one direction and calling containment redundancy.

## The latent bug this was not

`emitConversationsState` commits `maxUpdateTimeIso(conversationsToSync) ||
priorConversationsCursor` — derived purely from collected records, monotonic
forward, with no representable backfill boundary. An operator rewind survives
exactly one run and is then overwritten.

It was harmless here only because the rewind completed in a single pass. Had the
walk hit the pagination cap mid-backfill, the cap path returns `truncated: true`
and correctly withholds the advance — so the dangerous window is narrower than
it first appears, but it is real. Gmail's two-pointer shape
(`backfill.target_uid` / `backfilled_through_uid` distinct from the forward
watermark) is the model if durable operator rewinds are ever wanted.

Not fixed here: no data is recoverable by fixing it, and the cursor-provenance
work happening in the reference implementation covers the same concern.

## The rule

**Containment is not redundancy.** When one copy contains another, the question
is not "which is the duplicate" but "which direction does the containment run,
and why". A subset relationship between a live source and an archive is
evidence about the *upstream*, not about the archive.

And the corollary that matters for a product whose purpose is outrunning
deletion: **a copy that disagrees with the provider is not necessarily stale.**
It may be the only remaining record of what was there.

## Related

`seeded-cursor-hides-missing-history-2026-08-19.md` — the theory this replaced,
correct in mechanism and wrong in application here.
