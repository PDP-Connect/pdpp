## Why

Two related run-lifecycle defects, both discovered from the same live
Gmail/Amazon operational incident window (2026-07-15). A third suspected
defect (cancellation not synchronously releasing served detail gaps) was
investigated and disproved by direct DB evidence — see "Investigated and
ruled out" below — so this change scopes to the two confirmed defects only.

1. **A successful recovery-only run can erase good evidence with unmeasured
   evidence.** Live incident: Amazon run `run_1784155457650`
   (`cin_a8ec003e6d441205d646f178`) emitted 15 `run.detail_gap_recovered`
   events and drained pending detail gaps to zero, but its terminal
   `collection_facts` included fabricated "attempted" entries for
   `orders`/`order_items` with `checkpoint: not_staged`, `considered: null`,
   `covered: null` — streams the run never actually attempted, because
   `recovery_only` runs only drain pending detail gaps and perform no
   forward/list inventory pass against the manifest's full scope.
   `buildCollectionFacts` (`connector-gap-bounding.ts`) writes one fact
   entry per stream in `startScope.streams`, and `buildStartScope` never
   narrows that scope for `recovery_only`. Two independently-correct
   read-time folds then propagate the tainted facts: `connector-summary-
   read-model.ts`'s "newest attempt wins, omitted streams keep prior
   evidence" fold does not omit these streams (they're present, just false),
   and `ref-control.ts`'s classifying-run selection unconditionally shadows
   stored evidence with the newest terminal run's per-stream facts. Neither
   fold is buggy in isolation; the defect is that no durable, explicit
   run-scope/trigger fact exists anywhere (not on the run record, not on the
   terminal spine event, not on `controller_active_runs` /
   `scheduler_run_history`) for either fold to use to recognize "this run's
   presence in a stream's fact entry does not mean the stream was attempted."
   This is connector-neutral: any connector's recovery-only run can produce
   this shape.

   An earlier draft of this fix tried to *preserve inventory values while
   overlaying newer recovery-only facts onto them* — keeping
   checkpoint/considered/covered from the prior run but restamping the
   merged entry's `run_id`/`evidence_as_of` provenance to the recovery-only
   run. Independent audit
   (`recovery-evidence-provenance-audit-0715.md`) found this falsifies
   provenance: a stream would appear freshly proven at the recovery run's
   time even though the preserved values actually came from an older run.
   The corrected design (below) never restamps provenance and never
   conflates "preserving old inventory proof" with "showing current
   recovery progress" — those are two separate evidence channels the fix
   keeps separate.

2. **Gmail historical attachment backfill is bounded by a fixed UID count,
   not a cost budget.** `selectAttachmentBackfillFetchRange` sizes its
   historical window from `PDPP_GMAIL_ATTACHMENT_BACKFILL_WINDOW_UIDS`
   (default 500 UIDs) regardless of the attachments' actual size. Live
   incident: a run selected 256 gaps against the default 500-UID window while
   large attachments streamed at ~5.7 KB/s (see
   `gmail-blob-throughput-rootcause-0715.md`), keeping the run open far
   longer than a byte-cost-aware page would allow, with no adaptive
   shrink/grow. Gmail already has a real pre-download `size_bytes` per
   attachment from `BODYSTRUCTURE` (fetched by `collectMetadata` before any
   body/attachment bytes are transferred), unlike the connector-neutral
   detail-gap page (`detail-gap-paging.js`), which has no per-row size hint
   and therefore needs a learned observed-average estimate. The fix mirrors
   `detail-gap-paging.js`'s byte-budget-clamp and
   trim-to-budget-with-at-least-one-entry pattern, but — because Gmail's
   per-UID cost is knowable up front, not learned — does not need or
   include that module's EWMA cross-page-learning machinery. An earlier
   draft of this fix added an EWMA "observed average that adapts across
   pages" helper anyway; it was dead complexity (the historical backfill
   pass runs at most once per run, so there was no second page for the
   estimate to adapt across) and was removed on owner review, along with a
   correctness bug in candidate-cost mapping (a zero-attachment UID was
   incorrectly charged the unknown-size fallback instead of costing
   nothing) and an ordering hazard (deriving the admitted page via
   `uid <= max` on IMAP-fetch-ordered results, which are not guaranteed
   ascending, could silently admit the entire coarse range).

Neither change touches Gmail-specific knowledge in the generic
runtime/store, and neither adds a wall-clock kill switch — both preserve
the existing "runs stop because they completed a bounded unit of durable
work" model.

