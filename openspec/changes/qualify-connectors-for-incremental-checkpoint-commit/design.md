## Context

The sibling change `adjudicate-interrupted-runs-by-owner-epoch` settled who
writes an interrupted run's terminal state: the successor, by owner epoch, with
no drain. It deliberately left one question open — whether a staged cursor may
be committed when a run does not reach `succeeded`.

That question cannot be answered by policy, because the runtime has no
information to reason with. `commitState(stream, cursor)` is already a
per-stream idempotent `PUT`, and the plumbing is exercised on every successful
run. Only the *decision* is deferred to DONE, at a single gate:

```
if (persistState && (terminalStatus === "succeeded" || isCertifiedStreamCollectionFailure))
```

`reference-implementation/runtime/index.ts` — located by content, not by line
number, since the research entry's line numbers have since drifted.

So the missing thing is not a policy. It is a vocabulary.

## Goals / Non-Goals

**Goals:**

- A connector can state a checkpoint claim the runtime can check without
  knowing anything about the connector.
- A connector that cannot state a truthful claim is *rejected*, and that
  rejection is the standard working, not a failure of the standard.
- The representation admits coarse-granularity truth, so a connector with a
  coarse cursor is judged on whether it can prove a coarse unit closed, not
  punished for lacking a finer one.
- The representation is storage-free, so the terminal form is additive.

**Non-Goals:**

- Fleet-wide adoption. See the proposal; this is the point, not a concession.
- A storage, compaction, or interval-merge layer.
- Rescuing a connector whose scan is unordered.

## Decisions

### Qualification is the product, not a side effect

A prototype tested a four-field claim contract against `gmail`, `slack`, and
`heb`. Two of the three could not state a truthful claim, and that was first
recorded as the design failing.

That framing is wrong and is corrected here. **A contract that admits every
connector would be worthless.** Its entire job is to separate cursors that can
express a truthful boundary from cursors that cannot. `slack` and `heb` failing
at fine granularity is the qualifier discriminating correctly — it is the
evidence that the standard has teeth, not evidence against it.

The correct reading of the prototype:

| Connector | Fine granularity | Day granularity | Why |
| --- | --- | --- | --- |
| `gmail` | Qualifies | n/a | IMAP UID order, and it already carries `uidvalidity` as an identifier-space epoch |
| `heb` | Fails | **Qualifies, under the closed-day rule** | Cursor is `YYYY-MM-DD`; orders sort by full timestamp, so within-day position is inexpressible |
| `slack` | Fails | Fails | No ordered scan at all; no granularity rescues it |

### The representation is covered intervals; debt is derived

The prototype's contract declared a `complete_through` boundary *and* a
separate `debt` list. Two fields describing one fact can disagree, and nothing
in the protocol would catch it.

This change adopts **covered intervals** instead: the claim carries a set of
intervals over a declared space, and outstanding debt is whatever is *not*
covered. Debt is derived, so the two cannot contradict each other. A
newest-first walk states its truth directly — after page 1 `heb` covers
`[newest_day, newest_day]` and owes everything below, and that is a correct
claim at every instant rather than a promise about the future.

This also subsumes the two-pointer shape without special-casing it. `gmail`'s
`forward_uidnext` plus `backfilled_through_uid`/`target_uid` is exactly two
covered intervals with a gap between them.

No storage layer is specified. An implementation may keep one interval or a
thousand; the representation does not care, which is what makes a later
compaction layer additive.

### A claim carries a granularity, and a coarse claim is still true

The prototype tested claims at the granularity of the provider's sort key. That
is the wrong test for a connector whose cursor is coarser than its sort key,
which is precisely `heb`'s situation.

A day-boundary claim — "every order dated D or later is accounted for" — is
truthful even when within-day ordering is inexpressible, **provided the
connector can prove the day is closed**. Coarsening the granularity does not
weaken the claim's meaning; it widens the unit over which completeness must be
proven, which makes the claim *harder* to earn, not easier.

The claim's granularity is declared, and every interval endpoint is a position
at that granularity. A day-granularity claim covering `[D, D]` asserts that
every item in the whole of day `D` is accounted for. It does not assert
anything about ordering inside `D`, and it does not need to.

### The `heb` day-granularity verdict: qualifies, under a closed-day rule

**Verdict: `heb` `orders` qualifies at day granularity, and only for days
proven closed. The naive day claim is unsafe and is rejected.**

Two independent hazards put holes *inside* a day, and each is answered:

**Hazard 1 — the newest day is open.** `runForwardScan`
(`packages/polyfill-connectors/connectors/heb/index.ts:868-925`) walks list
pages newest-first and tracks `newestOrderDate` as a running max
(`:901-903`). At any instant mid-walk, the newest day seen may be only
partially enumerated: orders from the same day sort by full timestamp and can
straddle a page boundary, so page 1 may hold three of that day's five orders.
Claiming `[newestOrderDate, ...]` from page 1 would claim a day whose remaining
orders have not been seen.

