# A denominator moved and its proof stayed behind

**Status:** root-caused on the live instance, fix in progress. Written 2026-08-19.

## What happened

Gmail's `messages` stream sat at `retryable_gap`, blocking the connection. It
had derived `complete` for months — 451 considered, 451 covered, continuation
451/451.

Commit `4161f5d7b` (2026-08-17, mine) fixed a real undercount: the `messages`
DETAIL_COVERAGE denominator reported only the historical backfill pass, while
both the forward pass and the backfill emit `messages` records through the same
shared `emitRecord`. Every scheduled run with new mail arriving alongside a
pending backfill undercounted. The fix summed both passes.

Fifteen lines below sits `emitHistoricalContinuationSkip`, which reports the
same two numbers as proof that the page it describes was fully accounted for.
That call was left on historical-only.

`isHealthyBoundedContinuation` requires `continuation.considered ===
fact.considered` and `continuation.covered === fact.covered`. After the fix they
differ by exactly the forward-pass count — 52/52 against 51/51 — on every run.
The identity check fails, `classifyContinuationCoverage` returns null, and the
stream falls through to `retryable_gap`.

The first fix was correct. It just moved one of a pair.

## Why the test suite did not catch it

The commit added a test. That test asserted the new summed denominator was
right. It did not assert the continuation still agreed with it.

The invariant that broke was never a property of either emission alone — it is a
property of the *relationship* between them. A test per emission cannot see it.

## Why `threads` never broke

The sibling `threads` stream does the same two emissions and has never
desynced, because it computes its counts once and feeds one variable to both.
There is no second expression to forget to update.

That is the fix for `messages`: one local, both emissions read it. Not because
duplication is untidy, but because two copies of an addition are two things that
can disagree, and this one silently did for two days.

## The rule

**When a fact and its proof are emitted separately, they must read from the
same value, not from two expressions that happen to agree today.** The contract
says "bound to complete same-page facts" — if the definition of the page
changes, every emission describing that page has to change with it. A shared
local makes that automatic; adjacency does not.

The regression test that belongs here is not "is the denominator right" but "do
the fact and the continuation report identical numbers when both passes
contribute" — an equality between two emitted messages, which fails against the
current code and passes after.

## Blast radius

`emitHistoricalContinuationSkip` has exactly two call sites, both in Gmail
(`threads`, `messages`). No other connector uses it. The regressing commit
lives only on `deploy/prod-plus-fixes-0817` and never reached `main`, so no
self-hoster saw it — it shipped to this instance and is being fixed before it
goes further.

## Related

`list-page-loses-unfillable-proof-2026-08-19.md` — the other Gmail blocker,
independent of this one.
`failure-diagnosability-2026-08-18.md` — variant two: a failure nothing reports.
This is a near miss of that shape; the stream reported `retryable_gap` honestly,
but nothing pointed at the desync that caused it.