## Investigated and ruled out: cancellation gap-reset correctness

The initial incident read (owner-cancel of `run_1784154877668` producing
`run.cancelled` while 256 detail gaps it had served were still `in_progress`
20+ seconds later) looked like `cleanupChildHandles()`'s fire-and-forget
`resetServedInProgressGaps` call racing past terminal acceptance. Direct
`connector_detail_gaps` queries disprove this as the live mechanism:

- The 256 rows served by the cancelled run now show `status = pending`,
  `last_run_id = run_1784154877668` — proving the reset *did* complete and
  land correctly.
- A new run, `run_1784157282254`, auto-started 6 seconds after
  `run.cancelled` and immediately re-served and re-claimed those same 256
  rows (`status = in_progress`, `last_run_id = run_1784157282254` now).

So the apparent "20s residue" was the next scheduled/continuation run
re-serving the same gap ids for legitimate recovery work, not stranded
cleanup from the cancelled run. The existing fire-and-forget reset is not
proven broken by this incident, and no code or test changes are made to
`resetServedInProgressGaps` or `cleanupChildHandles` in this change. What
remains a legitimate open question — addressed as a side-observation, not a
code change, in this pass — is *why* a new run auto-continues within
seconds of an owner-initiated cancel; see "Side observation" below.

## What Changes

1. **Recovery-only evidence preservation (connector-neutral).**
   - Persist an explicit, durable `recovery_only` fact on the run so it is
     visible on the terminal spine event (`buildRunTerminalData`, sourced
     from the already-computed `startRecoveryOnly` local) — a durable,
     inspectable record of run scope, even though no downstream fold keys
     off it directly (see next point).
   - `buildCollectionFacts` (`connector-gap-bounding.ts`) returns `null`
     **unconditionally** when the run is `recovery_only` — not merely for
     streams it deems "untouched". A recovery-only run performs no
     forward/list inventory pass by definition, so it cannot produce a
     trustworthy per-stream inventory fact (`checkpoint`/`considered`/
     `covered`) for ANY stream, including one it served or recovered a
     detail gap for: emitting a record or recovering a gap during gap
     hydration is not a list-pass measurement and proves nothing about that
     stream's inventory state. There is no existing runtime contract
     proving a STATE commit observed during a recovery-only run came from a
     genuine list-pass rather than a detail-recovery cursor, so no
     exception is taken on that basis either.
   - Because the recovery-only run's terminal event therefore carries no
     `collection_facts` block at all, both existing read-time folds require
     **no recovery-only-specific code**: `connector-summary-read-model.ts`'s
     "newest attempt wins, omitted streams keep prior evidence — value AND
     provenance" fold has nothing to fold for a recovery-only event, and
     `ref-control.ts`'s classifying-run selection (`resolveEffectiveStreamFacts`)
     falls through to the stored/prior fact for every stream, with that
     fact's own `run_id`/`evidence_as_of` provenance completely untouched.
     (An earlier draft added recovery-only-aware overlay logic to both
     folds that preserved values while restamping provenance to the
     recovery run — this was found to falsify provenance by independent
     audit and was removed; see "Why" above.)
   - Current gap/recovery state (e.g. a stream's pending-gap count dropping
     to zero after a successful drain) is never re-derived from this
     terminal-fact block. It already has an authoritative, separate source:
     `ref-control.ts`'s `buildCollectionReport` reads live
     `pendingDetailGaps`/`terminalDetailGapsByStream` from the durable
     `connector_detail_gaps` store and folds those current counts into the
     report independently of any terminal fact — this path is unchanged by
     this fix and continues to be the source of truth for current recovery
     progress.
   - New tests: `buildCollectionFacts` returns `null` for a recovery-only
     run under every touched-signal shape (emitted record, recovered gap,
     DETAIL_COVERAGE evidence, staged/committed STATE); the
     connector-summary-read-model fold leaves stored value AND provenance
     completely untouched by a recovery-only event, while a later genuine
     full-scope run still replaces both normally; the collection-report
     projection shows preserved inventory evidence with old provenance
     alongside a live pending-gap count of zero, proving the two evidence
     channels stay separate; plus an Amazon-shaped acceptance test
     reproducing `run_1784155457650`'s exact shape (15 gaps recovered, both
     streams' evidence and provenance survive untouched).