The rule that answers it: **a day may be claimed only once a strictly older day
has been observed.** Seeing an order dated `D-1` proves the newest-first walk
has passed every order dated `D`. This is a property of the walk order, which
`heb` genuinely has (globally reverse-chronological, per `resumeBoundary`'s
own doc comment: "H-E-B's order list is globally reverse-chronological (not
year-partitioned like Amazon)"). The newest day observed is therefore always
excluded from the claim — it is exactly the open unit.

**Hazard 2 — `dateDropped` puts a hole in a day that cannot be located.** This
is the sharper one, and it is why the rule must be a *closed*-day rule rather
than just an *older-day-seen* rule.

`processListOrder` (`:829-854`) parses each order's date. When
`parseOrderDate` returns null — it is a `new Date(raw)` parse of DOM free text
(`connectors/heb/parsers.ts:341-350`) — the order is pushed to
`ordersCoverage.dateDropped` (`:851`) and the function `return`s before
`emitOrderAndItems`. The order is *considered but not covered*, exactly as the
`OrdersCoverage` doc comment states.

The hazard is that **a date-dropped order has no date**. It cannot be
attributed to any day, so it cannot be excluded from a specific day's interval.
It is a hole of unknown position, and any interval claimed on a run that
dropped a date might be the interval containing it.

The rule that answers it: **a claim is emitted only when `dateDropped` is empty
for the run.** A single unparseable date withholds the entire claim for that
run. This is coarse and deliberately so — it fails closed, it needs no
attribution machinery, and the fallback is today's behavior. `heb` runs are
small, so withholding a whole run's claim is cheap.

A third, lesser hazard is worth naming because it bounds the claim rather than
blocking it: `MAX_LIST_PAGES = 50` (`:64`) and the `maxPage` exhaustion at
`:919-921` can end a walk early. This does not threaten the claim, because a
truncated walk simply covers fewer days — the *upper* part of the space is
still proven, and the untraversed remainder is uncovered by construction. This
is the covered-intervals representation earning its place: truncation is
expressible as a smaller covered set, whereas under a single `complete_through`
watermark it would be indistinguishable from completion.

Note that `CHECKPOINT_OVERLAP_DAYS = 60` (`:70`) is **not** part of the safety
argument. It re-scans a 60-day window to catch status transitions on
already-seen orders (`resumeBoundary`, `:1064-1073`). It is a freshness device,
not a completeness device, and treating it as a safety margin would be exactly
the kind of accidental-timing invariant this contract exists to replace.

**Confidence.** High on the source reading: the scan order, the `dateDropped`
path, and the single post-scan `STATE` emission (`:1183-1186`) were each read
directly. Not verified live — `heb` sign-in costs the owner a real OTP, so no
run was triggered. Both rules fail closed, so a misreading withholds a commit
rather than losing data.

### `slack` remains disqualified, and the emitted-watermark fix does not change it

**Verdict: disqualified at every granularity.**

`grep -c "ORDER BY" packages/polyfill-connectors/connectors/slack/index.ts`
returns **0**, reproduced on this branch. Slack's messages pass is one flat
interleaved query over the archive with no ordering, so any mid-run watermark
is a maximum over an arbitrary subset of rows, not the top of a contiguous
prefix. An interval claimed over that input asserts coverage of everything
below the maximum, while rows below it may not have been visited at all. That
is not a weaker claim than `heb`'s — it is a false one, and coarsening the
granularity makes it a more confident falsehood rather than a safer claim. A
day-granularity claim over an unordered scan asserts *more*.

The sibling branch `fix/slack-emitted-watermark-0821` (head `9541a10db`) was
checked rather than assumed. It is a real and valuable fix: it advances the
durable watermarks only for rows actually emitted and accepted, removes the
`COALESCE(t.last_ts, ?)` global-floor inheritance, and parenthesizes an
operator-precedence bug in the same predicate. **It does not add an ordering.**
`grep -c "ORDER BY"` on that branch's `connectors/slack/index.ts` also returns
**0**. The fix makes the watermark honest about *which rows it counted*; it
does not make the scan a prefix. Disqualification stands, and it stands for the
same reason it did before.

This is worth stating plainly because the two defects are easy to conflate: the
emitted-vs-iterated defect was a bug *within* an unclaimable design, and fixing
it does not make the design claimable.

### Rejected representations

- **`complete_through` plus a declared `debt` list.** Two fields for one fact,
  free to disagree. Covered intervals derive debt instead.
- **A `covered`/`considered` ratio.** Measures detail-hydration honesty, not
  position. `github` `starred` reports itself `partial` yet still advances its
  watermark past dropped entries; `jellyfin` `items` writes a cursor nothing
  reads. A ratio both over- and under-approximates cursor safety.
- **A `safe: true` boolean.** Unfalsifiable self-attestation.
- **A connector version or capability flag.** An allowlist with extra steps.
- **A global floor for unseen partitions.** Deliberately inexpressible. A
  partition-scoped claim may move only its own partition, which makes Slack's
  `COALESCE` shape unrepresentable rather than merely discouraged.

## The ideal-compatibility rule

Every later fix on this program obeys three constraints:

1. **No new health logic reading evidence projections.** Health is derived from
   the ledger, not from re-deriving state out of projections.
2. **No new implicit run-state flags.** Run state is explicit and durable, not
   inferred from the presence or absence of a side-channel.
3. **No new cursor shapes violating the claim schema.** A new cursor either
   states a checkpoint claim or stays silent; it does not invent a third
   dialect.

**Placement, and why.** The rule lives here in `design.md` as its normative
home, and is restated as a requirement in this change's `polyfill-runtime`
spec delta so it survives archival into `openspec/specs/`.

It is deliberately **not** added to `openspec/README.md`. That file documents
the OpenSpec process — artifact kinds, lifecycle, validation commands, the
closeout checklist — and is scoped to how changes are written, not to what any
particular change may contain. A program-specific engineering constraint placed
there would be read by every contributor to every unrelated change, which is
how process docs accrete rules nobody applies. There is also no
CONTRIBUTING-adjacent surface in this repository that governs runtime
architecture.

The spec delta is the surface that actually binds. A design.md is advisory and
is archived with its change; a requirement in `openspec/specs/polyfill-runtime/`
is the repository's standing statement of how the runtime behaves, and is what a
later contributor or agent validates against. Putting the rule anywhere that
does not survive `openspec archive` would guarantee it is forgotten by the step
that needs it most, which is Step 3 of this program.

## Corrections to prior statements

### The restart worst case is redo since the last COMMITTED cursor

Earlier statements — including the research entry
`ai/research/pdpp/the-checkpoint-protocol-must-carry-a-proven-boundary-and-an-identifier-space-epoch-...md`
§5 — said the residue of an interruption is that "work done *since* the last
checkpoint is redone."

**That is wrong, and it understates the cost.** Staged cursors are discarded on
interruption, so nothing a run staged mid-flight survives. The correct statement
is that for a `commit_on_success` connector, an interruption redoes work since
the last **committed** cursor — which is the cursor written by the last
*successful* run, effectively the run start.

Verified by content on this branch, since line numbers have drifted:

- `newState` is a plain in-memory `Record<string, unknown>`
  (`reference-implementation/runtime/index.ts:2762`), assigned on each `STATE`
  message (`:4237`).
- `commitState` has exactly two call sites (`:5278`, `:5322`), both inside the
  DONE gate at `:5266`. There is no mid-run commit path.

So a staged cursor has no durable effect until DONE, and an interrupted run
leaves the committed cursor exactly where the previous successful run left it.

This matters to the program's cost-benefit and is corrected because it is
accurate, not because it is convenient: it makes the pain *larger* than
previously stated, which strengthens the case for the ledger. The 465 runs that
ingested 897,916 records and advanced no cursor are the direct measurement of
this, and they are not "since the last checkpoint" losses — they are whole-run
losses.

## Risks / Trade-offs

- [A connector states a claim it cannot honor] -> The runtime does not trust the
  claim alone. It checks the claim against a fact it wrote itself: a claim that
  advances a position with zero durably ingested records for that stream this
  run is staged, not committed. Flink's rule applies — the durable ingest *is*
  the pre-commit.
- [The closed-day rule withholds too often on `heb`] -> It withholds a run's
  claim whenever any date fails to parse. The fallback is today's behavior
  (`commit_on_success`), so the failure mode is a redone run, never a lost
  order. If withholding proves common in practice, the fix is to attribute
  dropped orders to a day, not to weaken the rule.
- [Covered intervals grow unbounded] -> Out of scope by construction. The
  representation is storage-free precisely so a compaction layer can be added
  additively once a real growth pattern is measured rather than guessed.
- [Coarse granularity becomes an escape hatch] -> It is the opposite: a coarser
  unit must be proven complete over a wider range, so it is harder to earn.
  `slack` demonstrates the floor — coarsening does not rescue a scan that has no
  order.
- [The `heb` verdict is wrong because it was not run live] -> Both rules fail
  closed. The cost of a misreading is a withheld commit.

## Migration Plan

Sequenced cheapest-value-first. This change lands only the standard; the
numbered steps below are later tranches.

1. Add the optional `checkpoint_claim` field to the protocol. Inert — no
   connector emits it and no behavior changes.
2. Implement the runtime decision procedure. Still inert for every connector
   that stays silent.
3. Claim it in `gmail` `messages` first: it already carries all the needed
   structure including `uidvalidity`, and it is 203,417 of the lost records.
4. `chatgpt` and `codex` next — together 657,477 records, the largest single
   win in the fleet.
5. `heb` under the closed-day rule, if and only if its interruption pain is
   shown to be real. `heb` p50 run duration is 25.2s, so it may correctly never
   qualify for the *investment* even though it qualifies for the *contract*.

Rollback at any step is deletion of an optional field; a connector that stops
claiming reverts to `commit_on_success` with no data migration.