2. **Gmail attachment recovery bounded work-unit paging (Gmail-specific
   policy, reusing generic semantics).**
   - Replace the fixed-UID historical backfill window with a page sized from
     known attachment byte cost, mirroring `detail-gap-paging.js`'s
     byte-budget-clamp and trim-to-budget-with-at-least-one-entry pattern as
     a Gmail-local implementation — no changes to the generic
     `detail-gap-paging.js` module, no Gmail-specific fields added to it,
     and no EWMA/cross-page-learning machinery (Gmail's per-UID cost is
     knowable up front from BODYSTRUCTURE, not learned, and the historical
     backfill pass runs at most once per run so there is no second page to
     adapt across).
   - Probe metadata (envelope + BODYSTRUCTURE, no attachment bytes
     transferred) across the existing coarse UID-range ceiling, sort the
     results ascending by UID (IMAP fetch order is not guaranteed
     ascending), and compute each UID's cost as: 0 for a UID with no
     attachments; otherwise the sum of each attachment's known
     `size_bytes`, substituting a fixed conservative fallback
     (`ATTACHMENT_BACKFILL_UNKNOWN_SIZE_FALLBACK_BYTES`, 256 KiB) per
     attachment whose size is unavailable — never per UID, and never
     dropping unknown-size attachments from the sum.
   - Trim the sorted candidates to a byte budget via a positional prefix
     count (`admittedCount`), then derive the admitted page as
     `probeMetas.slice(0, admittedCount)` — never by comparing UID values —
     so out-of-order probe results cannot silently admit more than the
     budget allows.
   - Byte budget default 1 MiB (min 256 KiB, max 4 MiB, `PDPP_GMAIL_
     ATTACHMENT_BACKFILL_PAGE_BYTES` override), sized against the live
     incident's observed worst-case throughput (~5.7 KB/s,
     `gmail-blob-throughput-rootcause-0715.md`): 1 MiB is ~3 minutes of
     transfer in the worst case, leaving headroom inside the connector's
     ~15-minute run cadence for the rest of the run's work; the 4 MiB max
     stays under one cadence window (~12 min worst-case); the 256 KiB min
     is a usable floor for faster, smaller pages. No wall-clock timer is
     introduced — the budget bounds completed work, not elapsed time.
   - The durable `backfilled_through_uid` cursor still advances only after a
     full page's attachments are fully resolved (success, failure, or
     too-large — same "attempted, not necessarily succeeded" completion
     definition already in place), never mid-page.
   - No new wall-clock kill switch; cancellation/restart continue to replay
     the unfinished page from the last committed cursor.
   - New tests: page boundaries driven by cumulative byte cost rather than a
     fixed UID count; a zero-attachment UID costs nothing and does not
     consume budget; mixed known/unknown attachment sizes charge the
     fallback per unknown attachment, not per UID; a page that would exceed
     the byte budget on its first candidate still admits that one candidate
     (at-least-one-entry rule); an out-of-order candidate list still trims
     correctly by position (pinning that sorting, not a UID filter, is the
     correctness mechanism); existing UID-window replay tests
     (`selectAttachmentBackfillFetchRange`) are retained unchanged as the
     coarse-ceiling contract, since that function itself did not change.

## Side observation (not implemented in this change)

Auto-continuation launching a new run 6 seconds after an owner cancel is
itself unreviewed scheduler/continuation behavior. A smaller, byte-bounded
Gmail attachment page (outcome 2) should shrink how much served, then-
abandoned work a cancel can leave for the very next run to immediately
re-claim, which is a plausible partial mitigation. This change does not
modify scheduler continuation/re-launch policy; that remains open for a
separate, explicitly scoped pass if the owner wants auto-continuation timing
itself changed.

## Impact

- Affected specs: `reference-implementation-runtime` (recovery-only evidence
  fold), `polyfill-runtime` (Gmail attachment backfill paging policy).
- Affected code:
  - `reference-implementation/runtime/index.js` (add `recovery_only` to
    terminal event data only — no cancellation-path changes)
  - `reference-implementation/runtime/connector-gap-bounding.ts`
  - `reference-implementation/server/connector-summary-read-model.ts`
  - `reference-implementation/server/ref-control.ts`
  - `packages/polyfill-connectors/connectors/gmail/index.ts`
- Ordinary (non-recovery-only) collection runs are unaffected; both changes
  are additive constraints on recovery-only fact scoping and Gmail backfill
  paging.
- No protocol/wire-format changes: `recovery_only` already exists on
  `StartMessage`; this only adds it to the terminal event's persisted data
  and to fact-scoping logic. No new Collection Profile messages.
- `resetServedInProgressGaps` and `cleanupChildHandles` are explicitly
  out of scope for this change; verified working via live DB evidence above.
